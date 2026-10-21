import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Box, Paper as MuiPaper, Typography } from '@mui/material'
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined'
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined'
import { authorYearLabel, citeStore } from '../../lib/citations'
import { NOTE_COLORS, notesStore, type Note } from '../../lib/notes'
import type { Paper } from '../../lib/types'
import { brand } from '../../theme'

/** 输入 @ 弹出文献库和笔记搜索，回车/点击插入引用（笔记带页码） */
export function filterPapers(query: string, limit = 8): Paper[] {
  const papers = Object.values(citeStore.get().papers)
  const q = query.trim().toLowerCase()
  if (!q) return papers.slice(0, limit)
  const terms = q.split(/\s+/)
  return papers
    .map((p) => {
      const hay = `${p.bibkey} ${p.title} ${(p.authors ?? []).join(' ')} ${p.year ?? ''}`.toLowerCase()
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? (p.bibkey.startsWith(t) ? 3 : 1) : -10), 0)
      return { p, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p)
}

/** @ 菜单里的一项：文献，或者在原文上记的笔记（插入时带页码） */
type Item = { kind: 'paper'; paper: Paper } | { kind: 'note'; note: Note }

export function filterNotes(query: string, limit = 4): Note[] {
  const papers = citeStore.get().papers
  const all = notesStore.get().filter((n) => papers[n.paper_id])
  const q = query.trim().toLowerCase()
  if (!q) return all.slice(0, limit) // 最近的笔记
  const terms = q.split(/\s+/)
  return all
    .filter((n) => {
      const p = papers[n.paper_id]
      const hay = `${n.quote} ${n.comment} ${p.bibkey} ${p.title} ${(p.authors ?? []).join(' ')}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    .slice(0, limit)
}

function itemsFor(query: string): Item[] {
  return [
    ...filterPapers(query, 6).map((paper) => ({ kind: 'paper' as const, paper })),
    ...filterNotes(query).map((note) => ({ kind: 'note' as const, note })),
  ]
}

interface ListRef {
  onKeyDown: (p: SuggestionKeyDownProps) => boolean
}

const CitationList = forwardRef<ListRef, SuggestionProps<Item>>(function CitationList(props, ref) {
  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [props.items])
  const choose = (i: number) => {
    const item = props.items[i]
    if (item) props.command(item)
  }
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setActive((a) => (a + 1) % Math.max(1, props.items.length))
        return true
      }
      if (event.key === 'ArrowUp') {
        setActive((a) => (a - 1 + props.items.length) % Math.max(1, props.items.length))
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        choose(active)
        return true
      }
      return false
    },
  }))

  return (
    <MuiPaper elevation={6} sx={{ width: 420, maxHeight: 320, overflow: 'auto', py: 0.5, border: `1px solid ${brand.line}` }}>
      <Typography variant="caption" sx={{ px: 1.5, py: 0.5, display: 'block', color: 'text.secondary' }}>
        插入引用 · 搜索文献库和笔记 {props.query ? `“${props.query}”` : ''}
      </Typography>
      {props.items.length === 0 && (
        <Typography variant="body2" sx={{ px: 1.5, py: 1, color: 'text.secondary' }}>
          没有匹配的文献。可以在左侧「文献库」里在线检索或上传 PDF。
        </Typography>
      )}
      {props.items.map((it, i) => {
        const first = it.kind === 'note' && props.items[i - 1]?.kind !== 'note'
        const rowSx = {
          px: 1.5, py: 0.75, cursor: 'pointer', display: 'flex', gap: 1,
          bgcolor: i === active ? 'rgba(0,120,212,0.07)' : 'transparent',
          borderLeft: `3px solid ${i === active ? brand.blue : 'transparent'}`,
        }
        const handlers = {
          onMouseDown: (e: React.MouseEvent) => {
            e.preventDefault()
            choose(i)
          },
          onMouseEnter: () => setActive(i),
        }
        if (it.kind === 'paper') {
          const p = it.paper
          return (
            <Box key={p.id} {...handlers} sx={rowSx}>
              <MenuBookOutlinedIcon sx={{ fontSize: 16, mt: '2px', color: brand.navy }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                  {p.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {p.authors?.[0] ?? '佚名'}
                  {p.authors?.length > 1 ? ' 等' : ''} · {p.year ?? 'n.d.'} · <code>{p.bibkey}</code>
                </Typography>
              </Box>
            </Box>
          )
        }
        const n = it.note
        const p = citeStore.get().papers[n.paper_id]
        return (
          <Box key={n.id}>
            {first && (
              <Typography variant="caption" sx={{ px: 1.5, pt: 0.75, pb: 0.25, display: 'block', color: 'text.secondary', borderTop: `1px solid ${brand.lineSoft}` }}>
                我的笔记 · 插入时带页码
              </Typography>
            )}
            <Box {...handlers} sx={rowSx}>
              <EditNoteOutlinedIcon sx={{ fontSize: 17, mt: '1px', color: NOTE_COLORS[n.color].dot }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontStyle: 'italic', fontFamily: '"Times New Roman", serif' }}>
                  “{n.quote}”
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {n.comment ? `${n.comment} · ` : ''}
                  {authorYearLabel(p)} · p.{n.page}
                </Typography>
              </Box>
            </Box>
          </Box>
        )
      })}
    </MuiPaper>
  )
})

export const CitationSuggest = Extension.create({
  name: 'citationSuggest',

  addProseMirrorPlugins() {
    return [
      Suggestion<Item>({
        editor: this.editor,
        pluginKey: new PluginKey('citation-suggest'),
        char: '@',
        allowSpaces: false,
        startOfLine: false,
        allowedPrefixes: null,
        items: ({ query }) => itemsFor(query),
        command: ({ editor, range, props }) => {
          const chain = editor.chain().focus().deleteRange(range)
          if (props.kind === 'paper') chain.insertCitation([props.paper.id]).run()
          else chain.insertCitation([props.note.paper_id], { [props.note.paper_id]: String(props.note.page) }).run()
        },
        render: () => {
          let renderer: ReactRenderer<ListRef, SuggestionProps<Item>> | null = null
          let host: HTMLDivElement | null = null
          const place = (props: SuggestionProps<Item>) => {
            const rect = props.clientRect?.()
            if (!rect || !host) return
            const below = rect.bottom + 330 < window.innerHeight
            host.style.left = `${Math.min(rect.left, window.innerWidth - 440)}px`
            host.style.top = below ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - 330)}px`
          }
          return {
            onStart: (props) => {
              host = document.createElement('div')
              host.style.position = 'fixed'
              host.style.zIndex = '1500'
              document.body.appendChild(host)
              renderer = new ReactRenderer(CitationList, { props, editor: props.editor })
              host.appendChild(renderer.element)
              place(props)
            },
            onUpdate: (props) => {
              renderer?.updateProps(props)
              place(props)
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                host?.remove()
                return true
              }
              return renderer?.ref?.onKeyDown(props) ?? false
            },
            onExit: () => {
              renderer?.destroy()
              host?.remove()
              renderer = null
              host = null
            },
          }
        },
      }),
    ]
  },
})
