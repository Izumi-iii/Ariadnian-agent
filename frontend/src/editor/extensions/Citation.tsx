import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import Tooltip from '@mui/material/Tooltip'
import { citeStore, formatInline, useCiteState } from '../../lib/citations'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      /** 在光标处插入引用（ids 为文献库中的 paper id） */
      insertCitation: (ids: string[]) => ReturnType
    }
  }
}

function CitationView({ node, selected }: ReactNodeViewProps) {
  const st = useCiteState()
  const ids: string[] = node.attrs.ids ?? []
  const missing = ids.some((id) => !st.papers[id])
  const label = formatInline(ids, st)
  const tip = ids
    .map((id) => {
      const p = st.papers[id]
      return p ? `${p.title}（${p.authors?.[0] ?? '佚名'}${p.authors?.length > 1 ? ' 等' : ''}, ${p.year ?? 'n.d.'}）` : '⚠ 文献库中已不存在这篇文献'
    })
    .join('\n')
  return (
    <NodeViewWrapper as="span" className={`cite-chip${selected ? ' is-selected' : ''}${missing ? ' is-missing' : ''}`}>
      <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>} placement="top">
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
