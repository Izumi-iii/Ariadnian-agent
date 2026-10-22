/**
 * 审稿 Agent 面板：发起审稿、看总评和轮次、逐条处理意见、再审一轮。
 * 意见本身挂在正文旁边的页边批注里（PaperEditor），这里放总览和列表（页边空间不够时也能在这里处理）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, ButtonBase, Chip, CircularProgress, Collapse, IconButton, InputBase, Tooltip, Typography } from '@mui/material'
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import PauseCircleFilledIcon from '@mui/icons-material/PauseCircleFilled'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckIcon from '@mui/icons-material/Check'
import { api } from '../lib/api'
import { useAgentStream } from '../lib/agentStream'
import { useApp } from '../lib/appContext'
import { CATEGORY_LABEL, collectSections, critiqueStore, useCritique, type CritiqueIssue } from '../lib/critique'
import { Card, Thread, ThreadItem } from '../components/Thread'
import { IssueBody, severityColor } from './CritiqueIssue'
import { brand } from '../theme'

type Status = 'setup' | 'running' | 'waiting' | 'done' | 'stopped' | 'error'

const VERDICT: Record<string, [string, string]> = {
  accept: ['可以接收', brand.green],
  minor: ['小修', brand.amber],
  major: ['大修', brand.red],
}
const SCORE_LABEL: Record<string, string> = { logic: '逻辑', evidence: '论据', structure: '结构' }

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <Box sx={{ display: 'inline-flex', border: `1px solid ${brand.line}`, borderRadius: '6px', overflow: 'hidden' }}>
      {options.map(([v, l]) => (
        <ButtonBase
          key={String(v)}
          onClick={() => onChange(v)}
          sx={{ px: 1.1, py: 0.4, fontSize: 12, color: value === v ? '#fff' : brand.muted, bgcolor: value === v ? brand.purple : '#fff' }}
        >
          {l}
        </ButtonBase>
      ))}
    </Box>
  )
}

function IssueRow({ issue }: { issue: CritiqueIssue }) {
  const { responses } = useCritique()
  const [open, setOpen] = useState(false)
  const r = responses[issue.id]
  const c = severityColor(issue.severity)
  return (
    <Box sx={{ borderBottom: `1px solid ${brand.lineSoft}` }}>
      <Box
        role="button"
        onClick={() => {
          critiqueStore.focus(issue.id)
          setOpen(!open)
        }}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.6, px: 0.5, cursor: 'pointer', borderRadius: '4px', '&:hover': { bgcolor: 'rgba(0,0,0,0.03)' } }}
      >
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: r ? 'transparent' : c, border: r ? `1.5px solid ${brand.faint}` : 'none', flexShrink: 0 }} />
        <Typography sx={{ fontSize: 12, color: c, fontWeight: 500, flexShrink: 0, width: 52 }}>{CATEGORY_LABEL[issue.category]}</Typography>
        <Typography noWrap sx={{ fontSize: 12, flex: 1, minWidth: 0, color: r ? brand.faint : brand.ink, textDecoration: r?.status === 'fixed' ? 'line-through' : 'none' }}>
          {issue.anchor ? `“${issue.anchor}”` : `《${issue.section}》整节`}
        </Typography>
        {r && (
          <Typography sx={{ fontSize: 11, color: r.status === 'fixed' ? brand.green : brand.muted, flexShrink: 0 }}>
            {r.status === 'fixed' ? '已修改' : '不改'}
          </Typography>
        )}
        <ExpandMoreIcon sx={{ fontSize: 15, color: brand.faint, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1, pb: 1 }}>
          <IssueBody issue={issue} />
        </Box>
      </Collapse>
    </Box>
  )
}

export function CritiqueRun({
  threadId: restoreId, paperType, language, onExit,
}: {
  threadId?: string
  paperType: string
  language: 'zh' | 'en'
  onExit: () => void
}) {
  const { docId, docTitle, editor, alertAgent, notify } = useApp()
  const v = useCritique()
  const { run, stop, running, stopping } = useAgentStream()
  const [status, setStatus] = useState<Status>(restoreId ? 'running' : 'setup')
  const [threadId, setThreadIdState] = useState<string | null>(restoreId ?? null)
  const tidRef = useRef<string | null>(restoreId ?? null)
  const setThreadId = (t: string | null) => {
    tidRef.current = t
    setThreadIdState(t)
  }
  const [focus, setFocus] = useState('')
  const [rounds, setRounds] = useState(3)
  const [log, setLog] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const sections = useMemo(() => (editor && status === 'setup' ? collectSections(editor) : []), [editor, status])
  const chars = sections.reduce((a, s) => a + s.text.length, 0)

  useEffect(() => {
    if (!restoreId) return
    api
      .agentState(restoreId)
      .then((st) => {
        if (st.interrupt?.kind === 'revise') {
          critiqueStore.load(restoreId, st.interrupt, false)
          setStatus('waiting')
        } else if (st.result) {
          if (st.result.issues || st.result.history?.length) critiqueStore.load(restoreId, st.result, st.status === 'done')
          setErrors(st.result.errors ?? [])
          setStatus(st.status === 'done' ? 'done' : 'stopped')
        }
      })
      .catch((e) => {
        setStatus('error')
        setError(e.message)
      })
  }, [restoreId])

  const handle = useCallback(
    (e: any) => {
      if (e.type === 'status') {
        if (e.thread_id) setThreadId(e.thread_id)
      } else if (e.type === 'progress') {
        setLog((l) => [...l, e.message].slice(-3))
      } else if (e.type === 'interrupt') {
        if (tidRef.current) critiqueStore.load(tidRef.current, e.value, false)
        setStatus('waiting')
        const n = e.value.issues?.length ?? 0
        alertAgent(`第 ${e.value.round} 轮审稿意见已就绪：${n} 条`)
      } else if (e.type === 'done') {
        if (tidRef.current) critiqueStore.load(tidRef.current, e.result, true)
        setErrors(e.result?.errors ?? [])
        setStatus('done')
        alertAgent('审稿结束')
      } else if (e.type === 'error') {
        setStatus('error')
        setError(e.message)
      }
    },
    [alertAgent], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const go = async (path: string, body: unknown) => {
    setStatus('running')
    setError(null)
    setLog([])
    try {
      const r = await run(path, body, handle)
      if (r === 'stopped') setStatus('stopped')
    } catch (e: any) {
      setStatus('error')
      setError(e.message)
    }
  }

  const start = () => {
    if (!editor) return
    critiqueStore.clear()
    go('/api/agent/critique', {
      doc_id: docId, doc_title: docTitle, language, paper_type: paperType, focus: focus.trim(), max_rounds: rounds, sections: collectSections(editor),
    })
  }

  // 最近一次发出的选择：停在请求半路时，「继续」把它补发出去
  const lastSent = useRef<{ round: number; value: any } | null>(null)
  const send = (value: any) => {
    if (!threadId) return
    lastSent.current = { round: critiqueStore.get().round, value }
    go(`/api/agent/${threadId}/resume`, { value })
  }

  const again = () => {
    if (!editor || !threadId) return
    const responses = critiqueStore.get().responses
    send({ action: 'again', sections: collectSections(editor), responses })
    critiqueStore.startRound(threadId)
  }

  const finish = () => send({ action: 'stop' })
  const cont = async () => {
    if (!threadId) return
    const st = await api.agentState(threadId).catch(() => null)
    if (st?.interrupt?.kind === 'revise') {
      if (lastSent.current?.round === st.interrupt.round) return go(`/api/agent/${threadId}/resume`, { value: lastSent.current!.value })
      critiqueStore.load(threadId, st.interrupt, false)
      return setStatus('waiting')
    }
    if (st?.status === 'done') {
      critiqueStore.load(threadId, st.result, true)
      return setStatus('done')
    }
    go(`/api/agent/${threadId}/resume`, { value: {} })
  }

  const open = v.issues
  const handled = open.filter((i) => v.responses[i.id]).length
  const major = open.filter((i) => i.severity === 'major').length
  const lastRound = v.round >= v.maxRounds
  const verdict = VERDICT[v.verdict]

  return (
    <Thread>
      <ThreadItem icon={<RateReviewOutlinedIcon sx={{ color: `${brand.purple} !important` }} />}>
        <Card variant="agent" sx={{ py: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 500, color: brand.purple, flex: 1 }}>
              审稿 Agent{v.round > 0 && ` · 第 ${v.round}/${v.maxRounds} 轮`}
            </Typography>
            {running ? (
              <Button size="small" disabled={stopping} startIcon={<StopCircleOutlinedIcon />} onClick={() => stop(threadId)} sx={{ color: brand.red, py: 0, minHeight: 24, fontSize: 12 }}>
                {stopping ? '正在保存并停止…' : '停止'}
              </Button>
            ) : (
              <Tooltip title="返回">
                <IconButton onClick={onExit} sx={{ p: 0.25 }} aria-label="返回">
                  <ArrowBackIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
          {status === 'running' && (
            <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, alignItems: 'flex-start' }}>
              <CircularProgress size={12} sx={{ mt: '3px', color: brand.purple }} />
              <Box sx={{ minWidth: 0 }}>
                {(log.length ? log : ['准备中…']).map((l, i, a) => (
                  <Typography key={i} noWrap sx={{ fontSize: 12, color: i === a.length - 1 ? brand.ink : brand.faint }}>
                    {l}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}
          {v.history.length > 0 && status !== 'running' && (
            <Box sx={{ mt: 0.5 }}>
              {v.history.map((h) => (
                <Box key={h.round} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.15 }}>
                  <CheckCircleIcon sx={{ fontSize: 13, color: brand.green }} />
                  <Typography sx={{ fontSize: 12, flex: 1 }}>
                    第 {h.round} 轮 · {VERDICT[h.verdict]?.[0] ?? h.verdict}
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, color: brand.faint }}>
                    {h.round > 1 ? `解决 ${h.resolved} · ` : ''}新提 {h.raised} 条
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Card>
      </ThreadItem>

      {status === 'setup' && (
        <ThreadItem>
          <Card variant="data">
            <Typography sx={{ fontSize: 12.5, color: brand.ink, lineHeight: 1.7 }}>
              审稿人通读全文，只挑<b>逻辑和论据</b>上的问题（推理跳跃、论据不足、结论说过头、结构缺失），每条意见挂在正文对应的句子旁边。你逐条标「已修改」或「不改」并写理由，然后再审一轮：审稿人会先复查上一轮的意见，再看有没有新的主要问题。
            </Typography>
            <Typography sx={{ fontSize: 12, color: sections.length ? brand.muted : brand.red, mt: 1 }}>
              {sections.length ? `将审阅 ${sections.length} 节，约 ${chars} 字` : '文档里还没有正文，先写一些内容再来审稿'}
            </Typography>
            <InputBase
              fullWidth
              multiline
              maxRows={3}
              placeholder="（可选）想让审稿人重点看什么？例如：方法部分的论证是否充分"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              sx={{ mt: 1, fontSize: 12.5, bgcolor: '#fff', border: `1px solid ${brand.line}`, borderRadius: '6px', px: 1, py: 0.5 }}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
              <Typography sx={{ fontSize: 12, color: brand.muted }}>最多</Typography>
              <Seg value={rounds} onChange={setRounds} options={[[1, '1 轮'], [2, '2 轮'], [3, '3 轮'], [5, '5 轮']]} />
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
              <Button onClick={onExit} sx={{ color: brand.muted }}>
                取消
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button variant="contained" disabled={!sections.length} onClick={start}>
                开始审稿
              </Button>
            </Box>
          </Card>
        </ThreadItem>
      )}

      {(status === 'waiting' || status === 'done' || (status === 'stopped' && v.round > 0)) && v.round > 0 && (
        <ThreadItem icon={status === 'waiting' ? <PauseCircleFilledIcon sx={{ color: `${brand.orange} !important` }} /> : <CheckCircleIcon sx={{ color: `${brand.green} !important` }} />}>
          <Card variant="data" sx={{ p: 0, overflow: 'hidden' }}>
            <Box sx={{ px: 1.25, py: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{status === 'done' ? '审稿结束' : `第 ${v.round} 轮审稿意见`}</Typography>
                {verdict && <Chip size="small" label={verdict[0]} sx={{ height: 20, fontSize: 11, color: '#fff', bgcolor: verdict[1] }} />}
              </Box>
              {Object.keys(v.scores).length > 0 && (
                <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75 }}>
                  {Object.entries(v.scores).map(([k, s]) => (
                    <Box key={k} sx={{ flex: 1 }}>
                      <Typography sx={{ fontSize: 11, color: brand.muted }}>
                        {SCORE_LABEL[k] ?? k} {s}/5
                      </Typography>
                      <Box sx={{ height: 4, borderRadius: 2, bgcolor: 'rgba(0,0,0,0.08)', mt: 0.25 }}>
                        <Box sx={{ height: 4, borderRadius: 2, width: `${((s ?? 0) / 5) * 100}%`, bgcolor: (s ?? 0) >= 4 ? brand.green : (s ?? 0) >= 3 ? brand.amber : brand.red }} />
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
              {v.summary && <Typography sx={{ fontSize: 12.5, lineHeight: 1.7, mt: 0.75 }}>{v.summary}</Typography>}
            </Box>
            <Box sx={{ bgcolor: '#fff', borderTop: `1px solid rgba(0,120,212,0.18)`, px: 1, py: 0.75 }}>
              <Typography sx={{ fontSize: 11.5, color: brand.muted, px: 0.5, mb: 0.25 }}>
                {open.length ? `待处理 ${open.length} 条（主要 ${major}）· 已标记 ${handled}` : '没有需要处理的意见'}
                {open.length > 0 && ' · 点一条在正文里定位'}
              </Typography>
              {open.map((i) => (
                <IssueRow key={i.id} issue={i} />
              ))}
              {v.resolved.length > 0 && (
                <>
                  <ButtonBase onClick={() => setShowResolved(!showResolved)} sx={{ mt: 0.5, px: 0.5, fontSize: 11.5, color: brand.green, gap: 0.5, borderRadius: '4px' }}>
                    <CheckIcon sx={{ fontSize: 14 }} /> 已解决 {v.resolved.length} 条
                    <ExpandMoreIcon sx={{ fontSize: 14, transform: showResolved ? 'rotate(180deg)' : 'none' }} />
                  </ButtonBase>
                  <Collapse in={showResolved}>
                    {v.resolved.map((i) => (
                      <Box key={i.id} sx={{ px: 0.5, py: 0.4 }}>
                        <Typography noWrap sx={{ fontSize: 12, color: brand.faint, textDecoration: 'line-through' }}>
                          {CATEGORY_LABEL[i.category]} · {i.anchor || `《${i.section}》整节`}
                        </Typography>
                        {i.followup?.comment && <Typography sx={{ fontSize: 11.5, color: brand.muted }}>{i.followup.comment}</Typography>}
                      </Box>
                    ))}
                  </Collapse>
                </>
              )}
            </Box>
            {status === 'waiting' && (
              <Box sx={{ bgcolor: '#fff', borderTop: `1px solid ${brand.lineSoft}`, px: 1.25, py: 1 }}>
                <Typography sx={{ fontSize: 11.5, color: brand.muted, mb: 0.75, lineHeight: 1.6 }}>
                  在正文里修改，然后逐条标「已修改」或「不改」；没标的意见会告诉审稿人「暂未处理」。
                </Typography>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button onClick={finish} sx={{ color: brand.muted }}>
                    结束审稿
                  </Button>
                  <Box sx={{ flex: 1 }} />
                  <Button variant="contained" onClick={again} disabled={lastRound}>
                    再审一轮（第 {v.round + 1}/{v.maxRounds} 轮）
                  </Button>
                </Box>
              </Box>
            )}
            {status === 'done' && (
              <Box sx={{ bgcolor: '#fff', borderTop: `1px solid ${brand.lineSoft}`, px: 1.25, py: 1, display: 'flex', gap: 1 }}>
                {open.length > 0 && (
                  <Button
                    onClick={() => {
                      critiqueStore.dismiss()
                      notify('已清除页边的审稿意见', 'info')
                    }}
                    sx={{ color: brand.muted }}
                  >
                    清除页边意见
                  </Button>
                )}
                <Box sx={{ flex: 1 }} />
                <Button
                  variant="outlined"
                  onClick={() => {
                    critiqueStore.clear()
                    setThreadId(null)
                    setStatus('setup')
                  }}
                  sx={{ bgcolor: '#fff' }}
                >
                  重新审稿
                </Button>
              </Box>
            )}
          </Card>
        </ThreadItem>
      )}

      {status === 'stopped' && (
        <ThreadItem icon={<PauseCircleFilledIcon sx={{ color: `${brand.faint} !important` }} />}>
          <Card sx={{ fontSize: 12.5, color: brand.muted, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ flex: 1 }}>已停止。已经完成的步骤都保存了，可以从停下的地方继续。</Box>
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
      {!!errors.length && (
        <Box sx={{ pl: 4 }}>
          {errors.map((e, i) => (
            <Typography key={i} sx={{ fontSize: 11.5, color: brand.amber }}>
              ⚠ {e}
            </Typography>
          ))}
        </Box>
      )}
    </Thread>
  )
}
