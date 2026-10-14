import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useApp } from '../lib/appContext'
import { Card, SectionLabel } from '../components/Thread'
import { brand } from '../theme'

interface Heading {
  pos: number
  level: number
  text: string
  chars: number
  cites: number
}

/** 文档大纲：按标题切分，显示每节字数和引用数，点击跳转 */
export function OutlinePanel() {
  const { editor } = useApp()
  const [items, setItems] = useState<Heading[]>([])
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    if (!editor) return
    const compute = () => {
      const out: Heading[] = []
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'heading') {
          out.push({ pos: offset, level: node.attrs.level, text: node.textContent || '（无标题）', chars: 0, cites: 0 })
        } else if (out.length) {
          const cur = out[out.length - 1]
          cur.chars += node.textContent.replace(/\s/g, '').length
          node.descendants((n) => {
            if (n.type.name === 'citation') cur.cites += 1
          })
        }
      })
      setItems(out)
      const sel = editor.state.selection.from
      setActive(out.filter((h) => h.pos <= sel).pop()?.pos ?? null)
    }
    compute()
    editor.on('update', compute)
    editor.on('selectionUpdate', compute)
    return () => {
      editor.off('update', compute)
      editor.off('selectionUpdate', compute)
    }
  }, [editor])

  const jump = (pos: number) => {
    if (!editor) return
    editor.chain().focus().setTextSelection(pos + 1).run()
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null
    dom?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const total = items.reduce((a, h) => a + h.chars, 0)

  return (
    <Box sx={{ height: '100%', overflow: 'auto', px: 2, pt: 1.75, pb: 2 }}>
      <SectionLabel>
        大纲 · {items.length} 节 · 正文约 {total} 字
      </SectionLabel>
      {!items.length && (
        <Typography sx={{ fontSize: 12.5, color: brand.muted, lineHeight: 1.7 }}>
          文档里还没有标题。用工具栏的 H1 / H2 添加章节，或者让综述 Agent 生成大纲。
        </Typography>
      )}
      <Box sx={{ position: 'relative', '&::before': { content: '""', position: 'absolute', left: 11, top: 8, bottom: 8, width: '1px', bgcolor: 'rgba(0,0,0,0.09)' } }}>
        {items.map((h) => (
          <Box key={h.pos} sx={{ display: 'flex', gap: 1, mb: 0.75, pl: (h.level - 1) * 2 }}>
            <Box sx={{ width: 23, flexShrink: 0, display: 'flex', justifyContent: 'center', pt: '13px' }}>
              <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: active === h.pos ? brand.blue : '#c8c8c8', border: '2px solid #fff', boxSizing: 'content-box' }} />
            </Box>
            <Card variant={active === h.pos ? 'data' : 'plain'} onClick={() => jump(h.pos)} sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: h.level === 1 ? 13.5 : 13, fontWeight: h.level === 1 ? 600 : 400 }}>
                {h.text}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                <Box sx={{ flex: 1, height: 3, bgcolor: 'rgba(0,0,0,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                  <Box sx={{ width: `${Math.min(100, (h.chars / Math.max(800, ...items.map((x) => x.chars))) * 100)}%`, height: '100%', bgcolor: 'rgba(0,120,212,0.45)' }} />
                </Box>
                <Typography sx={{ fontSize: 11, color: brand.muted, whiteSpace: 'nowrap' }}>
                  {h.chars} 字 · {h.cites} 处引用
                </Typography>
              </Box>
            </Card>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
