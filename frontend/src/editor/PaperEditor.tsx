import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { CharacterCount, Placeholder } from '@tiptap/extensions'
import { Box, Button, CircularProgress, InputBase, Tooltip, Typography } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined'
import { api } from '../lib/api'
import { useApp } from '../lib/appContext'
import { citeStore, collectCitationOrder } from '../lib/citations'
import { useMarginReview } from '../lib/review'
import { brand } from '../theme'
import { Citation } from './extensions/Citation'
import { CitationSuggest } from './extensions/CitationSuggest'
import { GhostText } from './extensions/GhostText'
import { ReviewMarks } from './extensions/ReviewMarks'
import { EditorToolbar } from './EditorToolbar'
import { FloatingToc } from './FloatingToc'
import { MarginNotes } from './MarginNotes'
import { References } from './References'
import { SelectionAssist } from './SelectionAssist'
import { useGhostCompletion } from './useGhostCompletion'

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

function SaveBadge({ state }: { state: SaveState }) {
  const tip = { saved: '已保存', saving: '保存中…', dirty: '有未保存的修改', error: '保存失败，请检查后端' }[state]
  return (
    <Tooltip title={tip} placement="left">
      <Box
        sx={{
          width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
          border: `2px solid ${state === 'error' ? brand.red : state === 'saved' ? brand.green : '#bdbdbd'}`,
          color: state === 'error' ? brand.red : brand.green, bgcolor: '#fff',
        }}
      >
        {state === 'saved' ? (
          <CheckIcon sx={{ fontSize: 14 }} />
        ) : state === 'error' ? (
          <CloudOffOutlinedIcon sx={{ fontSize: 13 }} />
        ) : (
          <CircularProgress size={12} thickness={5} sx={{ color: '#9e9e9e' }} />
        )}
      </Box>
    </Tooltip>
  )
}

function Counts({ editor }: { editor: any }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      let cites = 0
      e.state.doc.descendants((n: any) => {
        if (n.type.name === 'citation') cites++
      })
      return { chars: e.storage.characterCount?.characters?.() ?? 0, cites }
    },
  })
  return (
    <Typography sx={{ fontSize: 11.5, color: brand.faint, whiteSpace: 'nowrap' }}>
      {s.chars.toLocaleString()} 字 · {s.cites} 处引用
    </Typography>
  )
}

/** 根据可用宽度决定：目录（完整 / 短横线 / 隐藏）、页边批注列宽度、正文宽度 */
function useColumns(el: HTMLElement | null) {
  const [w, setW] = useState(1200)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  // 宽屏显示完整目录；打开抽屉或窗口较窄时变成一列短横线（悬停预览标题和正文）
  const toc: 'full' | 'mini' = w >= 1240 ? 'full' : 'mini'
  const tocW = toc === 'full' ? 150 : 32
  const marginW = w >= 960 ? (w >= 1240 ? 300 : 260) : 0
  const gap = w >= 1240 ? 48 : 32
  const paperW = Math.max(420, Math.min(760, w - tocW - marginW - gap * 2 - 48))
  return { toc, tocW, marginW, paperW, gap }
}

export function PaperEditor({ docId }: { docId: string }) {
  const { setEditor, docTitle, setDocTitle, notify, copilot, review, bumpDocs, drawerOpen, setDrawerOpen } = useApp()
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [active, setActive] = useState<string | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const marginRef = useRef<HTMLDivElement | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const titleTimer = useRef<number | undefined>(undefined)
  const loadingDoc = useRef(false)
  const cols = useColumns(scrollEl)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? '章节标题' : '开始写作…  输入 @ 插入引用，选中文字让 AI 润色，停顿片刻会出现灰色续写建议（Tab 接受）',
      }),
      CharacterCount,
      Citation,
      CitationSuggest,
      GhostText,
      ReviewMarks,
    ],
    editorProps: { attributes: { class: 'paper-body', spellcheck: 'false' } },
    onUpdate: ({ editor: e, transaction }) => {
      citeStore.setOrder(collectCitationOrder(e.state.doc))
      if (loadingDoc.current || !transaction.docChanged) return
      setSaveState('dirty')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(async () => {
        setSaveState('saving')
        try {
          await api.saveDoc(docId, { content: e.getJSON() })
          setSaveState('saved')
          bumpDocs()
        } catch {
          setSaveState('error')
        }
      }, 800)
    },
  })

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    setLoaded(false)
    api
      .getDoc(docId)
      .then((d) => {
        if (cancelled) return
        loadingDoc.current = true
        editor.commands.setContent(d.content, { emitUpdate: true })
        loadingDoc.current = false
        citeStore.setOrder(collectCitationOrder(editor.state.doc))
        citeStore.setStyle(d.cite_style ?? 'numeric')
        setDocTitle(d.title)
        setSaveState('saved')
        setLoaded(true)
      })
      .catch((e) => notify(`加载文档失败：${e.message}`, 'error'))
    return () => {
      cancelled = true
      window.clearTimeout(saveTimer.current)
    }
  }, [editor, docId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setEditor(editor)
    return () => setEditor(null)
  }, [editor, setEditor])

  const { loading } = useGhostCompletion(editor, copilot, docTitle)
  const rv = useMarginReview(editor, docId, docTitle, review && loaded)
  const notes = useMemo(() => (review ? rv.placed : []), [review, rv.placed])
  const cards = useMemo(() => notes.filter((n) => n.card), [notes])

  // 正文里的标记与页边卡片同步
  useEffect(() => {
    if (!editor) return
    // 放到下一帧再派发：在 React 提交阶段直接改编辑器会让引用节点的 NodeView 同步重渲染（flushSync 警告）
    const id = requestAnimationFrame(() => {
      if (editor.isDestroyed) return
      editor.commands.setReviewMarks(
        notes.map((n) => ({ key: n.key, kind: n.kind, from: n.from, to: n.to, citePos: n.citePos })),
        active,
      )
    })
    return () => cancelAnimationFrame(id)
  }, [editor, notes, active])

  // 点击正文里的波浪线 → 高亮对应卡片
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest('[data-ann]') as HTMLElement | null
      setActive(el?.dataset.ann ?? null)
    }
    dom.addEventListener('click', onClick)
    return () => dom.removeEventListener('click', onClick)
  }, [editor])

  const changeTitle = (t: string) => {
    setDocTitle(t)
    setSaveState('dirty')
    window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(async () => {
      try {
        await api.saveDoc(docId, { title: t.trim() || '未命名论文' })
        setSaveState('saved')
        bumpDocs()
      } catch {
        setSaveState('error')
      }
    }, 600)
  }

  if (!editor) return null

  return (
    <Box
      sx={{
        height: '100%', border: `1px solid ${brand.line}`, borderRadius: '12px', bgcolor: '#fff', position: 'relative',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <EditorToolbar editor={editor} />

      <Box ref={setScrollEl} sx={{ flex: 1, overflow: 'auto' }} className="editor-scroll">
        <Box
          sx={{
            display: 'grid', justifyContent: 'center', columnGap: `${cols.gap}px`, px: 3,
            gridTemplateColumns: [cols.tocW ? `${cols.tocW}px` : null, `${cols.paperW}px`, cols.marginW ? `${cols.marginW}px` : null]
              .filter(Boolean)
              .join(' '),
          }}
        >
          <Box>
            <Box sx={{ position: 'sticky', top: 0, pt: 12, zIndex: 5 }}>
              <FloatingToc editor={editor} mode={cols.toc} scrollEl={scrollEl} />
            </Box>
          </Box>
          <Box className="paper-col">
            <InputBase
              value={docTitle}
              onChange={(e) => changeTitle(e.target.value)}
              placeholder="论文标题"
              multiline
              fullWidth
              sx={{ fontSize: 30, fontWeight: 700, lineHeight: 1.3, color: brand.ink, mb: 1.5, p: 0, letterSpacing: -0.2 }}
            />
            {!loaded && <CircularProgress size={18} sx={{ my: 3 }} />}
            <EditorContent editor={editor} />
            <References />
          </Box>
          {cols.marginW > 0 && (
            <Box sx={{ pt: '28px', pb: 12 }}>
              <MarginNotes editor={editor} notes={cards} active={active} setActive={setActive} onDismiss={rv.dismiss} columnRef={marginRef} />
            </Box>
          )}
        </Box>
      </Box>

      {/* 底部状态条 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, height: 38, borderTop: `1px solid ${brand.lineSoft}`, flexShrink: 0 }}>
        <Counts editor={editor} />
        {review && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {rv.pending > 0 ? (
              <Typography sx={{ fontSize: 11.5, color: brand.faint, display: 'flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}>
                <CircularProgress size={10} sx={{ color: brand.faint }} />
                正在检查 {Math.max(0, rv.total - rv.pending) + 1}/{Math.max(rv.total, 1)} 段
              </Typography>
            ) : (
              <Tooltip title={cols.marginW ? '' : drawerOpen ? '收起右侧抽屉以显示页边建议' : ''}>
                <Typography
                  onClick={() => !cols.marginW && drawerOpen && setDrawerOpen(false)}
                  sx={{ fontSize: 11.5, color: cards.length ? brand.purple : brand.faint, cursor: !cols.marginW && drawerOpen ? 'pointer' : 'default', whiteSpace: 'nowrap' }}
                >
                  {cards.length ? `页边建议 ${cards.length} 条` : '页边暂无建议'}
                  {!cols.marginW && cards.length ? '（空间不足，已隐藏）' : ''}
                </Typography>
              </Tooltip>
            )}
            <Button size="small" onClick={rv.reviewAll} disabled={rv.pending > 0} sx={{ fontSize: 11.5, py: 0, minHeight: 22 }}>
              检查全文
            </Button>
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        {loading && (
          <Typography sx={{ fontSize: 11.5, color: brand.faint, display: 'flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}>
            <CircularProgress size={10} sx={{ color: brand.faint }} /> 正在生成续写建议
          </Typography>
        )}
        <SaveBadge state={saveState} />
      </Box>
      <SelectionAssist editor={editor} />
    </Box>
  )
}
