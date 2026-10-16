import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { citeStore } from './citations'

/** 后端 /api/assist/annotate 返回的批注 */
export interface CiteItem {
  paper_id: string | null
  bibkey: string
  title: string
  verdict: string
  reason?: string
  snippet?: string
  page?: number | null
}
export interface Candidate {
  paper_id: string
  bibkey: string
  title: string
  year?: number | null
  verdict: string
  reason?: string
  snippet?: string
  page?: number | null
}
export type Annotation =
  | { id: string; kind: 'cite_check'; anchor: string; items: CiteItem[] }
  | { id: string; kind: 'missing_citation'; anchor: string; reason: string; candidates: Candidate[] }
  | { id: string; kind: 'rewrite'; anchor: string; revised: string; reason: string }

/** 定位到当前文档后的批注 */
export type PlacedAnnotation = Annotation & {
  key: string // 段落 hash + 批注 id，忽略列表按它记
  paraPos: number
  from: number
  to: number
  /** 句末标点的位置（插入引用时放在它前面） */
  insertAt: number
  /** cite_check：句子里对应的引用节点位置 */
  citePos: { pos: number; verdict: string }[]
  /** 是否需要在页边显示卡片（全部「支持」的引用核查只标记，不出卡片） */
  card: boolean
}

interface Para {
  pos: number
  marked: string // 引用写成 [@bibkey]
  plain: string // 去掉引用
  map: number[] // plain 下标 → 文档位置
  cites: { pos: number; ids: string[]; plainIdx: number }[]
  hash: string
}

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 把文档里的段落序列化，同时记下纯文本每个字符对应的文档位置 */
export function collectParagraphs(editor: Editor): Para[] {
  const papers = citeStore.get().papers
  const out: Para[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    let marked = ''
    let plain = ''
    const map: number[] = []
    const cites: Para['cites'] = []
    node.descendants((child, offset) => {
      const at = pos + 1 + offset
      if (child.isText) {
        const t = child.text ?? ''
        marked += t
        for (let i = 0; i < t.length; i++) map.push(at + i)
        plain += t
      } else if (child.type.name === 'citation') {
        const ids: string[] = child.attrs.ids ?? []
        marked += `[${ids.map((id) => '@' + (papers[id]?.bibkey ?? id)).join('; ')}]`
        cites.push({ pos: at, ids, plainIdx: plain.length })
      } else if (child.type.name === 'hardBreak') {
        marked += '\n'
        plain += '\n'
        map.push(at)
      }
      return false
    })
    const t = plain.trim()
    if (t.length >= 30 && !t.startsWith('写作要点')) out.push({ pos, marked, plain, map, cites, hash: fnv(marked) })
    return false
  })
  return out
}

function place(p: Para, a: Annotation): PlacedAnnotation | null {
  const idx = p.plain.indexOf(a.anchor)
  if (idx < 0 || !a.anchor) return null
  const end = idx + a.anchor.length
  const from = p.map[idx]
  const to = p.map[end - 1] + 1
  const lastChar = p.plain[end - 1]
  const insertAt = /[。．.!?！？；;,，]/.test(lastChar) ? p.map[end - 1] : to
  const citePos: PlacedAnnotation['citePos'] = []
  let card = true
  if (a.kind === 'cite_check') {
    // 句子范围内（含句末标点后紧跟的）引用节点
    const near = p.cites.filter((c) => c.plainIdx >= idx && c.plainIdx <= end + 1)
    for (const it of a.items) {
      const c = near.find((x) => it.paper_id && x.ids.includes(it.paper_id)) ?? near.find((x) => x.ids.some((id) => citeStore.get().papers[id]?.bibkey === it.bibkey))
      if (c) citePos.push({ pos: c.pos, verdict: it.verdict })
    }
    card = a.items.some((it) => it.verdict !== 'supports')
  }
  return { ...a, key: `${p.hash}:${a.id}`, paraPos: p.pos, from, to, insertAt, citePos, card }
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 超出配额等情况忽略 */
  }
}

export interface ReviewState {
  placed: PlacedAnnotation[]
  pending: number
  total: number
  running: boolean
  reviewAll: () => void
  dismiss: (key: string) => void
}

/**
 * 页边批注：编辑停顿后逐段调用 /api/assist/annotate。
 * - 结果按「段落内容 hash」缓存在 localStorage，段落不变就不会重复请求，刷新页面也能立即显示；
 * - 光标所在段落等用户离开后再检查，避免写到一半就被打扰；
 * - 段落一改，它的旧批注立即消失，等再次停顿后重新检查。
 */
export function useMarginReview(editor: Editor | null, docId: string, title: string, enabled: boolean): ReviewState {
  const cacheKey = `aria.review.${docId}`
  const dismissKey = `aria.dismiss.${docId}`
  const [cache, setCache] = useState<Record<string, Annotation[]>>(() => load(cacheKey, {}))
  const [dismissed, setDismissed] = useState<string[]>(() => load(dismissKey, []))
  const [paras, setParas] = useState<Para[]>([])
  const [queue, setQueue] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [total, setTotal] = useState(0)
  const inflight = useRef(new Set<string>())
  const timer = useRef<number | undefined>(undefined)
  const titleRef = useRef(title)
  titleRef.current = title

  // 段落快照：文档变化后稍等再算（打字时不必每个字符都算）
  useEffect(() => {
    if (!editor) return
    let raf = 0
    const refresh = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setParas(collectParagraphs(editor)))
    }
    refresh()
    editor.on('update', refresh)
    const unsub = citeStore.subscribe(refresh)
    return () => {
      editor.off('update', refresh)
      unsub()
      cancelAnimationFrame(raf)
    }
  }, [editor])

  // 停顿后把还没检查过的段落放进队列（跳过光标所在段落）
  const schedule = useCallback(
    (force = false) => {
      if (!editor || (!enabled && !force)) return
      const sel = editor.state.selection.from
      const current = collectParagraphs(editor)
      const todo = current
        .filter((p) => !(p.hash in cache) && !inflight.current.has(p.hash))
        .filter((p) => force || !editor.isFocused || sel < p.pos || sel > p.pos + p.marked.length + 2)
        .map((p) => p.hash)
      if (todo.length) {
        setQueue((q) => [...q, ...todo.filter((h) => !q.includes(h))])
        setTotal((t) => t + todo.length)
      }
    },
    [editor, enabled, cache],
  )

  useEffect(() => {
    if (!editor || !enabled) return
    const kick = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => schedule(false), 2500)
    }
    kick()
    editor.on('update', kick)
    editor.on('selectionUpdate', kick)
    editor.on('blur', kick)
    return () => {
      editor.off('update', kick)
      editor.off('selectionUpdate', kick)
      editor.off('blur', kick)
      window.clearTimeout(timer.current)
    }
  }, [editor, enabled, schedule])

  // 逐个处理队列（同时最多 2 个请求）
  useEffect(() => {
    if (!editor || !queue.length || inflight.current.size >= 2) return
    const hash = queue[0]
    setQueue((q) => q.slice(1))
    const p = collectParagraphs(editor).find((x) => x.hash === hash)
    if (!p) return
    inflight.current.add(hash)
    setRunning(true)
    api
      .annotate(p.marked, titleRef.current)
      .then((r) =>
        setCache((c) => {
          const next = { ...c, [hash]: r.annotations }
          // 只保留当前文档里还存在的段落，防止缓存无限增长
          const live = new Set(collectParagraphs(editor).map((x) => x.hash))
          for (const k of Object.keys(next)) if (!live.has(k) && k !== hash) delete next[k]
          save(cacheKey, next)
          return next
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        inflight.current.delete(hash)
        if (!inflight.current.size) setRunning(false)
        setQueue((q) => [...q]) // 触发下一个
      })
  }, [queue, editor, cacheKey])

  useEffect(() => {
    if (!queue.length && !running) setTotal(0)
  }, [queue.length, running])

  const placed = useMemo(() => {
    const out: PlacedAnnotation[] = []
    for (const p of paras) {
      for (const a of cache[p.hash] ?? []) {
        const pa = place(p, a)
        if (pa && !dismissed.includes(pa.key)) out.push(pa)
      }
    }
    return out.sort((a, b) => a.from - b.from)
  }, [paras, cache, dismissed])

  const dismiss = useCallback(
    (key: string) =>
      setDismissed((d) => {
        const next = [...d, key].slice(-500)
        save(dismissKey, next)
        return next
      }),
    [dismissKey],
  )

  return {
    placed,
    pending: queue.length + inflight.current.size,
    total,
    running,
    reviewAll: () => schedule(true),
    dismiss,
  }
}
