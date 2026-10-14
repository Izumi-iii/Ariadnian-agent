import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { CharacterCount, Placeholder } from '@tiptap/extensions'
import {
  Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputBase, Tooltip, Typography,
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined'
import ManageSearchIcon from '@mui/icons-material/ManageSearch'
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined'
import DeleteIcon from '@mui/icons-material/Delete'
import { api } from '../lib/api'
import { useApp } from '../lib/appContext'
import { citeStore, collectCitationOrder } from '../lib/citations'
import { sentenceAround } from '../lib/editorText'
import { brand, shadow } from '../theme'
import { Citation } from './extensions/Citation'
import { CitationSuggest } from './extensions/CitationSuggest'
import { GhostText } from './extensions/GhostText'
import { EditorToolbar } from './EditorToolbar'
import { References } from './References'
import { SelectionAssist } from './SelectionAssist'
import { useGhostCompletion } from './useGhostCompletion'

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

function RoundButton({ title, onClick, children, danger }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <Tooltip title={title} placement="right">
      <IconButton
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        sx={{
          width: 32, height: 32, bgcolor: '#fff', border: `1px solid ${brand.line}`, boxShadow: shadow.pill,
          color: danger ? '#d13438' : brand.muted, '&:hover': { bgcolor: '#f5f5f5', color: danger ? '#a4262c' : brand.blue },
          '& svg': { fontSize: 17 },
        }}
      >
        {children}
      </IconButton>
    </Tooltip>
  )
}

function SaveBadge({ state }: { state: SaveState }) {
  const tip = { saved: '已保存', saving: '保存中…', dirty: '有未保存的修改', error: '保存失败，请检查后端' }[state]
  return (
    <Tooltip title={tip} placement="left">
      <Box
        sx={{
          position: 'absolute', right: 14, bottom: 12, width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center',
          border: `2px solid ${state === 'error' ? brand.red : state === 'saved' ? brand.green : '#bdbdbd'}`,
          color: state === 'error' ? brand.red : brand.green, bgcolor: '#fff', zIndex: 2,
        }}
      >
        {state === 'saved' ? (
          <CheckIcon sx={{ fontSize: 16 }} />
        ) : state === 'error' ? (
          <CloudOffOutlinedIcon sx={{ fontSize: 15 }} />
        ) : (
          <CircularProgress size={14} thickness={5} sx={{ color: '#9e9e9e' }} />
        )}
      </Box>
    </Tooltip>
  )
}

function WordCount({ editor }: { editor: any }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      chars: e.storage.characterCount?.characters?.() ?? 0,
      words: e.storage.characterCount?.words?.() ?? 0,
    }),
  })
  return (
    <Typography sx={{ position: 'absolute', left: 16, bottom: 14, fontSize: 11.5, color: brand.faint }}>
      {s.chars} 字符 · {s.words} 词
    </Typography>
  )
}

export function PaperEditor({ docId }: { docId: string }) {
  const { setEditor, docTitle, setDocTitle, notify, copilot, bumpDocs, requestCitations, setLeftView, setRightTab, setDocId } = useApp()
  const [loaded, setLoaded] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const titleTimer = useRef<number | undefined>(undefined)
  const loadingDoc = useRef(false)

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

  const deleteDoc = async () => {
    setConfirmDelete(false)
    await api.deleteDoc(docId)
    const list = await api.docs()
    bumpDocs()
    setDocId(list[0]?.id ?? null)
    if (!list.length) {
      const { createDoc } = await import('../lib/docs')
      const d = await createDoc()
      bumpDocs()
      setDocId(d.id)
    }
  }

  if (!editor) return null

  return (
    <Box
      sx={{
        height: '100%', border: `1px solid ${brand.line}`, borderRadius: '12px', bgcolor: '#fff', position: 'relative',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* 左侧悬浮圆形按钮（Alidade 报告面板的样式） */}
      <Box sx={{ position: 'absolute', left: 14, top: 14, display: 'flex', flexDirection: 'column', gap: 1, zIndex: 3 }}>
        <RoundButton
          title="为光标所在的句子找引用"
          onClick={() => {
            const { text, end } = sentenceAround(editor)
            if (text.trim()) requestCitations(text, end)
            else notify('先把光标放在要找引用的句子里', 'info')
          }}
        >
          <ManageSearchIcon />
        </RoundButton>
        <RoundButton
          title="核查全文引用"
          onClick={() => {
            setLeftView('assistant')
            setRightTab('cite')
          }}
        >
          <FactCheckOutlinedIcon />
        </RoundButton>
        <RoundButton title="删除这篇论文" danger onClick={() => setConfirmDelete(true)}>
          <DeleteIcon />
        </RoundButton>
      </Box>

      <EditorToolbar editor={editor} />

      <Box sx={{ flex: 1, overflow: 'auto' }} className="editor-scroll">
        <Box className="paper-sheet">
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
      </Box>

      <WordCount editor={editor} />
      {loading && (
        <Typography sx={{ position: 'absolute', right: 52, bottom: 16, fontSize: 11.5, color: brand.faint, display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <CircularProgress size={10} sx={{ color: brand.faint }} /> 正在生成续写建议
        </Typography>
      )}
      <SaveBadge state={saveState} />
      <SelectionAssist editor={editor} />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>删除这篇论文？</DialogTitle>
        <DialogContent>「{docTitle || '未命名论文'}」将被永久删除，文献库不受影响。</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>取消</Button>
          <Button color="error" variant="contained" onClick={deleteDoc}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
