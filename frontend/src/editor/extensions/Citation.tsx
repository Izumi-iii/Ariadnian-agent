import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import Tooltip from '@mui/material/Tooltip'
import Box from '@mui/material/Box'
import { useApp } from '../../lib/appContext'
import { citeStore, formatInline, useCiteState } from '../../lib/citations'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      /** 在光标处插入引用（ids 为文献库中的 paper id） */
      insertCitation: (ids: string[]) => ReturnType
    }
  }
}

/** 引用所在的那句话（从句首到引用之后的句末），用来在原文里找依据 */
function sentenceAround(props: ReactNodeViewProps): string {
  const pos = typeof props.getPos === 'function' ? props.getPos() : undefined
  if (pos == null) return ''
  const doc = props.editor.state.doc
  const $pos = doc.resolve(pos)
  const before = doc.textBetween($pos.start(), pos, ' ', ' ')
  const after = doc.textBetween(Math.min(pos + props.node.nodeSize, $pos.end()), $pos.end(), ' ', ' ')
  const head = before.split(/(?<=[。！？!?；;]|\.\s)/).pop() ?? before
  const tail = after.match(/^[^。！？!?；;]*/)?.[0] ?? ''
  return (head + tail).trim()
}

function CitationView(props: ReactNodeViewProps) {
  const { node, selected } = props
  const st = useCiteState()
  const { openReader } = useApp()
  const ids: string[] = node.attrs.ids ?? []
  const missing = ids.some((id) => !st.papers[id])
  const label = formatInline(ids, st)
  const tip = (
    <Box sx={{ py: 0.25 }}>
      {ids.map((id) => {
        const p = st.papers[id]
        if (!p) return <div key={id}>⚠ 文献库中已不存在这篇文献</div>
        const readable = p.has_pdf || !!p.pdf_url
        return (
          <Box key={id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
            <span style={{ flex: 1 }}>
              {p.title}（{p.authors?.[0] ?? '佚名'}
              {p.authors?.length > 1 ? ' 等' : ''}, {p.year ?? 'n.d.'}）
            </span>
            {readable && (
              <Box
                component="button"
                onClick={() => openReader({ paperId: id, claim: sentenceAround(props) })}
                sx={{ all: 'unset', cursor: 'pointer', color: '#9fd0ff', whiteSpace: 'nowrap', fontSize: 12, '&:hover': { textDecoration: 'underline' } }}
              >
                看原文 →
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
  return (
    <NodeViewWrapper as="span" className={`cite-chip${selected ? ' is-selected' : ''}${missing ? ' is-missing' : ''}`}>
      <Tooltip title={tip} placement="top">
        <span contentEditable={false}>{label}</span>
      </Tooltip>
    </NodeViewWrapper>
  )
}

/** 引用标记 → 纯文本时的表示：[@key1; @key2]（与 pandoc 语法一致，便于让 LLM 改写时原样保留） */
export function citationToText(ids: string[]): string {
  const papers = citeStore.get().papers
  return `[${ids.map((id) => '@' + (papers[id]?.bibkey ?? id)).join('; ')}]`
}

export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      ids: {
        default: [],
        parseHTML: (el) => {
          try {
            return JSON.parse(el.getAttribute('data-ids') || '[]')
          } catch {
            return []
          }
        },
        renderHTML: (attrs) => ({ 'data-ids': JSON.stringify(attrs.ids ?? []) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-citation]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-citation': '' })]
  },

  renderText({ node }) {
    return citationToText(node.attrs.ids ?? [])
  },

  addNodeView() {
    return ReactNodeViewRenderer(CitationView, { as: 'span' })
  },

  addCommands() {
    return {
      insertCitation:
        (ids) =>
        ({ chain }) =>
          chain().insertContent({ type: 'citation', attrs: { ids } }).run(),
    }
  },
})
