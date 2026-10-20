import { useEffect, useState } from 'react'
import { Box, Button, Checkbox, Chip, CircularProgress, Typography } from '@mui/material'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import FormatQuoteIcon from '@mui/icons-material/FormatQuote'
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined'
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined'
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined'
import { ReadSourceButton } from './ReaderPanel'
import { api } from '../lib/api'
import { useApp } from '../lib/appContext'
import { citeStore, formatInline } from '../lib/citations'
import { collectCitationContexts } from '../lib/editorText'
import type { CiteCandidate } from '../lib/types'
import { Card, Composer, SectionLabel, Thread, ThreadItem } from '../components/Thread'
import { brand } from '../theme'

export const VERDICT: Record<string, { label: string; color: string; bg: string }> = {
  supports: { label: '支持', color: brand.green, bg: 'rgba(46,125,50,0.10)' },
  partial: { label: '部分支持', color: brand.amber, bg: 'rgba(183,121,31,0.12)' },
  unrelated: { label: '不相关', color: brand.muted, bg: 'rgba(0,0,0,0.06)' },
  unknown: { label: '未判断', color: brand.muted, bg: 'rgba(0,0,0,0.06)' },
  missing: { label: '文献缺失', color: brand.red, bg: 'rgba(164,38,44,0.10)' },
}

export function VerdictChip({ v }: { v?: string }) {
  const s = VERDICT[v ?? 'unknown'] ?? VERDICT.unknown
  return <Chip size="small" label={s.label} sx={{ height: 20, fontSize: 11, color: s.color, bgcolor: s.bg, flexShrink: 0 }} />
}

interface CheckRow {
  pos: number
  sentence: string
  paperId: string
  verdict: string
  reason: string
  snippet?: string
  page?: number | null
}

export function CitePanel() {
  const { citeRequest, editor, notify, openReader, openPreview } = useApp()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [cands, setCands] = useState<CiteCandidate[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<CheckRow[] | null>(null)

  const find = async (s: string, at: number | null) => {
    const clean = s.replace(/\[@[^\]]*\]/g, '').trim()
    if (!clean) return
    setQuery(clean)
    setInsertAt(at)
    setLoading(true)
    setCands(null)
    setPicked([])
    try {
      const r = await api.cite(clean, 5)
      setCands(r.candidates)
      setPicked(r.candidates.filter((c) => c.verdict === 'supports').map((c) => c.paper.id))
    } catch (e: any) {
      notify(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (citeRequest) find(citeRequest.sentence, citeRequest.insertAt)
  }, [citeRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  const insert = () => {
    if (!editor || !picked.length) return
    let pos = Math.min(insertAt ?? editor.state.selection.to, editor.state.doc.content.size)
    const prev = editor.state.doc.textBetween(Math.max(0, pos - 1), pos)
    if (/[。．.!?！？]/.test(prev)) pos -= 1 // 句末标点前插入：……结论[1]。
    editor.chain().focus().insertContentAt(pos, { type: 'citation', attrs: { ids: picked } }).run()
    notify(`已插入引用 ${formatInline(picked, citeStore.get())}`, 'success')
    setInsertAt(null)
  }

  const checkAll = async () => {
    if (!editor) return
    const ctxs = collectCitationContexts(editor)
    if (!ctxs.length) return notify('正文里还没有引用', 'info')
    setChecking(true)
    setChecks([])
    const rows: CheckRow[] = []
    for (const c of ctxs) {
      try {
        const r = await api.verify(c.sentence, c.ids)
        for (const x of r.results)
          rows.push({ pos: c.pos, sentence: c.sentence, paperId: x.paper_id, verdict: x.verdict, reason: x.reason, snippet: x.snippet, page: x.page })
        setChecks([...rows])
      } catch (e: any) {
        notify(e.message, 'error')
        break
      }
    }
    setChecking(false)
  }

  const papers = citeStore.get().papers
  const order: Record<string, number> = { unrelated: 0, missing: 0, partial: 1, unknown: 2, supports: 3 }
  const okCount = checks?.filter((c) => c.verdict === 'supports').length ?? 0

  return (
    <>
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pt: 1 }}>
        <Card variant="dashed" onClick={checking ? undefined : checkAll} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, color: brand.muted }}>
          {checking ? <CircularProgress size={14} /> : <FactCheckOutlinedIcon sx={{ fontSize: 17 }} />}
          <Box sx={{ flex: 1 }}>
            <Box sx={{ color: brand.ink, fontSize: 13 }}>核查全文引用</Box>
            <Box sx={{ fontSize: 11.5 }}>逐条检查：被引文献的原文是否真的支撑引用它的那句话</Box>
          </Box>
        </Card>

        {checks && checks.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <SectionLabel>
              核查结果 · 共 {checks.length} 处，支持 {okCount}，需关注 {checks.length - okCount}
            </SectionLabel>
            {[...checks]
              .sort((a, b) => (order[a.verdict] ?? 2) - (order[b.verdict] ?? 2))
              .map((c, i) => (
                <Card key={i} onClick={() => editor?.chain().focus().setNodeSelection(c.pos).scrollIntoView().run()} sx={{ mb: 0.75 }}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <VerdictChip v={c.verdict} />
                    <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 500 }}>
                      {papers[c.paperId]?.title ?? c.paperId}
                    </Typography>
                  </Box>
                  <Typography sx={{ fontSize: 12, mt: 0.5 }}>“{c.sentence.slice(0, 120)}”</Typography>
                  <Typography sx={{ fontSize: 11.5, color: brand.muted }}>{c.reason}</Typography>
                  {(c.snippet || c.page) && (
                    <Box sx={{ mt: 0.5 }}>
                      <ReadSourceButton
                        paperId={c.paperId}
                        page={c.page}
                        onClick={() =>
                          openReader({ paperId: c.paperId, claim: c.sentence, evidences: [{ page: c.page, snippet: c.snippet, verdict: c.verdict, reason: c.reason }] })
                        }
                      />
                    </Box>
                  )}
                </Card>
              ))}
          </Box>
        )}

        {query ? (
          <Thread>
            <ThreadItem icon={<PersonOutlineIcon />}>
              <Card variant="user">{query}</Card>
            </ThreadItem>
            {loading && (
              <ThreadItem>
                <Typography sx={{ fontSize: 12.5, color: brand.muted, display: 'flex', alignItems: 'center', gap: 1, pt: 0.25 }}>
                  <CircularProgress size={12} /> 正在检索文献库并逐篇判断…
                </Typography>
              </ThreadItem>
            )}
            {cands?.map((c) => (
              <ThreadItem key={c.paper.id} icon={<MenuBookOutlinedIcon />}>
                <Card variant={picked.includes(c.paper.id) ? 'data' : 'plain'} sx={{ display: 'flex', gap: 0.5, pl: 0.5 }}>
                  <Checkbox
                    size="small"
                    checked={picked.includes(c.paper.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, c.paper.id] : picked.filter((x) => x !== c.paper.id))}
                    sx={{ p: 0.5, alignSelf: 'flex-start' }}
                  />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <VerdictChip v={c.verdict} />
                      <Typography noWrap sx={{ fontSize: 13, fontWeight: 500 }}>
                        {c.paper.title}
                      </Typography>
                    </Box>
                    {c.reason && <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.25 }}>{c.reason}</Typography>}
                    <Typography
                      sx={{ mt: 0.75, fontSize: 12, lineHeight: 1.6, color: brand.ink, pl: 1, borderLeft: `2px solid rgba(0,120,212,0.35)`, maxHeight: 92, overflow: 'auto' }}
                    >
                      <Box component="span" sx={{ color: brand.muted }}>
                        {c.section ? `${c.section} · ` : ''}
                        {c.page ? `p.${c.page} · ` : ''}
                      </Box>
                      {c.snippet}
                    </Typography>
                    {(c.paper.has_pdf || c.paper.pdf_url) && (
                      <Box sx={{ display: 'flex', gap: 0.75, mt: 0.75 }}>
                        <Button
                          size="small"
                          startIcon={<PictureAsPdfOutlinedIcon sx={{ fontSize: '14px !important' }} />}
                          sx={{ py: 0, px: 1, minHeight: 24, fontSize: 12, bgcolor: 'rgba(0,120,212,0.07)', '&:hover': { bgcolor: 'rgba(0,120,212,0.13)' } }}
                          onClick={() =>
                            openPreview({
                              paper: c.paper, claim: query, verdict: c.verdict, reason: c.reason,
                              actions: [
                                {
                                  label: '在侧栏阅读',
                                  onClick: () =>
                                    openReader({
                                      paperId: c.paper.id, claim: query, insertAt,
                                      evidences: [{ page: c.page, snippet: c.snippet, section: c.section, verdict: c.verdict, reason: c.reason }],
                                    }),
                                },
                                ...(editor
                                  ? [{
                                      label: `插入引用 ${formatInline([c.paper.id], citeStore.get())}`, primary: true,
                                      onClick: () => {
                                        let pos = Math.min(insertAt ?? editor.state.selection.to, editor.state.doc.content.size)
                                        if (/[。．.!?！？]/.test(editor.state.doc.textBetween(Math.max(0, pos - 1), pos))) pos -= 1
                                        editor.chain().focus().insertContentAt(pos, { type: 'citation', attrs: { ids: [c.paper.id] } }).run()
                                        notify('已插入引用', 'success')
                                      },
                                    }]
                                  : []),
                              ],
                            })
                          }
                        >
                          预览 PDF
                        </Button>
                      </Box>
                    )}
                  </Box>
                </Card>
              </ThreadItem>
            ))}
            {cands && cands.length > 0 && (
              <ThreadItem icon={<FormatQuoteIcon />}>
                <Button variant="contained" fullWidth disabled={!picked.length || !editor} onClick={insert}>
                  插入所选 {picked.length} 篇的引用{insertAt == null ? '（到光标处）' : ''}
                </Button>
              </ThreadItem>
            )}
            {cands && cands.length === 0 && (
              <ThreadItem>
                <Card sx={{ color: brand.muted, fontSize: 12.5 }}>文献库里没有找到相关内容。可以先在「文献库」里检索或上传相关论文（最好带全文）。</Card>
              </ThreadItem>
            )}
          </Thread>
        ) : (
          !checks && (
            <Typography sx={{ fontSize: 13, color: brand.muted, lineHeight: 1.7 }}>
              在正文中选中一句话点「找引用」，或在下面粘贴一句论断。系统会在文献库里检索能支撑它的原文片段，并逐篇判断是否真的支持。
            </Typography>
          )
        )}
      </Box>
      <Composer
        value={input}
        onChange={setInput}
        onSubmit={() => {
          find(input, null)
          setInput('')
        }}
        busy={loading}
        placeholder="粘贴一句论断，查找能支撑它的文献…"
      />
    </>
  )
}
