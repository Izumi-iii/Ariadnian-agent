/**
 * 检索预览：候选文献先看原文再决定。左边在线打开 PDF（还没入库的论文只是临时下载，不写进文献库），
 * 右边是正文里的论断、AI 的判断和原文里最相关的几段，点一段就跳到那一页并高亮。
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Dialog, IconButton, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined'
import { api, pdfFileUrl } from '../lib/api'
import { useApp, type PreviewAction } from '../lib/appContext'
import type { PdfHighlight, PdfPassage, PdfSource } from '../lib/types'
import { VerdictChip } from '../panels/CitePanel'
import { brand } from '../theme'
// pdf.js 体积较大，用到时才加载
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })))

export function PdfPreviewDialog() {
  const { preview, closePreview, notify } = useApp()
  const open = !!preview
  const paper = preview?.paper
  const src: PdfSource | null = useMemo(() => {
    if (!paper) return null
    if (paper.id && paper.has_pdf) return { paper_id: paper.id }
    if (paper.pdf_url) return { url: paper.pdf_url }
    return null
  }, [paper])
  const temporary = !!src?.url
  const claim = preview?.claim?.trim() ?? ''

  const [loadError, setLoadError] = useState<string | null>(null)
  const [passages, setPassages] = useState<PdfPassage[] | null>(null)
  const [active, setActive] = useState(0)
  const [hl, setHl] = useState<PdfHighlight | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    setLoadError(null)
    setPassages(null)
    setActive(0)
    setHl(null)
  }, [preview])

  // PDF 打开后，找出与论断最相关的几段
  const onLoaded = () => {
    if (!src || !claim) return
    api
      .pdfPassages(src, claim, 3)
      .then((r) => {
        setPassages(r.passages)
        if (r.passages[0]) jump(0, r.passages)
      })
      .catch(() => setPassages([]))
  }

  const jump = (i: number, list = passages) => {
    const p = list?.[i]
    if (!p || !src) return
    setActive(i)
    setHl({ page: p.page, rects: [] })
    api
      .pdfLocate(src, p.text, p.page, claim)
      .then(setHl)
      .catch(() => undefined)
  }

  const run = async (a: PreviewAction) => {
    setBusy(a.label)
    try {
      await a.onClick()
      closePreview()
    } catch (e: any) {
      notify(e.message ?? String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={closePreview}
      maxWidth={false}
      slotProps={{ paper: { sx: { width: 'min(1240px, 94vw)', height: '90vh', maxHeight: 980, display: 'flex', flexDirection: 'column', overflow: 'hidden' } } }}
    >
      {paper && (
        <>
          {/* 标题栏 */}
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 3, pt: 2, pb: 1.5, borderBottom: `1px solid ${brand.line}` }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{paper.title}</Typography>
              <Typography noWrap sx={{ fontSize: 12.5, color: brand.muted, mt: 0.25 }}>
                {paper.authors?.slice(0, 3).join(', ') || '佚名'}
                {(paper.authors?.length ?? 0) > 3 ? ' 等' : ''}
                {paper.venue ? ` · ${paper.venue}` : ''}
                {paper.year ? ` · ${paper.year}` : ''}
                {paper.arxiv_id ? ` · arXiv:${paper.arxiv_id}` : ''}
                {paper.citation_count != null ? ` · 被引 ${paper.citation_count}` : ''}
              </Typography>
            </Box>
            <IconButton aria-label="关闭" onClick={closePreview} sx={{ color: brand.faint }}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>

          <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* 原文 */}
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${brand.line}` }}>
              {src && !loadError ? (
                <Suspense fallback={<Box sx={{ flex: 1, bgcolor: '#ececec' }} />}>
        <PdfViewer
                  src={pdfFileUrl(src)}
                  highlight={hl}
                  jumpKey={active}
                  onLoaded={onLoaded}
                  onError={setLoadError}
                  badge={
                    temporary ? (
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 1, height: 22, borderRadius: 11, border: `1px solid ${brand.line}`, bgcolor: '#fff', color: brand.muted, fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        <CloudOutlinedIcon sx={{ fontSize: 14 }} /> 在线预览 · 未加入文献库
                      </Box>
                    ) : null
                  }
                />
                </Suspense>
              ) : (
                <NoPdf url={paper.url} error={loadError} abstract={paper.abstract} />
              )}
            </Box>

            {/* 右栏 */}
            <Box sx={{ width: 360, flexShrink: 0, overflow: 'auto', px: 2.5, py: 2 }}>
              {claim && (
                <>
                  <Label>你的论断</Label>
                  <Box sx={{ bgcolor: 'rgba(200,90,23,0.08)', border: '1px solid rgba(200,90,23,0.26)', borderRadius: '6px', px: 1.5, py: 1, fontSize: 13, lineHeight: 1.6, mb: 1.5 }}>
                    {claim}
                  </Box>
                </>
              )}
              {preview?.verdict && (
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
                  <VerdictChip v={preview.verdict} />
                  <Typography sx={{ fontSize: 12.5, color: brand.muted, lineHeight: 1.5 }}>{preview.reason ? `AI 判断：${preview.reason}` : ''}</Typography>
                </Box>
              )}
              {claim && src && !loadError && (
                <>
                  <Label>最相关的原文{passages ? `（${passages.length} 处）` : ''}</Label>
                  {!passages ? (
                    <Typography sx={{ fontSize: 12.5, color: brand.muted, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CircularProgress size={12} /> 正在原文中查找…
                    </Typography>
                  ) : passages.length === 0 ? (
                    <Typography sx={{ fontSize: 12.5, color: brand.muted }}>没有找到明显相关的段落。</Typography>
                  ) : (
                    passages.map((p, i) => (
                      <Box
                        key={i}
                        onClick={() => jump(i)}
                        sx={{
                          mb: 1, p: 1.25, borderRadius: '6px', cursor: 'pointer',
                          border: `1px solid ${i === active ? 'rgba(0,120,212,0.55)' : brand.line}`,
                          bgcolor: i === active ? 'rgba(0,120,212,0.06)' : '#fff',
                          '&:hover': { borderColor: 'rgba(0,120,212,0.55)' },
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                          <Box sx={{ fontSize: 11.5, fontWeight: 600, color: brand.blue, border: `1px solid ${brand.line}`, borderRadius: '4px', px: 0.75, bgcolor: '#fff' }}>
                            p.{p.page}
                          </Box>
                          <Typography noWrap sx={{ fontSize: 12, color: brand.muted }}>
                            {p.section ?? ''}
                          </Typography>
                        </Box>
                        <Typography sx={{ fontSize: 12, lineHeight: 1.6, fontFamily: '"Times New Roman", serif', fontStyle: 'italic', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {p.text}
                        </Typography>
                      </Box>
                    ))
                  )}
                </>
              )}
              {(!claim || !src || loadError) && paper.abstract && (
                <>
                  <Label>摘要</Label>
                  <Typography sx={{ fontSize: 12.5, lineHeight: 1.7 }}>{paper.abstract}</Typography>
                </>
              )}
            </Box>
          </Box>

          {/* 底部 */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 3, py: 1.5, borderTop: `1px solid ${brand.line}` }}>
            <Typography sx={{ fontSize: 12, color: brand.faint, flex: 1 }}>
              {temporary ? '预览只是临时下载；加入文献库时才会保存并解析全文。' : ''}
            </Typography>
            <Button variant="outlined" onClick={closePreview}>
              关闭
            </Button>
            {preview?.actions?.map((a) => (
              <Button
                key={a.label}
                variant={a.primary ? 'contained' : 'outlined'}
                disabled={!!busy}
                onClick={() => run(a)}
                startIcon={busy === a.label ? <CircularProgress size={12} color="inherit" /> : undefined}
              >
                {a.label}
              </Button>
            ))}
          </Box>
        </>
      )}
    </Dialog>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <Typography sx={{ fontSize: 12, color: brand.faint, mb: 0.75 }}>{children}</Typography>
}

function NoPdf({ url, error, abstract }: { url?: string | null; error: string | null; abstract?: string | null }) {
  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3, bgcolor: brand.subtle }}>
      <Typography sx={{ fontSize: 14, fontWeight: 500, mb: 0.5 }}>{error ? '原文没能打开' : '没有开放获取的 PDF'}</Typography>
      <Typography sx={{ fontSize: 12.5, color: brand.muted, mb: 2 }}>
        {error ?? '可以去出版商页面查看，或者加入文献库后手动上传 PDF。'}
      </Typography>
      {url && (
        <Button variant="outlined" component="a" href={url} target="_blank" rel="noreferrer" sx={{ mb: 3 }}>
          在出版商页面打开 ↗
        </Button>
      )}
      {abstract && (
        <>
          <Typography sx={{ fontSize: 12, color: brand.faint, mb: 0.5 }}>摘要</Typography>
          <Typography sx={{ fontSize: 13, lineHeight: 1.75, maxWidth: 720 }}>{abstract}</Typography>
        </>
      )}
    </Box>
  )
}
