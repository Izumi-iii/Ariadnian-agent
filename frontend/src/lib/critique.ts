/**
 * 审稿 Agent 的前端状态：当前这轮的审稿意见、作者对每条意见的回复（已修改 / 不改 + 理由）。
 * 页边批注（PaperEditor）和 Agent 面板（CritiqueRun）共用这一份，所以放在组件外面。
 */
import type { Editor } from '@tiptap/core'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { collectParagraphs, type PlacedAnnotation } from './review'
import { textBetween } from './editorText'

export type Category = 'logic' | 'evidence' | 'overclaim' | 'structure' | 'clarity'
export const CATEGORY_LABEL: Record<Category, string> = {
  logic: '逻辑',
  evidence: '论据',
  overclaim: '结论过度',
  structure: '结构',
  clarity: '表述',
}

export interface CritiqueIssue {
  id: string
  round: number
  section: string
  /** 正文中的原句；空字符串表示针对整节 */
  anchor: string
  category: Category
  severity: 'major' | 'minor'
  comment: string
  suggestion: string
  candidates: { paper_id: string; bibkey: string; title: string; year?: number | null; snippet?: string; page?: number | null }[]
  /** 第 2 轮起：审稿人对这条意见的复查结果 */
  followup?: { round: number; status: 'resolved' | 'partial' | 'unresolved'; comment: string } | null
}

export interface IssueResponse {
  status: 'fixed' | 'rebut'
  note?: string
}

export interface CritiqueRound {
  round: number
  summary: string
  verdict: 'accept' | 'minor' | 'major'
  scores: Partial<Record<'logic' | 'evidence' | 'structure', number>>
  raised: number
  resolved: number
  open: number
}

export interface CritiqueView {
  threadId: string | null
  round: number
  maxRounds: number
  summary: string
  verdict: string
  scores: CritiqueRound['scores']
  issues: CritiqueIssue[]
  resolved: CritiqueIssue[]
  history: CritiqueRound[]
  /** 审稿结束（不再等待修改） */
  finished: boolean
  responses: Record<string, IssueResponse>
  /** 面板里点了某条意见：页边对应卡片高亮、正文滚动过去 */
  focus: { id: string; nonce: number } | null
}

const EMPTY: CritiqueView = {
  threadId: null, round: 0, maxRounds: 3, summary: '', verdict: '', scores: {}, issues: [], resolved: [], history: [], finished: false, responses: {}, focus: null,
}
let state: CritiqueView = EMPTY
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const respKey = (tid: string) => `aria.critique.${tid}`

function loadResponses(tid: string): Record<string, IssueResponse> {
  try {
    return JSON.parse(localStorage.getItem(respKey(tid)) || '{}')
  } catch {
    return {}
  }
}

export const critiqueStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  /** 载入一轮审稿结果（interrupt 的值或最终结果） */
  load(threadId: string, v: any, finished: boolean) {
    const responses = state.threadId === threadId ? state.responses : loadResponses(threadId)
    // 新一轮里已经没有的意见，回复也不用留着了
    const ids = new Set<string>((v.issues ?? []).map((i: CritiqueIssue) => i.id))
    const kept = Object.fromEntries(Object.entries(responses).filter(([k]) => ids.has(k)))
    state = {
      threadId, round: v.round ?? 0, maxRounds: v.max_rounds ?? 3, summary: v.summary ?? '', verdict: v.verdict ?? '', scores: v.scores ?? {},
      issues: v.issues ?? [], resolved: v.resolved ?? [], history: v.history ?? [], finished, responses: kept, focus: null,
    }
    emit()
  },
  /** 新一轮开始审：旧回复已经发给审稿人，清空 */
  startRound(threadId: string) {
    try {
      localStorage.removeItem(respKey(threadId))
    } catch {
      /* ignore */
    }
    state = { ...state, threadId, responses: {} }
    emit()
  },
  respond(id: string, r: IssueResponse | null) {
    const responses = { ...state.responses }
    if (r) responses[id] = r
    else delete responses[id]
    state = { ...state, responses }
    try {
      if (state.threadId) localStorage.setItem(respKey(state.threadId), JSON.stringify(responses))
    } catch {
      /* ignore */
    }
    emit()
  },
  focus(id: string) {
    state = { ...state, focus: { id, nonce: Date.now() } }
    emit()
  },
  clear() {
    state = EMPTY
    emit()
  },
  /** 作者主动清除了页边意见：之后打开文档不再自动挂回来 */
  dismiss() {
    try {
      if (state.threadId) localStorage.setItem(`aria.critique.cleared.${state.threadId}`, '1')
    } catch {
      /* ignore */
    }
    critiqueStore.clear()
  },
  isDismissed(tid: string): boolean {
    try {
      return localStorage.getItem(`aria.critique.cleared.${tid}`) === '1'
    } catch {
      return false
    }
  },
}

export function useCritique(): CritiqueView {
  return useSyncExternalStore(critiqueStore.subscribe, critiqueStore.get)
}

/** 当前文档按标题切成章节：{title, text}，引用写成 [@bibkey]（发给审稿人） */
export function collectSections(editor: Editor): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = []
  let cur = { title: '', text: '' }
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      if (cur.title || cur.text.trim()) out.push(cur)
      cur = { title: node.textContent.trim(), text: '' }
      return
    }
    const t = textBetween(editor, offset, offset + node.nodeSize).trim()
    if (!t || t.startsWith('写作要点')) return
    cur.text += (cur.text ? '\n\n' : '') + t
  })
  if (cur.title || cur.text.trim()) out.push(cur)
  return out.filter((s) => s.text.trim())
}

/** 忽略空白在段落纯文本里找原句，返回文档位置 */
export function findAnchor(editor: Editor, anchor: string): { from: number; to: number; insertAt: number; paraPos: number } | null {
  const q = anchor.replace(/\s+/g, '')
  if (!q) return null
  for (const p of collectParagraphs(editor, 1)) {
    const idx: number[] = []
    let flat = ''
    for (let i = 0; i < p.plain.length; i++) {
      if (/\s/.test(p.plain[i])) continue
      idx.push(i)
      flat += p.plain[i]
    }
    const k = flat.indexOf(q)
    if (k < 0) continue
    const a = idx[k]
    const b = idx[k + q.length - 1]
    const last = p.plain[b]
    return { from: p.map[a], to: p.map[b] + 1, insertAt: /[。．.!?！？；;,，]/.test(last) ? p.map[b] : p.map[b] + 1, paraPos: p.pos }
  }
  return null
}

/** 整节意见挂在章节标题上 */
export function findHeading(editor: Editor, title: string): { from: number; to: number } | null {
  const want = title.replace(/\s+/g, '')
  if (!want) return null
  let hit: { from: number; to: number } | null = null
  editor.state.doc.forEach((node, offset) => {
    if (!hit && node.type.name === 'heading' && node.textContent.replace(/\s+/g, '') === want) hit = { from: offset + 1, to: offset + node.nodeSize - 1 }
  })
  return hit
}

/** 审稿意见 → 页边批注（找得到原句就挂在原句上，找不到就挂在章节标题上） */
export function useCritiqueNotes(editor: Editor | null): PlacedAnnotation[] {
  const v = useCritique()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!editor) return
    let raf = 0
    const bump = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setTick((t) => t + 1))
    }
    editor.on('update', bump)
    return () => {
      editor.off('update', bump)
      cancelAnimationFrame(raf)
    }
  }, [editor])
  return useMemo(() => {
    if (!editor || editor.isDestroyed || !v.issues.length) return []
    const out: PlacedAnnotation[] = []
    for (const is of v.issues) {
      const hit = is.anchor ? findAnchor(editor, is.anchor) : null
      const h = hit ? null : findHeading(editor, is.section)
      const at = hit ?? (h ? { from: h.from, to: h.to, insertAt: h.to, paraPos: h.from - 1 } : null)
      if (!at) continue
      out.push({ id: is.id, kind: 'reviewer', anchor: is.anchor, issue: is, key: `crit:${is.id}`, ...at, citePos: [], card: true })
    }
    return out
  }, [editor, v.issues, tick]) // eslint-disable-line react-hooks/exhaustive-deps
}
