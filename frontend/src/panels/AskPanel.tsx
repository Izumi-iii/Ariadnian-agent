import { useEffect, useRef, useState } from 'react'
import { Box, Button, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import NoteAddOutlinedIcon from '@mui/icons-material/NoteAddOutlined'
import { api, streamSSE } from '../lib/api'
import { authorYearLabel, citeStore } from '../lib/citations'
import { useApp } from '../lib/appContext'
import { Card, Composer, Thread, ThreadItem } from '../components/Thread'
import { brand } from '../theme'

interface Source {
  n: number
  paper_id: string
  bibkey: string
  title: string
  year?: number
  section?: string
  page?: number
  snippet: string
}
interface Msg {
  q: string
  a: string
  sources: Source[]
  done: boolean
}

const EXAMPLES = ['这些论文是怎么评测引用准确性的？', 'RAG 的主要思路是什么？有哪些代表性改进？', '哪些工作讨论了模型幻觉的成因？']

type Suggestion = { q: string; papers: { id: string; short: string; year?: number | null }[] }

/** 当前论文的章节标题（一、二级），用来让示例问题贴合正在写的内容 */
function headingsOf(editor: any): string[] {
  const out: string[] = []
  editor?.state.doc.forEach((n: any) => {
    if (n.type.name === 'heading' && n.attrs.level <= 2 && n.textContent.trim()) out.push(n.textContent.trim())
  })
  return out.slice(0, 12)
}

export function AskPanel() {
  const { editor, notify, docTitle, papers, drawerOpen, rightTab, askRequest } = useApp()
  const [sugs, setSugs] = useState<Suggestion[] | null>(null)
  const [sugLoading, setSugLoading] = useState(false)
  const [sugError, setSugError] = useState(false)
  const visible = drawerOpen && rightTab === 'ask'
  const libKey = papers.map((p) => p.id).sort().join(',')

  // 打开「文献问答」时，按当前论文和文献库生成示例问题，生成好后替换默认示例（后端有缓存，切换页签不会重复调用模型）
  const loadSugs = async (refresh = false) => {
    setSugLoading(true)
    setSugError(false)
    try {
      const r = await api.questions(docTitle, headingsOf(editor), refresh)
      setSugs(r.questions)
    } catch {
      setSugError(true)
    } finally {
      setSugLoading(false)
    }
  }
  useEffect(() => {
    if (!visible || !papers.length) return
    const t = window.setTimeout(() => loadSugs(false), 500)
    return () => window.clearTimeout(t)
  }, [visible, docTitle, libKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const busy = msgs.some((m) => !m.done)
  const scrollRef = useRef<HTMLDivElement>(null)

  const ask = async (question: string) => {
    if (!question.trim() || busy) return
    setQ('')
    const idx = msgs.length
    setMsgs((m) => [...m, { q: question, a: '', sources: [], done: false }])
    const patch = (f: (m: Msg) => Msg) => setMsgs((all) => all.map((m, i) => (i === idx ? f(m) : m)))
    try {
      await streamSSE('/api/assist/ask', { question }, (e) => {
        if (e.type === 'sources') patch((m) => ({ ...m, sources: e.sources }))
        else if (e.type === 'token') patch((m) => ({ ...m, a: m.a + e.text }))
        else if (e.type === 'error') throw new Error(e.message)
        scrollRef.current?.scrollTo({ top: 1e6 })
      })
    } catch (err: any) {
      notify(err.message, 'error')
    }
    patch((m) => ({ ...m, done: true }))
  }

  // 从原文选中的句子「问 AI」
  const lastAsk = useRef(0)
  useEffect(() => {
    if (!askRequest || askRequest.nonce === lastAsk.current) return
    lastAsk.current = askRequest.nonce
    ask(askRequest.question)
  }, [askRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 把回答插入正文：[n] 换成对应文献的引用节点 */
  const insertAnswer = (m: Msg) => {
    if (!editor) return
    const content: any[] = []
    let last = 0
    for (const match of m.a.matchAll(/\[(\d+(?:\s*[,，]\s*\d+)*)\]/g)) {
      const ids = match[1]
        .split(/[,，]/)
        .map((n) => m.sources.find((s) => s.n === Number(n.trim()))?.paper_id)
        .filter(Boolean)
      if (!ids.length) continue
      if (match.index! > last) content.push({ type: 'text', text: m.a.slice(last, match.index) })
      content.push({ type: 'citation', attrs: { ids: [...new Set(ids)] } })
      last = match.index! + match[0].length
    }
    if (last < m.a.length) content.push({ type: 'text', text: m.a.slice(last) })
    editor.chain().focus().insertContent({ type: 'paragraph', content: content.filter((c) => c.type !== 'text' || c.text) }).run()
  }

  return (
    <>
      <Box ref={scrollRef} sx={{ flex: 1, overflow: 'auto', px: 2, pt: 1 }}>
        {!msgs.length ? (
          <Box>
            <Typography sx={{ fontSize: 13, color: brand.muted, lineHeight: 1.7, mb: 1.5 }}>
              基于你的文献库回答问题，每个论断都标注来源编号，可以一键插入正文并自动变成引用。
            </Typography>
            {!papers.length ? (
              <Typography sx={{ fontSize: 12.5, color: brand.amber, lineHeight: 1.7 }}>
                文献库还是空的：先在「文献库」里检索或上传论文，这里会根据它们和你正在写的论文推荐可以问的问题。
              </Typography>
            ) : (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75, minHeight: 24 }}>
                  <Typography sx={{ fontSize: 12, color: brand.faint, flex: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    {sugLoading ? (
                      <>
                        <CircularProgress size={10} sx={{ color: brand.faint }} />
                        正在根据你的论文和文献库生成问题…
                      </>
                    ) : sugs?.length ? (
                      '根据你的论文和文献库推荐'
                    ) : (
                      '试试这些问题'
                    )}
                  </Typography>
                  {sugs && !sugLoading && (
                    <Tooltip title="换一批">
                      <IconButton aria-label="换一批" onClick={() => loadSugs(true)} sx={{ p: 0.25, color: brand.faint }}>
                        <AutorenewIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
                {(sugs?.length ? sugs : EXAMPLES.map((q) => ({ q, papers: [] }))).map((s) => (
                  <Card
                    key={s.q}
                    variant="dashed"
                    onClick={() => ask(s.q)}
                    sx={{
                      mb: 0.75, color: sugs?.length ? brand.ink : brand.muted, fontSize: 12.5, opacity: sugLoading && !sugs?.length ? 0.55 : 1,
                      animation: sugs?.length ? 'aria-fade-in .35s ease' : 'none',
                    }}
                  >
                    {s.q}
                    {s.papers.length > 0 && (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                        {s.papers.slice(0, 2).map((p) => {
                          const paper = citeStore.get().papers[p.id]
                          return (
                            <Tooltip key={p.id} title={paper?.title ?? p.short}>
                              <Box component="span" sx={{ fontSize: 11, color: brand.blue, bgcolor: 'rgba(0,120,212,0.07)', borderRadius: '4px', px: 0.6, lineHeight: '18px' }}>
                                {paper ? authorYearLabel(paper) : `${p.short}${p.year ? ` · ${p.year}` : ''}`}
                              </Box>
                            </Tooltip>
                          )
                        })}
                        {s.papers.length > 2 && <Box component="span" sx={{ fontSize: 11, color: brand.faint, lineHeight: '18px' }}>等 {s.papers.length} 篇</Box>}
                      </Box>
                    )}
                  </Card>
                ))}
                {sugError && <Typography sx={{ fontSize: 11.5, color: brand.faint }}>推荐问题生成失败，先用上面的通用示例。</Typography>}
              </>
            )}
          </Box>
        ) : (
          <Thread>
            {msgs.map((m, i) => (
              <Box key={i}>
                <ThreadItem icon={<PersonOutlineIcon />}>
                  <Card variant="user">{m.q}</Card>
                </ThreadItem>
                <ThreadItem icon={<AutoAwesomeOutlinedIcon sx={{ color: `${brand.blue} !important` }} />}>
                  <Box sx={{ pt: 0.25 }}>
                    {m.a ? (
                      <Typography sx={{ fontSize: 13.5, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{m.a}</Typography>
                    ) : (
                      <CircularProgress size={14} />
                    )}
                    {m.sources.length > 0 && (
                      <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        {m.sources.map((s) => (
                          <Tooltip key={s.n} title={s.snippet} placement="right">
                            <Card variant="data" sx={{ py: 0.4, px: 1, fontSize: 12 }}>
                              <Box sx={{ display: 'flex', gap: 0.75 }}>
                                <Box sx={{ color: brand.blue, fontWeight: 600 }}>[{s.n}]</Box>
                                <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {s.title}
                                  {s.page ? ` · p.${s.page}` : ''}
                                </Box>
                              </Box>
                            </Card>
                          </Tooltip>
                        ))}
                      </Box>
                    )}
                    {m.done && m.a && (
                      <Button size="small" startIcon={<NoteAddOutlinedIcon />} onClick={() => insertAnswer(m)} sx={{ mt: 0.75 }}>
                        插入到正文（带引用）
                      </Button>
                    )}
                  </Box>
                </ThreadItem>
              </Box>
            ))}
          </Thread>
        )}
      </Box>
      <Composer value={q} onChange={setQ} onSubmit={() => ask(q.trim())} busy={busy} placeholder="向文献库提问…" />
    </>
  )
}
