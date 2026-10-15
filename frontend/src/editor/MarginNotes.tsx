import type { Editor } from '@tiptap/core'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Box, Button, Typography } from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import FormatQuoteIcon from '@mui/icons-material/FormatQuote'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import { useApp } from '../lib/appContext'
import { authorYearLabel, citeStore } from '../lib/citations'
import type { PlacedAnnotation } from '../lib/review'
import { VerdictChip } from '../panels/CitePanel'
import { brand, card, shadow } from '../theme'
import { DiffView } from './DiffView'

const GAP = 8

function Quote({ text }: { text: string }) {
  return (
    <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      “{text}”
    </Typography>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return <Box sx={{ display: 'flex', gap: 0.5, mt: 1, alignItems: 'center', '& .MuiButton-root': { py: 0.1, px: 1, fontSize: 12 } }}>{children}</Box>
}

function NoteCard({
  a, editor, active, onHover, onDismiss,
}: {
  a: PlacedAnnotation
  editor: Editor
  active: boolean
  onHover: (k: string | null) => void
  onDismiss: () => void
}) {
  const { requestCitations, notify } = useApp()
  const papers = citeStore.get().papers
  const insertCite = (paperId: string) => {
    editor.chain().focus().insertContentAt(a.insertAt, { type: 'citation', attrs: { ids: [paperId] } }).run()
    notify('已插入引用', 'success')
  }
  const kind = a.kind === 'missing_citation' ? card.agent : a.kind === 'rewrite' ? card.plain : card.plain
  const accent =
    a.kind === 'missing_citation' ? brand.purple : a.kind === 'rewrite' ? brand.blue : a.kind === 'cite_check' && a.items.some((i) => i.verdict === 'unrelated' || i.verdict === 'missing') ? brand.red : brand.amber

  return (
    <Box
      onMouseEnter={() => onHover(a.key)}
      onMouseLeave={() => onHover(null)}
      sx={{
        ...kind, borderLeft: `3px solid ${accent}`, borderRadius: '6px', px: 1.25, py: 1, fontSize: 12.5, bgcolor: kind.bgcolor,
        boxShadow: active ? shadow.lg : 'none', transition: 'box-shadow .15s, transform .15s', transform: active ? 'translateX(-3px)' : 'none',
      }}
    >
      {a.kind === 'missing_citation' && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <FormatQuoteIcon sx={{ fontSize: 15, color: brand.purple }} />
            <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.purple }}>这句话缺少引用</Typography>
          </Box>
          <Quote text={a.anchor} />
          {a.candidates.length ? (
            a.candidates.map((c) => (
              <Box key={c.paper_id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}>
                <VerdictChip v={c.verdict} />
                <Typography noWrap sx={{ fontSize: 12, flex: 1, minWidth: 0 }} title={c.title}>
                  {papers[c.paper_id] ? authorYearLabel(papers[c.paper_id]) : c.title}
                </Typography>
                <Button size="small" variant="contained" onClick={() => insertCite(c.paper_id)} sx={{ py: 0, minHeight: 22, fontSize: 11.5 }}>
                  插入
                </Button>
              </Box>
            ))
          ) : (
            <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.5 }}>文献库里没有找到能支撑它的文献</Typography>
          )}
          <Actions>
            {!a.candidates.length && <Button onClick={() => requestCitations(a.anchor, a.insertAt)}>去检索</Button>}
            <Button onClick={onDismiss} sx={{ color: brand.muted }}>
              忽略
            </Button>
          </Actions>
        </>
      )}

      {a.kind === 'cite_check' && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ReportProblemOutlinedIcon sx={{ fontSize: 15, color: accent }} />
            <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: accent }}>引用可能撑不起这句话</Typography>
          </Box>
          <Quote text={a.anchor} />
          {a.items
            .filter((i) => i.verdict !== 'supports')
            .map((i) => (
              <Box key={i.bibkey} sx={{ mt: 0.75 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <VerdictChip v={i.verdict} />
                  <Typography noWrap sx={{ fontSize: 12, fontWeight: 500 }} title={i.title}>
                    {i.paper_id && papers[i.paper_id] ? authorYearLabel(papers[i.paper_id]) : i.bibkey}
                  </Typography>
                </Box>
                {i.reason && <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.25 }}>{i.reason}</Typography>}
              </Box>
            ))}
          <Actions>
            <Button onClick={() => requestCitations(a.anchor, a.insertAt)}>换一篇</Button>
            <Button onClick={onDismiss} sx={{ color: brand.muted }}>
              忽略
            </Button>
          </Actions>
        </>
      )}

      {a.kind === 'rewrite' && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <AutoFixHighIcon sx={{ fontSize: 15, color: brand.blue }} />
            <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>可以更简洁</Typography>
            {a.reason && <Typography sx={{ fontSize: 11.5, color: brand.muted, ml: 0.5 }}>· {a.reason}</Typography>}
          </Box>
          <Box sx={{ mt: 0.5, '& > div': { fontSize: '12.5px !important', lineHeight: '1.65 !important' } }}>
            <DiffView before={a.anchor} after={a.revised} />
          </Box>
          <Actions>
            <Button
              variant="contained"
              onClick={() => {
                if (editor.state.doc.textBetween(a.from, a.to) !== a.anchor) return notify('原文已经改动，请等它重新检查', 'warning')
                editor.chain().focus().insertContentAt({ from: a.from, to: a.to }, a.revised).run()
              }}
            >
              接受
            </Button>
            <Button onClick={onDismiss} sx={{ color: brand.muted }}>
              忽略
            </Button>
          </Actions>
        </>
      )}
    </Box>
  )
}

/** 页边批注列：卡片与对应句子顶端对齐，互相重叠时依次下推 */
export function MarginNotes({
  editor, notes, active, setActive, onDismiss, columnRef,
}: {
  editor: Editor
  notes: PlacedAnnotation[]
  active: string | null
  setActive: (k: string | null) => void
  onDismiss: (k: string) => void
  columnRef: RefObject<HTMLDivElement | null>
}) {
  const refs = useRef(new Map<string, HTMLDivElement>())
  const [tops, setTops] = useState<Record<string, number>>({})
  const [tick, setTick] = useState(0)

  useLayoutEffect(() => {
    const bump = () => setTick((t) => t + 1)
    editor.on('update', bump)
    const ro = new ResizeObserver(bump)
    if (columnRef.current) ro.observe(columnRef.current)
    return () => {
      editor.off('update', bump)
      ro.disconnect()
    }
  }, [editor, columnRef])

  useLayoutEffect(() => {
    const col = columnRef.current
    if (!col) return
    const base = col.getBoundingClientRect().top
    const next: Record<string, number> = {}
    let bottom = -Infinity
    for (const n of notes) {
      let want = 0
      try {
        want = editor.view.coordsAtPos(Math.min(n.from, editor.state.doc.content.size)).top - base - 4
      } catch {
        continue
      }
      const top = Math.max(want, bottom + GAP)
      next[n.key] = top
      bottom = top + (refs.current.get(n.key)?.offsetHeight ?? 90)
    }
    const changed = Object.keys(next).length !== Object.keys(tops).length || Object.entries(next).some(([k, v]) => Math.abs((tops[k] ?? -1) - v) > 0.5)
    if (changed) setTops(next)
  }, [notes, tick, editor, columnRef, tops])

  return (
    <Box ref={columnRef} sx={{ position: 'relative', minHeight: '100%' }}>
      {notes.map((n) => (
        <Box
          key={n.key}
          ref={(el: HTMLDivElement | null) => {
            if (el) refs.current.set(n.key, el)
            else refs.current.delete(n.key)
          }}
          sx={{ position: 'absolute', left: 0, right: 0, top: tops[n.key] ?? 0, opacity: n.key in tops ? 1 : 0, transition: 'top .18s ease, opacity .2s' }}
        >
          <NoteCard a={n} editor={editor} active={active === n.key} onHover={setActive} onDismiss={() => onDismiss(n.key)} />
        </Box>
      ))}
    </Box>
  )
}
