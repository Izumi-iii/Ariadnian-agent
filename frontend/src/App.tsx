import { useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem,
  Tooltip, Typography,
} from '@mui/material'
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined'
import RateReviewIcon from '@mui/icons-material/RateReview'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import AddCircleIcon from '@mui/icons-material/AddCircle'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import FunctionsIcon from '@mui/icons-material/Functions'
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined'
import CheckIcon from '@mui/icons-material/Check'
import AddIcon from '@mui/icons-material/Add'
import avatar from './assets/ariadne-avatar.png'
import { PillToggle } from './components/Thread'
import { SettingsDialog } from './components/SettingsDialog'
import { PaperEditor } from './editor/PaperEditor'
import { api } from './lib/api'
import { useApp, type RightTab } from './lib/appContext'
import { citeStore, useCiteState } from './lib/citations'
import { createDoc, relTime, useBootstrapDoc, useDocList } from './lib/docs'
import { citedIds, download, toLatex, toMarkdown } from './lib/export'
import type { CiteStyle } from './lib/types'
import { DrawerPanel } from './panels/DrawerPanel'
import { brand } from './theme'

// ------------------------------------------------------------------ 顶栏
function DocSwitcher() {
  const { docId, setDocId, docTitle, bumpDocs } = useApp()
  const docs = useDocList()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState(false)
  const remove = async () => {
    setConfirm(false)
    if (!docId) return
    await api.deleteDoc(docId)
    const list = await api.docs()
    if (list.length) setDocId(list[0].id)
    else setDocId((await createDoc()).id)
    bumpDocs()
  }
  return (
    <>
      <Box
        role="button"
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.25, px: 1.25, py: 0.5, borderRadius: '6px', cursor: 'pointer',
          maxWidth: 420, '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
        }}
      >
        <Typography noWrap sx={{ fontSize: 15, color: brand.ink }}>
          {docTitle || '未命名论文'}
        </Typography>
        <ExpandMoreIcon sx={{ fontSize: 18, color: brand.muted }} />
      </Box>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { minWidth: 300, maxHeight: 420 } } }}>
        {docs.map((d) => (
          <MenuItem
            key={d.id}
            selected={d.id === docId}
            onClick={() => {
              setDocId(d.id)
              setAnchor(null)
            }}
          >
            <ListItemIcon>{d.id === docId ? <CheckIcon fontSize="small" color="primary" /> : <DescriptionOutlinedIcon fontSize="small" />}</ListItemIcon>
            <ListItemText primary={d.title} secondary={relTime(d.updated_at)} slotProps={{ primary: { noWrap: true, fontSize: 13 }, secondary: { fontSize: 11 } }} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={async () => {
            const d = await createDoc()
            bumpDocs()
            setDocId(d.id)
            setAnchor(null)
          }}
        >
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          新建论文
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            setConfirm(true)
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" color="error" />
          </ListItemIcon>
          删除当前论文
        </MenuItem>
      </Menu>
      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>删除这篇论文？</DialogTitle>
        <DialogContent>「{docTitle || '未命名论文'}」将被永久删除，文献库不受影响。</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>取消</Button>
          <Button color="error" variant="contained" onClick={remove}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

function ExportButton() {
  const { editor, docTitle, notify } = useApp()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const exportAs = async (kind: 'md' | 'tex' | 'bib') => {
    setAnchor(null)
    if (!editor) return
    const json = editor.getJSON()
    const name = (docTitle || 'paper').replace(/[\\/:*?"<>|]/g, '_')
    const ids = citedIds(json)
    try {
      if (kind === 'md') download(`${name}.md`, toMarkdown(json, docTitle), 'text/markdown')
      if (kind === 'tex') download(`${name}.tex`, toLatex(json, docTitle), 'application/x-tex')
      if (kind !== 'bib' && !ids.length) return
      download('refs.bib', await api.bibtex(ids.length ? ids : undefined), 'application/x-bibtex')
    } catch (e: any) {
      notify(e.message, 'error')
    }
  }
  return (
    <>
      <Tooltip title="导出">
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} sx={{ color: brand.muted }}>
          <FileDownloadOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <MenuItem onClick={() => exportAs('tex')}>
          <ListItemIcon><FunctionsIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="LaTeX + refs.bib" secondary="可直接上传 Overleaf 编译" />
        </MenuItem>
        <MenuItem onClick={() => exportAs('md')}>
          <ListItemIcon><DescriptionOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Markdown + refs.bib" secondary="pandoc 引用语法，可转 Word" />
        </MenuItem>
        <MenuItem onClick={() => exportAs('bib')}>
          <ListItemIcon><MenuBookOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="仅 BibTeX" secondary="正文引用到的文献" />
        </MenuItem>
      </Menu>
    </>
  )
}

function TopBar() {
  const { docId, health, copilot, setCopilot, review, setReview, openSettings } = useApp()
  const st = useCiteState()
  const changeStyle = (s: CiteStyle) => {
    citeStore.setStyle(s)
    if (docId) api.saveDoc(docId, { cite_style: s })
  }
  return (
    <Box sx={{ height: 52, display: 'flex', alignItems: 'center', px: 2, gap: 2, flexShrink: 0, bgcolor: '#fff' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: 300 }}>
        <Box component="img" src={avatar} alt="Ariadne" sx={{ width: 30, height: 30, borderRadius: '7px', display: 'block' }} />
        <Typography sx={{ fontSize: 18, fontWeight: 500, color: brand.ink, letterSpacing: 0.2 }}>Ariadne</Typography>
        <Typography sx={{ fontSize: 12, color: brand.faint, ml: 0.5 }}>研究报告助手</Typography>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        <DocSwitcher />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        {health && (
          <Tooltip title={health.fake ? '离线演示模式：不调用模型。点击打开设置' : health.llm_ready ? '点击修改模型设置' : '还没有配置模型，点击设置'}>
            <Typography
              onClick={() => openSettings('model')}
              sx={{ fontSize: 13, color: health.llm_ready ? brand.muted : brand.red, cursor: 'pointer', maxWidth: 200 }}
              noWrap
            >
              {health.fake ? '离线演示' : health.llm_ready ? health.model.split('/').slice(1).join('/') || health.model : '未配置模型'}
            </Typography>
          </Tooltip>
        )}
        <Box sx={{ width: '1px', height: 22, bgcolor: brand.line }} />
        <PillToggle<CiteStyle>
          value={st.style}
          onChange={changeStyle}
          options={[
            ['numeric', '[1]'],
            ['author-year', '作者-年'],
          ]}
        />
        <Tooltip title={copilot ? '续写建议：开（停顿时出现灰色建议，Tab 接受）' : '续写建议：关'}>
          <IconButton aria-label="续写建议" onClick={() => setCopilot(!copilot)} sx={{ color: copilot ? brand.blue : brand.muted }}>
            {copilot ? <AutoAwesomeIcon fontSize="small" /> : <AutoAwesomeOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={review ? '页边建议：开（空闲时检查引用和表达，结果显示在段落旁）' : '页边建议：关'}>
          <IconButton aria-label="页边建议" onClick={() => setReview(!review)} sx={{ color: review ? brand.blue : brand.muted }}>
            {review ? <RateReviewIcon fontSize="small" /> : <RateReviewOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <ExportButton />
        <Tooltip title="设置：模型、文献检索、向量检索">
          <IconButton aria-label="设置" onClick={() => openSettings('model')} sx={{ color: brand.muted }}>
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  )
}

// ------------------------------------------------------------------ 左侧图标栏（控制右侧抽屉）
const RAIL: [RightTab, string, typeof StorageOutlinedIcon][] = [
  ['agent', 'AI 助手（Ctrl+J）', AutoAwesomeOutlinedIcon],
  ['library', '文献库', StorageOutlinedIcon],
  ['docs', '我的论文', FolderOutlinedIcon],
]

function Rail() {
  const { drawerOpen, rightTab, toggleDrawer, setDocId, bumpDocs } = useApp()
  const group = (t: RightTab) => (t === 'agent' || t === 'cite' || t === 'ask' ? 'agent' : t)
  return (
    <Box sx={{ width: 52, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, pt: 1.5, borderRight: `1px solid ${brand.lineSoft}` }}>
      <Tooltip title="新建论文" placement="right">
        <IconButton
          aria-label="新建论文"
          onClick={async () => {
            const d = await createDoc()
            bumpDocs()
            setDocId(d.id)
          }}
          sx={{ color: brand.blue, mb: 0.5 }}
        >
          <AddCircleIcon />
        </IconButton>
      </Tooltip>
      {RAIL.map(([key, label, Icon]) => {
        const active = drawerOpen && group(rightTab) === key
        return (
          <Tooltip key={key} title={label} placement="right">
            <IconButton
              aria-label={label.replace(/（.*）/, '')}
              onClick={() => toggleDrawer(key)}
              sx={{
                borderRadius: '8px', color: active ? brand.blue : '#5f6368', bgcolor: active ? 'rgba(0,120,212,0.09)' : 'transparent',
                '&:hover': { bgcolor: active ? 'rgba(0,120,212,0.13)' : 'rgba(0,0,0,0.05)' },
              }}
            >
              <Icon sx={{ fontSize: 21 }} />
            </IconButton>
          </Tooltip>
        )
      })}
    </Box>
  )
}

// ------------------------------------------------------------------ 主布局：图标栏 | 正文（目录 + 页边批注）| 助手抽屉
export default function App() {
  const { docId, drawerOpen, setDrawerOpen } = useApp()
  useBootstrapDoc()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setDrawerOpen(!drawerOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, setDrawerOpen])

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: '#fff' }}>
      <TopBar />
      <SettingsDialog />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Rail />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Allotment proportionalLayout={false} separator={false}>
            <Allotment.Pane minSize={560}>
              <Box sx={{ height: '100%', p: 1.5, pr: drawerOpen ? 0.75 : 1.5, pt: 0.5, boxSizing: 'border-box' }}>
                {docId ? <PaperEditor key={docId} docId={docId} /> : <Box sx={{ p: 4, color: 'text.secondary' }}>正在加载…</Box>}
              </Box>
            </Allotment.Pane>
            <Allotment.Pane preferredSize={400} minSize={320} maxSize={640} visible={drawerOpen}>
              <DrawerPanel />
            </Allotment.Pane>
          </Allotment>
        </Box>
      </Box>
    </Box>
  )
}
