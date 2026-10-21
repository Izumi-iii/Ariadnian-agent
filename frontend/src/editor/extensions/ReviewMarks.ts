import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * 页边批注在正文里的标记：
 *  - 缺引用的句子：琥珀色波浪线
 *  - 可以精简的句子：紫色虚线
 *  - 已有引用：按核查结果给引用标记加状态（支持 / 部分支持 / 不支撑）
 *  - 审稿意见：主要问题红色、次要问题琥珀色的下划线（整节意见画在标题上）
 *  - 当前悬停或选中的批注：浅蓝底色高亮对应原文
 * 每个标记带 data-ann 属性，点击正文里的标记可以定位到页边卡片。
 */
export interface MarkSpec {
  key: string
  kind: 'cite_check' | 'missing_citation' | 'rewrite' | 'reviewer'
  /** 额外的样式类（审稿意见按严重程度区分） */
  cls?: string
  from: number
  to: number
  citePos: { pos: number; verdict: string }[]
}

export const reviewKey = new PluginKey<{ marks: MarkSpec[]; active: string | null; deco: DecorationSet }>('review-marks')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    reviewMarks: {
      setReviewMarks: (marks: MarkSpec[], active: string | null) => ReturnType
    }
  }
}

const VERDICT_CLASS: Record<string, string> = {
  supports: 'rv-cite-ok',
  partial: 'rv-cite-warn',
  unrelated: 'rv-cite-bad',
  missing: 'rv-cite-bad',
  unknown: 'rv-cite-warn',
}

function build(doc: any, marks: MarkSpec[], active: string | null): DecorationSet {
  const decos: Decoration[] = []
  const size = doc.content.size
  for (const m of marks) {
    if (m.from < 0 || m.to > size || m.from >= m.to) continue
    const isActive = m.key === active
    if (m.kind === 'missing_citation' || m.kind === 'rewrite' || m.kind === 'reviewer' || isActive) {
      const base = m.kind === 'missing_citation' ? 'rv-missing' : m.kind === 'rewrite' ? 'rv-rewrite' : m.kind === 'reviewer' ? (m.cls ?? 'rv-critic') : ''
      const cls = [base, isActive ? 'rv-active' : '']
        .filter(Boolean)
        .join(' ')
      if (cls) decos.push(Decoration.inline(m.from, m.to, { class: cls, 'data-ann': m.key }))
    }
    for (const c of m.citePos) {
      const node = doc.nodeAt(c.pos)
      if (!node || node.type.name !== 'citation') continue
      decos.push(Decoration.node(c.pos, c.pos + 1, { class: VERDICT_CLASS[c.verdict] ?? 'rv-cite-warn', 'data-ann': m.key }))
    }
  }
  return DecorationSet.create(doc, decos)
}

export const ReviewMarks = Extension.create({
  name: 'reviewMarks',

  addCommands() {
    return {
      setReviewMarks:
        (marks, active) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(reviewKey, { marks, active }).setMeta('addToHistory', false))
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: reviewKey,
        state: {
          init: (_, state) => ({ marks: [], active: null, deco: DecorationSet.create(state.doc, []) }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(reviewKey)
            if (meta) return { marks: meta.marks, active: meta.active, deco: build(state.doc, meta.marks, meta.active) }
            if (tr.docChanged) return { ...value, deco: value.deco.map(tr.mapping, tr.doc) }
            return value
          },
        },
        props: {
          decorations(state) {
            return reviewKey.getState(state)?.deco ?? null
          },
        },
      }),
    ]
  },
})
