/**
 * 分节写作 Agent：选择要写的章节 → 逐节确认 / 连续写完 / 子 Agent 并行写 → （可选）总编统稿。
 * 草稿边生成边写进文档对应的标题下（紫色草稿标记 + 闪烁光标），自查后的定稿替换初稿，
 * 总编的每处修改也在文档里逐处呈现；草稿由你在正文里直接修改，最后保留或删除。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, ButtonBase, Checkbox, Chip, CircularProgress, IconButton, InputBase, Switch, Tooltip, Typography } from '@mui/material'
import EditNoteIcon from '@mui/icons-material/EditNote'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline'
import PauseCircleFilledIcon from '@mui/icons-material/PauseCircleFilled'
import ErrorIcon from '@mui/icons-material/Error'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined'
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined'
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import CenterFocusStrongOutlinedIcon from '@mui/icons-material/CenterFocusStrongOutlined'
import { api } from '../lib/api'
import { useAgentStream } from '../lib/agentStream'
import { useApp } from '../lib/appContext'
import type { OutlineSection } from '../lib/types'
import {
  animateEdit, clearLive, draftKey, ensureDraft, findDraft, keepDraft, listDrafts, locateParagraph, removeDraft, scrollToPos,
  sectionHasBody, seedAnnotations, setDraftText, type SectionDraft,
} from '../lib/writer'
import { Card, Thread, ThreadItem } from '../components/Thread'
import { brand } from '../theme'

export interface WriterStart {
  outline: OutlineSection[]
  topic: string
  /** 从哪里来的大纲，只用于显示 */
  from: 'agent' | 'doc'
}

type Status = 'setup' | 'running' | 'waiting' | 'done' | 'stopped' | 'error'
type Mode = 'confirm' | 'auto' | 'parallel'
const PHASES: Record<string, string> = { retrieve: '检索证据', draft: '写作中', token: '写作中', check: '自查引用', fix: '修改引用', annotate: '生成批注' }

interface Edit {
  section: number
  title: string
  para: number
  before: string
  after: string
  reason: string
  applied?: boolean
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string, string][]; onChange: (v: T) => void }) {
  return (
    <Box sx={{ display: 'inline-flex', border: `1px solid ${brand.line}`, borderRadius: '6px', overflow: 'hidden', flexWrap: 'wrap' }}>
      {options.map(([v, l, tip]) => (
        <Tooltip key={v} title={tip}>
          <ButtonBase
            onClick={() => onChange(v)}
            sx={{ px: 1.1, py: 0.4, fontSize: 12, color: value === v ? '#fff' : brand.muted, bgcolor: value === v ? brand.purple : '#fff' }}
          >
            {l}
          </ButtonBase>
        </Tooltip>
      ))}
    </Box>
  )
}

function SectionRow({ i, d, phase, onLocate }: { i: number; d: SectionDraft; phase?: string; onLocate?: () => void }) {
  const icon =
    phase ? <CircularProgress size={12} sx={{ color: brand.purple, m: '1px' }} />
    : d.status === 'accepted' ? <CheckCircleIcon sx={{ fontSize: 14, color: brand.green }} />
    : d.status === 'skipped' || d.status === 'excluded' ? <RemoveCircleOutlineIcon sx={{ fontSize: 14, color: brand.faint }} />
    : d.status === 'error' ? <ErrorIcon sx={{ fontSize: 14, color: brand.red }} />
    : d.status === 'drafted' ? <PauseCircleFilledIcon sx={{ fontSize: 14, color: brand.orange }} />
    : <RadioButtonUncheckedIcon sx={{ fontSize: 14, color: '#cfcfcf' }} />
  const note =
    phase ? PHASES[phase] ?? '…'
    : d.status === 'accepted' ? `已保留${d.issues ? ` · ${d.issues} 条批注` : ''}`
    : d.status === 'skipped' ? '已跳过'
    : d.status === 'excluded' ? '不写'
    : d.status === 'error' ? '失败'
    : d.status === 'drafted' ? `草稿${d.fixed ? ` · 修正 ${d.fixed} 处引用` : ''}`
    : '排队中'
  return (
    <Box
      onClick={onLocate}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.2, cursor: onLocate ? 'pointer' : 'default', borderRadius: '4px', '&:hover': onLocate ? { bgcolor: 'rgba(0,0,0,0.03)' } : {} }}
    >
      <Box sx={{ width: 14, display: 'flex', justifyContent: 'center' }}>{icon}</Box>
      <Typography noWrap sx={{ fontSize: 12.5, flex: 1, color: d.status === 'skipped' || d.status === 'excluded' ? brand.faint : brand.ink }}>
        {/^[\dA-Z一二三四五六七八九十]+[\s.、]/.test(d.title) ? d.title : `${i + 1}. ${d.title}`}
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: phase ? brand.purple : brand.faint, flexShrink: 0 }}>{note}</Typography>
    </Box>
  )
}

/** 逐节确认：草稿已经写在正文里，这里只放操作 */
function ConfirmCard({ value, onSubmit, onLocate }: { value: any; onSubmit: (v: any) => void; onLocate: () => void }) {
  const d: SectionDraft = value.draft
  const [feedback, setFeedback] = useState('')
  const notes = (d.evidence ?? []).filter((e) => e.source === 'note').length
  const keys = new Set((d.evidence ?? []).map((e) => e.bibkey))
  return (
    <Card variant="data" sx={{ p: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 1.25, py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1 }}>
            第 {(value.pos ?? 0) + 1}/{value.total} 节 ·《{d.title}》写好了
          </Typography>
          <Tooltip title="在正文里定位">
            <IconButton onClick={onLocate} sx={{ p: 0.25, color: brand.blue }} aria-label="定位">
              <CenterFocusStrongOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.25, lineHeight: 1.6 }}>
          草稿已写在正文对应标题下（紫色标记），可以直接在正文里改；页边批注是自查的结果。
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
          <Chip size="small" label={`证据 ${d.evidence?.length ?? 0} 条 · ${keys.size} 篇${notes ? ` · 含 ${notes} 条笔记` : ''}`} sx={{ height: 20, fontSize: 11 }} />
          {!!d.fixed && <Chip size="small" label={`已自动修正 ${d.fixed} 处引用`} sx={{ height: 20, fontSize: 11, bgcolor: 'rgba(16,124,16,0.09)', color: brand.green }} />}
          {!!d.issues && (
            <Chip size="small" icon={<FactCheckOutlinedIcon />} label={`${d.issues} 处待你处理`} sx={{ height: 20, fontSize: 11, bgcolor: 'rgba(202,80,16,0.1)', color: brand.orange, '& svg': { fontSize: 13, color: 'inherit' } }} />
          )}
        </Box>
      </Box>
      <Box sx={{ bgcolor: '#fff', borderTop: `1px solid rgba(0,120,212,0.18)`, px: 1.25, py: 1 }}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', border: `1px solid ${brand.line}`, borderRadius: '6px', px: 1, py: 0.25, mb: 1 }}>
          <InputBase fullWidth multiline maxRows={3} placeholder="写下意见重写本节，例如：多讲方法的局限" value={feedback} onChange={(e) => setFeedback(e.target.value)} sx={{ fontSize: 12.5 }} />
          <Button size="small" startIcon={<AutorenewIcon />} onClick={() => onSubmit({ action: 'regenerate', feedback: feedback.trim() })}>
            重写
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button onClick={() => onSubmit({ action: 'stop' })} sx={{ color: brand.muted }}>
            停止
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={() => onSubmit({ action: 'skip' })} sx={{ color: brand.muted }}>
            删掉本节
          </Button>
          <Button variant="contained" onClick={() => onSubmit({ action: 'accept' })}>
            保留并继续
          </Button>
        </Box>
      </Box>
    </Card>
  )
}

export function WriterRun({
  start, threadId: restoreId, language, paperType, onExit,
}: {
  start?: WriterStart
  threadId?: string
  language: 'zh' | 'en'
  paperType: string
  onExit: () => void
}) {
  const { docId, docTitle, editor, notify, alertAgent } = useApp()
  const { run: runStream, stop, running } = useAgentStream()
  const outline = useMemo(() => start?.outline ?? [], [start])
  // 已有正文的章节默认不选，免得重复写
  const [selected, setSelected] = useState<number[]>(() =>
    outline.map((_, i) => i).filter((i) => !(editor && sectionHasBody(editor, outline[i].title))),
  )
  const [mode, setMode] = useState<Mode>('confirm')
  const [polish, setPolish] = useState(false)
  const [polishTouched, setPolishTouched] = useState(false)
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium')
  const [follow, setFollow] = useState(true)
  const [status, setStatus] = useState<Status>(restoreId ? 'running' : 'setup')
  const [threadId, setThreadIdState] = useState<string | null>(restoreId ?? null)
  const tidRef = useRef<string | null>(restoreId ?? null)
  const setThreadId = (t: string | null) => {
    tidRef.current = t
    setThreadIdState(t)
  }
  const [drafts, setDrafts] = useState<SectionDraft[]>(() => outline.map((s) => ({ title: s.title, status: 'pending' })))
  const [phases, setPhases] = useState<Record<number, string>>({})
  const [polishState, setPolishState] = useState<'idle' | 'reading' | 'done'>('idle')
  const [edits, setEdits] = useState<Edit[]>([])
  const [polishSummary, setPolishSummary] = useState('')
  const [log, setLog] = useState('')
  const [pending, setPending] = useState<any>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0) // 文档里的草稿变了（保留 / 删除）时刷新列表
  const followRef = useRef(follow)
  followRef.current = follow
  // 最近一次发给后端的选择：停在请求半路时，「继续」要把它补发出去（文档里已经按它改过了）
  const lastSent = useRef<{ index: number; value: any } | null>(null)

  // 流式文本：按章节攒着，每帧最多刷新一次文档
  const buffers = useRef<Record<number, string>>({})
  const dirty = useRef(new Set<number>())
  const raf = useRef(0)
  const lastScroll = useRef(0)
  const titleOf = (i: number) => drafts[i]?.title ?? outline[i]?.title ?? `第 ${i + 1} 节`
  const titleRef = useRef(titleOf)
  titleRef.current = titleOf

  const flush = useCallback(() => {
    raf.current = 0
    const tid = tidRef.current
    if (!editor || !tid) return
    let lastKey = ''
    for (const i of dirty.current) {
      const key = draftKey(tid, i)
      ensureDraft(editor, key, titleRef.current(i))
      setDraftText(editor, key, buffers.current[i] ?? '', true)
      lastKey = key
    }
    dirty.current.clear()
    // 跟随写作位置（最多每 400ms 滚一次，避免抖动）
    if (lastKey && followRef.current && performance.now() - lastScroll.current > 400) {
      lastScroll.current = performance.now()
      const nodes = findDraft(editor, lastKey)
      if (nodes.length) scrollToPos(editor, nodes[nodes.length - 1].pos)
    }
  }, [editor])

  // 总编的修改：一处一处地在文档里呈现
  const editQueue = useRef<Promise<void>>(Promise.resolve())

  // 从保存的状态恢复（刷新页面后）
  useEffect(() => {
    if (!restoreId) return
    if (editor) clearLive(editor)
    api
      .agentState(restoreId)
      .then((st) => {
        const r = st.result ?? {}
        if (r.drafts) setDrafts(r.drafts)
        setEdits((r.edits ?? []).map((e: Edit) => ({ ...e, applied: true })))
        setPolishSummary(r.polish_summary ?? '')
        if (r.polish && (r.edits || st.status === 'done')) setPolishState('done')
        setPolish(!!r.polish)
        if (r.mode) setMode(r.mode)
        setErrors(r.errors ?? [])
        if (st.interrupt?.kind === 'review_section') {
          setStatus('waiting')
          setPending(st.interrupt)
          setLog('已从上次中断处恢复')
        } else setStatus(st.status === 'done' ? 'done' : 'stopped')
      })
      .catch((e) => {
        setStatus('error')
        setError(e.message)
      })
  }, [restoreId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor) return
    const bump = () => setTick((t) => t + 1)
    editor.on('update', bump)
    return () => {
      editor.off('update', bump)
    }
  }, [editor])

  const handle = useCallback(
    (e: any) => {
      if (e.type === 'status') {
        if (e.thread_id) setThreadId(e.thread_id)
        if (e.status !== 'waiting') setStatus(e.status)
      } else if (e.type === 'progress') {
        if (e.message) setLog(e.message)
        const i: number | undefined = typeof e.section === 'number' ? e.section : undefined
        const tid = tidRef.current
        if (e.phase === 'edit') {
          const ed: Edit = { section: e.section, title: e.title, para: e.para, before: e.before, after: e.after, reason: e.reason }
          setEdits((xs) => [...xs, ed])
          editQueue.current = editQueue.current.then(async () => {
            if (!editor) return
            const ok = await animateEdit(editor, ed.before, ed.after, followRef.current)
            if (ok) seedAnnotations({ title: ed.title, status: 'drafted', paragraphs: [ed.after], annotations: [e.annotations ?? []] })
            setEdits((xs) => xs.map((x) => (x === ed ? { ...x, applied: ok } : x)))
          })
        } else if (e.phase === 'token' && i != null) {
          buffers.current[i] = (buffers.current[i] ?? '') + e.delta
          dirty.current.add(i)
          if (!raf.current) raf.current = requestAnimationFrame(flush)
          setPhases((p) => (p[i] === 'token' ? p : { ...p, [i]: 'token' }))
        } else if (e.phase === 'draft' && i != null) {
          // 开始写（或按意见重写）：清空这一节的草稿，光标放好
          buffers.current[i] = ''
          if (editor && tid) {
            ensureDraft(editor, draftKey(tid, i), titleRef.current(i))
            setDraftText(editor, draftKey(tid, i), '', true)
          }
          setPhases((p) => ({ ...p, [i]: 'draft' }))
        } else if (e.phase === 'done' && i != null) {
          if (raf.current) cancelAnimationFrame(raf.current)
          raf.current = 0
          dirty.current.delete(i)
          const d: SectionDraft = e.draft
          if (editor && tid) {
            const key = draftKey(tid, i)
            ensureDraft(editor, key, d.title)
            setDraftText(editor, key, (d.paragraphs ?? []).join('\n\n'), false) // 自查后的定稿替换初稿
            seedAnnotations(d)
          }
          setDrafts((ds) => ds.map((x, j) => (j === i ? d : x)))
          setPhases((p) => {
            const n = { ...p }
            delete n[i]
            return n
          })
        } else if (e.phase === 'error' && i != null) {
          setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, status: 'error' } : x)))
          setPhases((p) => {
            const n = { ...p }
            delete n[i]
            return n
          })
        } else if (i != null && e.phase) {
          if (e.phase === 'check' && editor && tid) setDraftText(editor, draftKey(tid, i), buffers.current[i] ?? '', false)
          setPhases((p) => ({ ...p, [i]: e.phase }))
        } else if (e.phase === 'polish') {
          setPolishState('reading')
        } else if (e.phase === 'polished') {
          setPolishState('done')
        }
      } else if (e.type === 'interrupt') {
        lastSent.current = null
        setPending(e.value)
        setStatus('waiting')
        setDrafts((ds) => ds.map((x, j) => (j === e.value.index ? e.value.draft : x)))
        alertAgent(`分节写作：《${e.value.draft?.title}》写好了，等你确认`)
      } else if (e.type === 'done') {
        setPending(null)
        setStatus('done')
        setPhases({})
        if (e.result?.drafts)
          // 逐节确认时本地记录的「保留 / 删除」更准，其余用后端结果
          setDrafts((ds) => e.result.drafts.map((d: SectionDraft, j: number) => (ds[j]?.status === 'accepted' || ds[j]?.status === 'skipped' ? { ...d, status: ds[j].status } : d)))
        setErrors(e.result?.errors ?? [])
        setPolishSummary(e.result?.polish_summary ?? '')
        alertAgent('分节写作完成')
      } else if (e.type === 'error') {
        setStatus('error')
        setError(e.message)
      }
    },
    [editor, flush, alertAgent], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const stopped = () => {
    setPhases({})
    setStatus('stopped')
    if (editor) clearLive(editor)
  }

  const run = async () => {
    if (!start) return
    setStatus('running')
    setLog('准备中…')
    setDrafts(outline.map((s, i) => ({ title: s.title, status: selected.includes(i) ? 'pending' : 'excluded' })))
    try {
      const r = await runStream(
        '/api/agent/write',
        {
          doc_id: docId, topic: start.topic, doc_title: docTitle, language, paper_type: paperType, outline, mode, length,
          selected: [...selected].sort((a, b) => a - b), polish,
        },
        handle,
      )
      if (r === 'stopped') stopped()
    } catch (e: any) {
      setStatus('error')
      setError(e.message)
    }
  }

  const send = async (value: any) => {
    if (!threadId) return
    setStatus('running')
    try {
      const r = await runStream(`/api/agent/${threadId}/resume`, { value }, handle)
      if (r === 'stopped') stopped()
    } catch (e: any) {
      setStatus('error')
      setError(e.message)
    }
  }

  const cont = async () => {
    if (!threadId) return
    setLog('继续…')
    const st = await api.agentState(threadId).catch(() => null)
    const intr = st?.interrupt
    if (intr?.kind === 'review_section') {
      if (lastSent.current?.index === intr.index) return send(lastSent.current!.value)
      setPending(intr)
      setDrafts((ds) => ds.map((x, j) => (j === intr.index ? intr.draft : x)))
      return setStatus('waiting')
    }
    if (st?.status === 'done') {
      if (st.result?.drafts) setDrafts(st.result.drafts)
      return setStatus('done')
    }
    return send({})
  }

  const keyOf = (i: number) => (threadId ? draftKey(threadId, i) : '')
  const locate = (i: number) => {
    if (!editor || !threadId) return
    const nodes = findDraft(editor, keyOf(i))
    if (nodes.length) return scrollToPos(editor, nodes[0].pos)
    const d = drafts[i]
    const pos = d?.paragraphs?.[0] ? locateParagraph(editor, d.paragraphs[0]) : null
    if (pos != null) scrollToPos(editor, pos)
  }

  // 逐节确认：在文档里保留 / 删除这一节的草稿，再告诉后端
  const resume = async (value: any) => {
    if (!threadId || !pending || !editor) return
    const cur = pending
    const key = keyOf(cur.index)
    if (value.action === 'accept') {
      if (!findDraft(editor, key).length && cur.draft?.paragraphs?.length) {
        // 刷新后草稿不在文档里（还没来得及保存）：补写进去
        ensureDraft(editor, key, cur.draft.title)
        setDraftText(editor, key, cur.draft.paragraphs.join('\n\n'), false)
        seedAnnotations(cur.draft)
      }
      keepDraft(editor, key)
    } else if (value.action === 'skip' || value.action === 'stop') {
      removeDraft(editor, key)
    }
    setDrafts((ds) =>
      ds.map((x, j) => (j !== cur.index ? x : value.action === 'accept' ? { ...x, status: 'accepted' } : value.action === 'regenerate' ? x : { ...x, status: 'skipped' })),
    )
    setPending(null)
    setLog(value.action === 'regenerate' ? '按你的意见重写…' : '继续…')
    lastSent.current = { index: cur.index, value }
    await send(value)
  }

  // 文档里还留着的草稿（连续写完 / 并行写 结束后统一处理）
  const leftover = editor && threadId ? listDrafts(editor, threadId.slice(0, 8) + '-') : []
  const leftoverIdx = leftover.map((k) => Number(k.split('-').pop()))
  const keepAll = () => {
    if (!editor) return
    for (const k of leftover) keepDraft(editor, k)
    setDrafts((ds) => ds.map((d, j) => (leftoverIdx.includes(j) ? { ...d, status: 'accepted' } : d)))
    notify(`已保留 ${leftover.length} 节`, 'success')
  }
  const dropOne = (i: number) => {
    if (!editor) return
    removeDraft(editor, keyOf(i))
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, status: 'skipped' } : d)))
  }

  const written = drafts.filter((d) => d.status === 'accepted' || d.status === 'drafted')
  const issues = written.reduce((a, d) => a + (d.issues ?? 0), 0)
  const fixed = drafts.reduce((a, d) => a + (d.fixed ?? 0), 0)
  const parallelRunning = Object.keys(phases).length

  return (
    <Thread>
      <ThreadItem icon={<EditNoteIcon sx={{ color: `${brand.purple} !important` }} />}>
        <Card variant="agent" sx={{ py: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5, gap: 0.5 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 500, color: brand.purple, flex: 1 }}>
              分节写作 Agent
            </Typography>
            {status !== 'setup' && (
              <Tooltip title="写作时文档自动滚到 Agent 正在写的位置">
                <Box sx={{ display: 'flex', alignItems: 'center', fontSize: 11.5, color: brand.muted }}>
                  跟随
                  <Switch size="small" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                </Box>
              </Tooltip>
            )}
            {running ? (
              <Button size="small" startIcon={<StopCircleOutlinedIcon />} onClick={() => stop(threadId)} sx={{ color: brand.red, py: 0, minHeight: 24, fontSize: 12 }}>
                停止
              </Button>
            ) : (
              <Tooltip title="返回">
                <IconButton onClick={onExit} sx={{ p: 0.25 }} aria-label="返回">
                  <ArrowBackIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
          {status !== 'setup' &&
            drafts.map((d, i) =>
              d.status === 'excluded' ? null : (
                <SectionRow key={i} i={i} d={d} phase={phases[i]} onLocate={d.status !== 'pending' ? () => locate(i) : undefined} />
              ),
            )}
          {status !== 'setup' && polish && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.2, mt: 0.25, borderTop: `1px dashed ${brand.line}`, pt: 0.5 }}>
              <Box sx={{ width: 14, display: 'flex', justifyContent: 'center' }}>
                {polishState === 'reading' ? (
                  <CircularProgress size={12} sx={{ color: brand.purple, m: '1px' }} />
                ) : polishState === 'done' ? (
                  <CheckCircleIcon sx={{ fontSize: 14, color: brand.green }} />
                ) : (
                  <RadioButtonUncheckedIcon sx={{ fontSize: 14, color: '#cfcfcf' }} />
                )}
              </Box>
              <Typography sx={{ fontSize: 12.5, flex: 1 }}>总编 Agent 统稿</Typography>
              <Typography sx={{ fontSize: 11.5, color: polishState === 'reading' ? brand.purple : brand.faint }}>
                {polishState === 'reading' ? (edits.length ? `修改中 · ${edits.length} 处` : '通读全文') : polishState === 'done' ? `改了 ${edits.length} 处` : '等各节写完'}
              </Typography>
            </Box>
          )}
          {status === 'running' && (log || parallelRunning > 1) && (
            <Typography noWrap sx={{ fontSize: 11.5, color: brand.muted, mt: 0.5 }}>
              {mode === 'parallel' && parallelRunning > 1 ? `${parallelRunning} 个子 Agent 同时在写 · ` : ''}
              {log}
            </Typography>
          )}
        </Card>
      </ThreadItem>

      {status === 'setup' && start && (
        <ThreadItem>
          <Card variant="data">
            <Typography sx={{ fontSize: 12.5, color: brand.ink, lineHeight: 1.7 }}>
              每节单独检索文献库和你的笔记，引用只来自检索到的证据；Agent 边写边把草稿写进正文对应的标题下，写完自查引用，剩下的问题变成页边批注。
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', mt: 1.25 }}>
              <Typography sx={{ fontSize: 12, color: brand.muted, flex: 1 }}>要写哪些节（{selected.length}/{outline.length}）</Typography>
              <ButtonBase onClick={() => setSelected(selected.length === outline.length ? [] : outline.map((_, i) => i))} sx={{ fontSize: 11.5, color: brand.blue }}>
                {selected.length === outline.length ? '全不选' : '全选'}
              </ButtonBase>
            </Box>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.line}`, borderRadius: '6px', mt: 0.5, maxHeight: 220, overflow: 'auto' }}>
              {outline.map((s, i) => {
                const has = editor ? sectionHasBody(editor, s.title) : false
                return (
                  <Box
                    key={i}
                    onClick={() => setSelected(selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i])}
                    sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, py: 0.25, cursor: 'pointer', borderBottom: `1px solid ${brand.lineSoft}`, '&:last-child': { borderBottom: 'none' } }}
                  >
                    <Checkbox size="small" checked={selected.includes(i)} sx={{ p: 0.5 }} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography noWrap sx={{ fontSize: 12.5 }}>{s.title}</Typography>
                      {s.goal && (
                        <Typography noWrap sx={{ fontSize: 11.5, color: brand.faint }}>
                          {s.goal}
                        </Typography>
                      )}
                    </Box>
                    {has && <Chip size="small" label="已有正文" sx={{ height: 18, fontSize: 10.5, color: brand.amber, bgcolor: 'rgba(183,121,31,0.1)' }} />}
                  </Box>
                )
              })}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.25, flexWrap: 'wrap' }}>
              <Typography sx={{ fontSize: 12, color: brand.muted, width: 32 }}>方式</Typography>
              <Seg
                value={mode}
                onChange={(m) => {
                  setMode(m)
                  if (!polishTouched) setPolish(m === 'parallel')
                }}
                options={[
                  ['confirm', '逐节确认', '一节一节地写，每节写完停下来由你决定保留、重写或删掉'],
                  ['auto', '连续写完', '一节接一节写完，最后统一保留或删除'],
                  ['parallel', '并行写', '每节交给一个子 Agent 同时写，速度最快；各节互相看不到，建议配合总编统稿'],
                ]}
              />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
              <Typography sx={{ fontSize: 12, color: brand.muted, width: 32 }}>篇幅</Typography>
              <Seg
                value={length}
                onChange={setLength}
                options={[
                  ['short', '简短', '每节 1–2 段'],
                  ['medium', '适中', '每节 2–3 段'],
                  ['long', '详细', '每节 3–5 段'],
                ]}
              />
            </Box>
            <Box
              onClick={() => {
                setPolish(!polish)
                setPolishTouched(true)
              }}
              sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mt: 1, cursor: 'pointer' }}
            >
              <Checkbox size="small" checked={polish} sx={{ p: 0.25, mt: '-2px' }} />
              <Box>
                <Typography sx={{ fontSize: 12.5 }}>最后由总编 Agent 统稿</Typography>
                <Typography sx={{ fontSize: 11.5, color: brand.faint }}>通读新写的各节，修改衔接、重复和前后不一致的地方，每处修改都在正文里呈现</Typography>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
              <Button onClick={onExit} sx={{ color: brand.muted }}>
                取消
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button variant="contained" disabled={!editor || !selected.length} onClick={run}>
                开始写作（{selected.length} 节）
              </Button>
            </Box>
          </Card>
        </ThreadItem>
      )}

      {pending?.kind === 'review_section' && (
        <ThreadItem icon={<PauseCircleFilledIcon sx={{ color: `${brand.orange} !important` }} />}>
          <ConfirmCard key={`${pending.index}-${pending.draft?.paragraphs?.[0]?.slice(0, 20)}`} value={pending} onSubmit={resume} onLocate={() => locate(pending.index)} />
        </ThreadItem>
      )}

      {edits.length > 0 && (
        <ThreadItem icon={<DriveFileRenameOutlineIcon sx={{ color: `${brand.purple} !important` }} />}>
          <Card variant="data">
            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>总编修改 · {edits.length} 处</Typography>
            {polishSummary && <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.25, lineHeight: 1.6 }}>{polishSummary}</Typography>}
            {edits.map((ed, k) => (
              <Box
                key={k}
                onClick={() => {
                  const pos = editor ? locateParagraph(editor, ed.after) : null
                  if (editor && pos != null) scrollToPos(editor, pos)
                }}
                sx={{ mt: 0.75, p: 0.75, bgcolor: '#fff', borderRadius: '6px', border: `1px solid ${brand.lineSoft}`, cursor: 'pointer', '&:hover': { borderColor: brand.purple } }}
              >
                <Typography sx={{ fontSize: 12, fontWeight: 500 }}>
                  《{ed.title}》第 {ed.para + 1} 段
                  {ed.applied === false && <Box component="span" sx={{ color: brand.amber, fontWeight: 400, ml: 0.5 }}>（原文已改动，未应用）</Box>}
                </Typography>
                {ed.reason && <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.25 }}>{ed.reason}</Typography>}
              </Box>
            ))}
          </Card>
        </ThreadItem>
      )}

      {status === 'stopped' && (
        <ThreadItem icon={<PauseCircleFilledIcon sx={{ color: `${brand.faint} !important` }} />}>
          <Card sx={{ fontSize: 12.5, color: brand.muted, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ flex: 1 }}>已停止。写好的草稿保留在文档里，可以从停下的地方继续。</Box>
            <Button size="small" variant="outlined" onClick={cont}>
              继续
            </Button>
          </Card>
        </ThreadItem>
      )}

      {error && (
        <ThreadItem icon={<ErrorIcon sx={{ color: `${brand.red} !important` }} />}>
          <Card sx={{ color: brand.red, fontSize: 12.5 }}>{error}</Card>
        </ThreadItem>
      )}

      {(status === 'done' || status === 'stopped') && leftover.length > 0 && (
        <ThreadItem icon={<PauseCircleFilledIcon sx={{ color: `${brand.orange} !important` }} />}>
          <Card variant="data" sx={{ p: 0, overflow: 'hidden' }}>
            <Box sx={{ px: 1.25, py: 1 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{leftover.length} 节草稿还在文档里</Typography>
              <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.25, lineHeight: 1.6 }}>紫色标记的段落是草稿，可以直接在正文里改；满意就保留，不要的删掉。</Typography>
            </Box>
            <Box sx={{ bgcolor: '#fff', borderTop: `1px solid rgba(0,120,212,0.18)`, px: 0.75, py: 0.5 }}>
              {leftoverIdx.map((i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25 }}>
                  <Typography noWrap sx={{ fontSize: 12.5, flex: 1, px: 0.5 }}>
                    {titleOf(i)}
                  </Typography>
                  <Tooltip title="定位">
                    <IconButton onClick={() => locate(i)} sx={{ p: 0.25, color: brand.blue }} aria-label="定位">
                      <CenterFocusStrongOutlinedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="删除这节草稿">
                    <IconButton onClick={() => dropOne(i)} sx={{ p: 0.25, color: brand.faint }} aria-label="删除草稿">
                      <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Box>
            <Box sx={{ bgcolor: '#fff', borderTop: `1px solid ${brand.lineSoft}`, px: 1.25, py: 1, display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="contained" onClick={keepAll}>
                全部保留
              </Button>
            </Box>
          </Card>
        </ThreadItem>
      )}

      {status === 'done' && (
        <ThreadItem icon={<CheckCircleIcon sx={{ color: `${brand.green} !important` }} />}>
          <Card variant="data">
            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>写了 {written.length} 节</Typography>
            <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.25, lineHeight: 1.7 }}>
              {fixed ? `写作时自动修正了 ${fixed} 处引用。` : ''}
              {edits.length ? `总编改了 ${edits.length} 处。` : ''}
              {issues ? `还有 ${issues} 处需要你看一下，已显示在正文右侧的页边批注里。` : '引用核查没有发现需要处理的问题。'}
            </Typography>
          </Card>
          {!!errors.length && (
            <Box sx={{ mt: 0.75 }}>
              {errors.map((e, i) => (
                <Typography key={i} sx={{ fontSize: 11.5, color: brand.amber }}>
                  ⚠ {e}
                </Typography>
              ))}
            </Box>
          )}
        </ThreadItem>
      )}
    </Thread>
  )
}
