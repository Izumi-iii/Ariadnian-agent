import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { brand, shadow } from '../theme'

interface Heading {
  pos: number
  level: number
  text: string
  snippet: string
}

/** 1/2/3 级标题的短横线长度 */
const DASH_W: Record<number, number> = { 1: 22, 2: 15, 3: 9 }
const ROW_H = 14

/** 读出每个标题及其下面第一段正文的开头，用于悬停预览 */
function collect(editor: Editor): Heading[] {
  const out: Heading[] = []
  let cur: Heading | null = null
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      cur = { pos: offset, level: node.attrs.level, text: node.textContent.trim() || '（无标题）', snippet: '' }
      out.push(cur)
    } else if (cur && cur.snippet.length < 120) {
      const t = node.textContent.replace(/^写作要点[:：]\s*/, '').trim()
      if (t) cur.snippet = (cur.snippet ? `${cur.snippet} ` : '') + t
    }
  })
  return out
}

/**
 * 页边目录。
 *  - full：完整标题列表（宽屏）
 *  - mini：一列短横线（打开右侧抽屉或窗口较窄时）。1/2/3 级标题长度不同；
 *          当前章节高亮为蓝色，已读过的章节比未读的颜色深；
 *          鼠标移到横线上立即显示标题和正文开头，点击跳转。
 */
export function FloatingToc({ editor, mode, scrollEl }: { editor: Editor; mode: 'full' | 'mini'; scrollEl: HTMLElement | null }) {
  const [items, setItems] = useState<Heading[]>([])
  const [active, setActive] = useState(-1)
  const [hover, setHover] = useState<number | null>(null)
  const [rowH, setRowH] = useState(ROW_H)
  const itemsRef = useRef<Heading[]>([])

  // 文档变化后在下一帧重新收集（连续输入时只算一次）
  useEffect(() => {
    let raf = 0
    const run = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = collect(editor)
        itemsRef.current = next
        setItems(next)
      })
    }
    run()
    editor.on('update', run)
    return () => {
      editor.off('update', run)
      cancelAnimationFrame(raf)
    }
  }, [editor])

  // 当前章节：最后一个越过视口上方 1/4 处的标题（滚动时每帧最多算一次）
  const computeActive = useCallback(() => {
    if (!scrollEl) return
    const limit = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.25
    let cur = itemsRef.current.length ? 0 : -1
    for (let i = 0; i < itemsRef.current.length; i++) {
      const dom = editor.view.nodeDOM(itemsRef.current[i].pos) as HTMLElement | null
      if (!dom) continue
      if (dom.getBoundingClientRect().top <= limit) cur = i
      else break
    }
    setActive(cur)
  }, [editor, scrollEl])

  useEffect(() => {
    if (!scrollEl) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(computeActive)
    }
    computeActive()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [scrollEl, items, computeActive])

  // 标题很多时压缩行高，保证整列放得下
  useEffect(() => {
    if (!scrollEl) return
    const fit = () => setRowH(Math.max(6, Math.min(ROW_H, (scrollEl.clientHeight - 140) / Math.max(1, items.length))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl, items.length])

  const jump = (i: number) => {
    const h = items[i]
    if (!h) return
    const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
    if (dom && scrollEl) {
      const top = dom.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - 24
      scrollEl.scrollTo({ top, behavior: 'smooth' })
    }
    editor.commands.setTextSelection(h.pos + 1)
    setActive(i)
  }

  if (!items.length) return null

  if (mode === 'full') {
    return (
      <Box>
        <Typography sx={{ fontSize: 11.5, color: brand.faint, mb: 1 }}>目录</Typography>
        {items.map((h, i) => {
          const on = active === i
          return (
            <Box
              key={h.pos}
              onClick={() => jump(i)}
              sx={{
                display: 'flex', alignItems: 'center', cursor: 'pointer', py: 0.4, pl: 1 + (h.level - 1) * 1.25,
                borderLeft: `2px solid ${on ? brand.blue : i < active ? '#b8bcc4' : '#e6e6e6'}`, '&:hover .t': { color: brand.blue },
              }}
            >
              <Typography
                className="t"
                noWrap
                sx={{ fontSize: h.level === 1 ? 12.5 : 12, color: on ? brand.blue : i < active ? brand.muted : '#8a8a8a', fontWeight: on ? 500 : 400 }}
              >
                {h.text}
              </Typography>
            </Box>
          )
        })}
      </Box>
    )
  }

  const hv = hover !== null ? items[hover] : null
  return (
    <Box
      role="navigation"
      aria-label="大纲"
      onMouseLeave={() => setHover(null)}
      sx={{ position: 'relative', width: 32, py: 0.5, userSelect: 'none' }}
    >
      {items.map((h, i) => {
        const on = i === active
        const isHover = i === hover
        const color = on ? brand.blue : isHover ? brand.ink : i < active ? '#9aa0a8' : '#d6d6d6'
        return (
          <Box
            key={h.pos}
            onMouseEnter={() => setHover(i)}
            onClick={() => jump(i)}
            sx={{ height: rowH, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
          >
            <Box
              sx={{
                height: on ? 3 : 2,
                width: DASH_W[h.level] + (on ? 4 : 0) + (isHover ? 5 : 0),
                bgcolor: color,
                borderRadius: 2,
                transition: 'width 80ms ease-out, background-color 80ms linear',
              }}
            />
          </Box>
        )
      })}

      {/* 悬停预览：跟随鼠标所在的横线，位置变化用很短的过渡，扫过时依然跟手 */}
      {hv && (
        <Box
          sx={{
            position: 'absolute', left: 36, top: 0, width: 300, zIndex: 20, pointerEvents: 'none',
            transform: `translateY(${(hover ?? 0) * rowH + 4 + rowH / 2 - 26}px)`, transition: 'transform 70ms ease-out',
            bgcolor: '#fff', border: `1px solid ${brand.line}`, borderRadius: '10px', boxShadow: shadow.lg, px: 1.5, py: 1.1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600, color: brand.ink, flex: 1, minWidth: 0 }}>
              {hv.text}
            </Typography>
            {hover === active && (
              <Box sx={{ fontSize: 10.5, color: brand.blue, bgcolor: 'rgba(0,120,212,0.08)', px: 0.6, borderRadius: '3px', flexShrink: 0 }}>当前</Box>
            )}
          </Box>
          <Typography
            sx={{
              fontSize: 12, color: brand.muted, mt: 0.4, lineHeight: 1.55,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}
          >
            {hv.snippet || '这一节还没有正文'}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
