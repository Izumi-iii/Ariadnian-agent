/**
 * PDF 阅读器（pdf.js）：逐页画到 canvas，上面叠透明文本层（可选中复制）和高亮层。
 * 只渲染滚动到附近的页面，长论文也不卡；缩放默认「适应宽度」，随抽屉宽度变化。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Box, CircularProgress, IconButton, InputBase, Tooltip, Typography } from '@mui/material'
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore'
import NavigateNextIcon from '@mui/icons-material/NavigateNext'
import RemoveIcon from '@mui/icons-material/Remove'
import AddIcon from '@mui/icons-material/Add'
import FitScreenOutlinedIcon from '@mui/icons-material/FitScreenOutlined'
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
// 用 legacy 构建：带 polyfill，较旧的浏览器（以及 Electron）也能用；正式构建依赖很新的 JS 特性
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { PdfHighlight } from '../lib/types'
import { brand } from '../theme'
import './pdf.css'

GlobalWorkerOptions.workerSrc = workerSrc

const GAP = 12 // 页与页之间的间距
const PAD = 16 // 左右留白
const HL = 'rgba(255, 213, 0, 0.42)'

interface Size {
  w: number
  h: number
}

export interface PdfViewerProps {
  src: string
  /** 打开后跳到这一页（从 1 开始） */
  page?: number | null
  highlight?: PdfHighlight | null
  /** 变化时重新滚动到 page / highlight（同一处依据再点一次也能跳回去） */
  jumpKey?: number | string
  /** 工具栏左侧的额外内容，比如「在线预览」标记 */
  badge?: ReactNode
  onError?: (msg: string) => void
  onLoaded?: (pages: number) => void
}

export function PdfViewer({ src, page, highlight, jumpKey, badge, onError, onLoaded }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageEls = useRef(new Map<number, HTMLDivElement>())
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<Size[]>([])
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [current, setCurrent] = useState(1)
  const [pageInput, setPageInput] = useState('1')

  // ---------------------------------------------------------------- 加载文档
  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setSizes([])
    setError(null)
    // 先自己请求文件：后端出错时（下载失败、不是 PDF、地址被拦截）能拿到具体原因
    let task: ReturnType<typeof getDocument> | null = null
    ;(async () => {
      try {
        const res = await fetch(src, { credentials: 'same-origin' })
        if (!res.ok) {
          let detail = `${res.status} ${res.statusText}`
          try {
            detail = (await res.json()).detail ?? detail
          } catch {
            /* 不是 JSON */
          }
          throw new Error(detail)
        }
        const data = new Uint8Array(await res.arrayBuffer())
        if (cancelled) return
        task = getDocument({ data })
        const d = await task.promise
        // 先拿到每一页的尺寸（不渲染），用来排版和计算滚动位置
        const ss: Size[] = []
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 })
          ss.push({ w: vp.width, h: vp.height })
        }
        if (cancelled) return
        setSizes(ss)
        setDoc(d)
        onLoaded?.(d.numPages)
      } catch (e: any) {
        if (cancelled) return
        const msg = String(e?.message ?? e)
        setError(msg)
        onError?.(msg)
      }
    })()
    return () => {
      cancelled = true
      task?.destroy()
    }
  }, [src]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- 宽度与缩放
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const maxW = sizes.reduce((m, s) => Math.max(m, s.w), 0) || 612
  const fitScale = width ? Math.max(0.3, (width - PAD * 2) / maxW) : 1
  const scale = zoom === 'fit' ? fitScale : zoom
  const setScale = (s: number) => setZoom(Math.min(4, Math.max(0.3, Math.round(s * 100) / 100)))

  // ---------------------------------------------------------------- 跳转
  const scrollToPage = useCallback(
    (n: number, yFrac = 0, smooth = true) => {
      const el = pageEls.current.get(n)
      const box = scrollRef.current
      if (!el || !box) return
      box.scrollTo({ top: Math.max(0, el.offsetTop - GAP + yFrac * el.offsetHeight - (yFrac ? 90 : 0)), behavior: smooth ? 'smooth' : 'auto' })
    },
    [],
  )

  useEffect(() => {
    if (!doc || !sizes.length) return
    const target = highlight?.page ?? page
    if (!target) return
    const y = highlight?.rects?.length ? Math.min(...highlight.rects.map((r) => r[1])) : 0
    // 等布局（缩放后的高度）生效再滚
    const t = window.setTimeout(() => scrollToPage(Math.min(Math.max(1, target), sizes.length), y), 60)
    return () => window.clearTimeout(t)
  }, [doc, sizes.length, page, highlight, jumpKey, scrollToPage]) // eslint-disable-line react-hooks/exhaustive-deps

  // 缩放时保持当前页在视野里
  const prevScale = useRef(scale)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box && prevScale.current !== scale && prevScale.current > 0) {
      box.scrollTop = box.scrollTop * (scale / prevScale.current)
    }
    prevScale.current = scale
  }, [scale])

  const onScroll = () => {
    const box = scrollRef.current
    if (!box) return
    const mid = box.scrollTop + box.clientHeight / 3
    let n = 1
    for (const [k, el] of pageEls.current) if (el.offsetTop <= mid && k > n) n = k
    if (n !== current) {
      setCurrent(n)
      setPageInput(String(n))
    }
  }

  const go = (n: number) => {
    const t = Math.min(Math.max(1, n), sizes.length || 1)
    setCurrent(t)
    setPageInput(String(t))
    scrollToPage(t)
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: '#ececec' }}>
      {/* 工具栏 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 0.75, height: 38, flexShrink: 0, bgcolor: '#fafafa', borderBottom: `1px solid ${brand.line}` }}>
        <IconButton aria-label="上一页" onClick={() => go(current - 1)} disabled={current <= 1}>
          <NavigateBeforeIcon fontSize="small" />
        </IconButton>
        <Box sx={{ display: 'flex', alignItems: 'center', border: `1px solid ${brand.line}`, borderRadius: '4px', bgcolor: '#fff', px: 0.75, height: 24 }}>
          <InputBase
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && go(Number(pageInput) || 1)}
            onBlur={() => setPageInput(String(current))}
            inputProps={{ 'aria-label': '页码', style: { width: `${Math.max(1, pageInput.length)}ch`, textAlign: 'right', padding: 0, fontSize: 12 } }}
          />
          <Typography sx={{ fontSize: 12, color: brand.muted, ml: 0.5 }}>/ {sizes.length || '–'}</Typography>
        </Box>
        <IconButton aria-label="下一页" onClick={() => go(current + 1)} disabled={!sizes.length || current >= sizes.length}>
          <NavigateNextIcon fontSize="small" />
        </IconButton>
        <Box sx={{ ml: 1, minWidth: 0, overflow: 'hidden' }}>{badge}</Box>
        <Box sx={{ flex: 1 }} />
        <IconButton aria-label="缩小" onClick={() => setScale(scale / 1.15)}>
          <RemoveIcon fontSize="small" />
        </IconButton>
        <Typography sx={{ fontSize: 12, width: 40, textAlign: 'center', color: brand.ink }}>{Math.round(scale * 100)}%</Typography>
        <IconButton aria-label="放大" onClick={() => setScale(scale * 1.15)}>
          <AddIcon fontSize="small" />
        </IconButton>
        <Tooltip title="适应宽度">
          <IconButton aria-label="适应宽度" onClick={() => setZoom('fit')} sx={{ color: zoom === 'fit' ? brand.blue : undefined }}>
            <FitScreenOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="下载 PDF">
          <IconButton aria-label="下载 PDF" component="a" href={src} download>
            <FileDownloadOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="在新标签页打开">
          <IconButton aria-label="在新标签页打开" component="a" href={`${src}#page=${current}`} target="_blank" rel="noreferrer">
            <OpenInNewIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* 页面 */}
      <Box ref={scrollRef} onScroll={onScroll} sx={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {error ? (
          <Typography sx={{ p: 3, fontSize: 13, color: brand.muted }}>{error}</Typography>
        ) : !doc ? (
          <Box sx={{ p: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, color: brand.muted, fontSize: 13 }}>
            <CircularProgress size={16} /> 正在打开 PDF…
          </Box>
        ) : (
          <Box sx={{ py: `${GAP}px`, px: `${PAD}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${GAP}px`, minWidth: 'fit-content' }}>
            {sizes.map((s, i) => (
              <PageView
                key={i}
                doc={doc}
                num={i + 1}
                size={s}
                scale={scale}
                root={scrollRef}
                rects={highlight && highlight.page === i + 1 ? highlight.rects : null}
                flashKey={jumpKey}
                register={(el) => (el ? pageEls.current.set(i + 1, el) : pageEls.current.delete(i + 1))}
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

// ------------------------------------------------------------------ 单页
const PageView = memo(function PageView({
  doc, num, size, scale, root, rects, flashKey, register,
}: {
  doc: PDFDocumentProxy
  num: number
  size: Size
  scale: number
  root: React.RefObject<HTMLDivElement | null>
  rects: number[][] | null
  flashKey?: number | string
  register: (el: HTMLDivElement | null) => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [rendered, setRendered] = useState(false)

  // 滚动到附近（上下 1.5 屏）才渲染
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: root.current, rootMargin: '150% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!visible) return
    let task: RenderTask | null = null
    let text: TextLayer | null = null
    let cancelled = false
    ;(async () => {
      const page = await doc.getPage(num)
      if (cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      const vp = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      try {
        await task.promise
      } catch {
        return // 被取消（缩放、滚走）
      }
      if (cancelled) return
      setRendered(true)
      const tl = textRef.current
      if (!tl) return
      tl.replaceChildren()
      text = new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp })
      await text.render().catch(() => undefined)
    })()
    return () => {
      cancelled = true
      task?.cancel()
      text?.cancel()
    }
  }, [visible, doc, num, scale])

  const w = Math.floor(size.w * scale)
  const h = Math.floor(size.h * scale)
  return (
    <Box
      ref={(el: HTMLDivElement | null) => {
        boxRef.current = el
        register(el)
      }}
      className="aria-pdf-page"
      data-page={num}
      style={{ ['--total-scale-factor' as any]: scale }}
      sx={{ position: 'relative', width: w, height: h, bgcolor: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.18)', flexShrink: 0 }}
    >
      <canvas ref={canvasRef} style={{ width: w, height: h, display: 'block' }} />
      {!rendered && (
        <Typography sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: brand.faint }}>
          第 {num} 页
        </Typography>
      )}
      {rects?.map((r, i) => (
        <Box
          key={`${flashKey}-${i}`}
          sx={{
            position: 'absolute', zIndex: 1, pointerEvents: 'none', borderRadius: '2px', bgcolor: HL, mixBlendMode: 'multiply',
            left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%`,
            animation: 'aria-pdf-flash 1.2s ease-out',
          }}
        />
      ))}
      {rects && rects.length > 0 && (
        <Box
          sx={{
            position: 'absolute', left: -9, width: 4, borderRadius: 2, bgcolor: '#f5b400', zIndex: 1,
            top: `${Math.min(...rects.map((r) => r[1])) * 100}%`,
            height: `${(Math.max(...rects.map((r) => r[3])) - Math.min(...rects.map((r) => r[1]))) * 100}%`,
          }}
        />
      )}
      <div ref={textRef} className="textLayer" />
    </Box>
  )
})
