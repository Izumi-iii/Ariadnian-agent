import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Copilot 式行内补全：在光标处显示灰色建议文字。
 *  - Tab：接受整段建议
 *  - Ctrl/⌘ + →：只接受下一个词
 *  - Esc 或继续输入：放弃
 * 建议的获取（防抖、取消过期请求）在 useGhostCompletion 里完成，这里只负责显示和接受。
 */
export interface GhostState {
  text: string
  pos: number
}

export const ghostKey = new PluginKey<GhostState | null>('ghost-text')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ghostText: {
      setGhost: (g: GhostState | null) => ReturnType
      acceptGhost: (mode?: 'all' | 'word') => ReturnType
    }
  }
}

export function getGhost(state: any): GhostState | null {
  return ghostKey.getState(state) ?? null
}

function nextWord(text: string): string {
  if (/^[一-鿿]/.test(text)) {
    // 中文：接受到下一个标点或 4 个字
    const m = text.match(/^[一-鿿]{1,4}[，。；、]?/)
    return m ? m[0] : text.slice(0, 1)
  }
  const m = text.match(/^\s*\S+/)
  return m ? m[0] : text
}

export const GhostText = Extension.create({
  name: 'ghostText',

  addCommands() {
    return {
      setGhost:
        (g) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(ghostKey, g ?? { clear: true }))
          return true
        },
      acceptGhost:
        (mode = 'all') =>
        ({ state, tr, dispatch }) => {
          const g = getGhost(state)
          if (!g || !g.text) return false
          const piece = mode === 'word' ? nextWord(g.text) : g.text
          if (dispatch) {
            tr.insertText(piece, g.pos)
            const rest = g.text.slice(piece.length)
            tr.setMeta(ghostKey, rest ? { text: rest, pos: g.pos + piece.length } : { clear: true })
            tr.setMeta('ghostAccept', true)
            dispatch(tr.scrollIntoView())
          }
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => (getGhost(this.editor.state) ? this.editor.commands.acceptGhost('all') : false),
      'Mod-ArrowRight': () => (getGhost(this.editor.state) ? this.editor.commands.acceptGhost('word') : false),
      Escape: () => (getGhost(this.editor.state) ? this.editor.commands.setGhost(null) : false),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<GhostState | null>({
        key: ghostKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(ghostKey)
            if (meta) return meta.clear ? null : (meta as GhostState)
            if (!value) return null
            // 文档或光标变化 → 建议失效
            if (tr.docChanged || tr.selectionSet) return null
            return value
          },
        },
        props: {
          decorations(state) {
            const g = ghostKey.getState(state)
            if (!g || !g.text) return null
            const widget = Decoration.widget(
              g.pos,
              () => {
                const span = document.createElement('span')
                span.className = 'ghost-text'
                span.textContent = g.text
                const hint = document.createElement('kbd')
                hint.className = 'ghost-hint'
                hint.textContent = 'Tab'
                span.appendChild(hint)
                return span
              },
              { side: 1, key: `ghost-${g.pos}-${g.text}` },
            )
            return DecorationSet.create(state.doc, [widget])
          },
        },
      }),
    ]
  },
})
