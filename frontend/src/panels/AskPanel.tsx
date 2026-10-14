import { useRef, useState } from 'react'
import { Box, Button, CircularProgress, Tooltip, Typography } from '@mui/material'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import NoteAddOutlinedIcon from '@mui/icons-material/NoteAddOutlined'
import { streamSSE } from '../lib/api'
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

export function AskPanel() {
  const { editor, notify } = useApp()
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
            {EXAMPLES.map((ex) => (
              <Card key={ex} variant="dashed" onClick={() => ask(ex)} sx={{ mb: 0.75, color: brand.muted, fontSize: 12.5 }}>
                {ex}
              </Card>
            ))}
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
