/**
 * 原文上的划线与笔记：选中文字后的浮动菜单、点击划线弹出的笔记卡片、侧栏里的笔记列表。
 */
import { useState } from 'react'
import { Box, Button, ButtonBase, Collapse, IconButton, InputBase, Popover, Tooltip, Typography } from '@mui/material'
import FormatQuoteIcon from '@mui/icons-material/FormatQuote'
import ShortTextIcon from '@mui/icons-material/ShortText'
import BorderColorOutlinedIcon from '@mui/icons-material/BorderColorOutlined'
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { NOTE_COLORS, type Note, type NoteColor } from '../lib/notes'
import { brand } from '../theme'
import type { PdfSelection } from './PdfViewer'

const SERIF = '"Times New Roman", "Noto Serif CJK SC", serif'

function ColorDots({ value, onChange, size = 14 }: { value: NoteColor; onChange: (c: NoteColor) => void; size?: number }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.75 }}>
      {(Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
        <Box
          key={c}
          role="button"
          aria-label={`${NOTE_COLORS[c].label}色`}
          onClick={() => onChange(c)}
          sx={{
            width: size, height: size, borderRadius: '50%', bgcolor: NOTE_COLORS[c].dot, cursor: 'pointer',
            boxShadow: value === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${NOTE_COLORS[c].dot}` : 'none',
          }}
        />
      ))}
    </Box>
  )
}

// ------------------------------------------------------------------ 选中文字后的浮动菜单
export function SelectionMenu({
  sel, close, canCite, onCite, onSave, onAsk,
}: {
  sel: PdfSelection
  close: () => void
  canCite: boolean
  /** withQuote：连同原句一起插入正文 */
  onCite: (sel: PdfSelection, withQuote: boolean) => void
  onSave: (sel: PdfSelection, color: NoteColor, comment: string) => Promise<void>
  /** 问 AI：在「文献问答」里解释这段原文 */
  onAsk?: (sel: PdfSelection) => void
}) {
  const [mode, setMode] = useState<'menu' | 'note'>('menu')
  const [comment, setComment] = useState('')
  const [color, setColor] = useState<NoteColor>('yellow')
  const [saving, setSaving] = useState(false)

  const save = async (c: NoteColor, text: string) => {
    setSaving(true)
    try {
      await onSave(sel, c, text)
      close()
    } finally {
      setSaving(false)
    }
  }

  if (mode === 'note') {
    return (
      <Box sx={{ width: 320, bgcolor: '#fff', borderRadius: '8px', border: `1px solid ${brand.line}`, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', p: 1.5 }}>
        <Typography sx={{ fontSize: 12, fontFamily: SERIF, fontStyle: 'italic', color: brand.muted, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', borderLeft: `3px solid ${NOTE_COLORS[color].dot}`, pl: 1 }}>
          {sel.text}
        </Typography>
        <InputBase
          autoFocus
          multiline
          minRows={2}
          maxRows={8}
          fullWidth
          placeholder="写下你的理解、疑问，或者打算怎么用它…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(color, comment)
            if (e.key === 'Escape') close()
          }}
          sx={{ mt: 1, fontSize: 13, border: `1px solid ${brand.line}`, borderRadius: '6px', px: 1, py: 0.75 }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <ColorDots value={color} onChange={setColor} />
          <Box sx={{ flex: 1 }} />
          <Button onClick={close} sx={{ color: brand.muted }}>
            取消
          </Button>
          <Button variant="contained" disabled={saving} onClick={() => save(color, comment)}>
            保存笔记
          </Button>
        </Box>
      </Box>
    )
  }

  const item = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false, tip?: string) => (
    <Tooltip title={tip ?? ''} key={label}>
      <span>
        <ButtonBase
          disabled={disabled}
          onClick={onClick}
          sx={{ px: 1.1, height: 32, gap: 0.5, color: disabled ? 'rgba(255,255,255,0.35)' : '#fff', fontSize: 12.5, borderRadius: '4px', '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' } }}
        >
          {icon}
          {label}
        </ButtonBase>
      </span>
    </Tooltip>
  )
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', bgcolor: '#2b2b2b', borderRadius: '6px', px: 0.5, boxShadow: '0 4px 14px rgba(0,0,0,0.25)', whiteSpace: 'nowrap' }}>
      {item('引用这句', <FormatQuoteIcon sx={{ fontSize: 16 }} />, () => (onCite(sel, false), close()), !canCite, `在正文插入引用，带页码 p. ${sel.page}`)}
      {item('插入原句', <ShortTextIcon sx={{ fontSize: 16 }} />, () => (onCite(sel, true), close()), !canCite, '把这句原文加引号插入正文，并附上引用')}
      <Box sx={{ width: '1px', height: 18, bgcolor: 'rgba(255,255,255,0.2)', mx: 0.25 }} />
      {onAsk && item('问 AI', <AutoAwesomeOutlinedIcon sx={{ fontSize: 15 }} />, () => (onAsk(sel), close()), false, '在「文献问答」里解释这段原文')}
      {item('划线', <BorderColorOutlinedIcon sx={{ fontSize: 15 }} />, () => save('yellow', ''), saving, '保存为黄色划线')}
      {item('记笔记', <EditNoteOutlinedIcon sx={{ fontSize: 17 }} />, () => setMode('note'))}
      {item('', <ContentCopyIcon sx={{ fontSize: 14 }} />, () => (navigator.clipboard?.writeText(sel.text), close()), false, '复制')}
    </Box>
  )
}

// ------------------------------------------------------------------ 点击划线弹出的笔记卡片
export function NotePopover({
  note, at, onClose, onCite, onUpdate, onDelete,
}: {
  note: Note | null
  at: { x: number; y: number } | null
  onClose: () => void
  onCite: (n: Note) => void
  onUpdate: (n: Note, fields: { comment?: string; color?: NoteColor }) => void
  onDelete: (n: Note) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const open = !!note && !!at
  return (
    <Popover
      open={open}
      onClose={() => {
        if (note && draft != null && draft !== note.comment) onUpdate(note, { comment: draft })
        setDraft(null)
        onClose()
      }}
      anchorReference="anchorPosition"
      anchorPosition={at ? { top: at.y + 10, left: at.x } : undefined}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      slotProps={{ paper: { sx: { width: 320, p: 1.5 } } }}
    >
      {note && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
            <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: brand.blue }}>p.{note.page}</Typography>
            <Box sx={{ flex: 1 }} />
            <ColorDots value={note.color} onChange={(c) => onUpdate(note, { color: c })} size={12} />
          </Box>
          <Typography sx={{ fontSize: 12, fontFamily: SERIF, fontStyle: 'italic', color: brand.muted, borderLeft: `3px solid ${NOTE_COLORS[note.color].dot}`, pl: 1, maxHeight: 110, overflow: 'auto' }}>
            {note.quote}
          </Typography>
          <InputBase
            multiline
            minRows={2}
            maxRows={8}
            fullWidth
            placeholder="添加批注…"
            value={draft ?? note.comment}
            onChange={(e) => setDraft(e.target.value)}
            sx={{ mt: 1, fontSize: 13, border: `1px solid ${brand.line}`, borderRadius: '6px', px: 1, py: 0.75 }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
            <Button size="small" variant="contained" startIcon={<FormatQuoteIcon />} onClick={() => onCite(note)}>
              引用
            </Button>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="删除这条笔记">
              <IconButton aria-label="删除笔记" onClick={() => onDelete(note)} sx={{ color: brand.muted }}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </>
      )}
    </Popover>
  )
}

// ------------------------------------------------------------------ 侧栏笔记列表
export function NotesList({
  notes, active, onOpen, onCite,
}: {
  notes: Note[]
  active: string | null
  onOpen: (n: Note) => void
  onCite: (n: Note) => void
}) {
  const [open, setOpen] = useState(false)
  if (!notes.length) return null
  return (
    <Box sx={{ px: 2, pb: 1 }}>
      <ButtonBase onClick={() => setOpen(!open)} sx={{ gap: 0.5, color: brand.muted, fontSize: 12, borderRadius: '4px', px: 0.5 }}>
        <EditNoteOutlinedIcon sx={{ fontSize: 16 }} />
        我的笔记 · {notes.length}
        <ExpandMoreIcon sx={{ fontSize: 16, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </ButtonBase>
      <Collapse in={open}>
        <Box sx={{ maxHeight: 220, overflow: 'auto', mt: 0.5 }}>
          {notes.map((n) => (
            <Box
              key={n.id}
              onClick={() => onOpen(n)}
              sx={{
                display: 'flex', gap: 1, alignItems: 'flex-start', px: 1, py: 0.75, borderRadius: '6px', cursor: 'pointer',
                bgcolor: active === n.id ? 'rgba(0,120,212,0.07)' : 'transparent', '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
                '&:hover .cite': { opacity: 1 },
              }}
            >
              <Box sx={{ width: 4, alignSelf: 'stretch', borderRadius: 2, bgcolor: NOTE_COLORS[n.color].dot, flexShrink: 0 }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: 12, fontFamily: SERIF, fontStyle: 'italic', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  <Box component="span" sx={{ fontFamily: 'Roboto', fontStyle: 'normal', fontWeight: 600, color: brand.blue, mr: 0.75 }}>
                    p.{n.page}
                  </Box>
                  {n.quote}
                </Typography>
                {n.comment && <Typography sx={{ fontSize: 12, color: brand.ink, mt: 0.25 }}>{n.comment}</Typography>}
              </Box>
              <Tooltip title="引用（带页码）">
                <IconButton
                  className="cite"
                  aria-label="引用这条笔记"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCite(n)
                  }}
                  sx={{ p: 0.25, opacity: 0, color: brand.blue }}
                >
                  <FormatQuoteIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}
