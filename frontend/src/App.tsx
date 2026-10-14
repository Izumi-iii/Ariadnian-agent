import { useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  Box, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography,
} from '@mui/material'
import AddCircleIcon from '@mui/icons-material/AddCircle'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined'
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import FunctionsIcon from '@mui/icons-material/Functions'
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined'
import CheckIcon from '@mui/icons-material/Check'
import AddIcon from '@mui/icons-material/Add'
import mark from './ariadne-mark.svg'
import { PillToggle } from './components/Thread'
import { SettingsDialog } from './components/SettingsDialog'
import { PaperEditor } from './editor/PaperEditor'
import { api } from './lib/api'
import { useApp, type LeftView } from './lib/appContext'
import { citeStore, useCiteState } from './lib/citations'
import { createDoc, relTime, useBootstrapDoc, useDocList } from './lib/docs'
import { citedIds, download, toLatex, toMarkdown } from './lib/export'
import type { CiteStyle } from './lib/types'
import { AssistantPanel } from './panels/AssistantPanel'
import { DocsPanel } from './panels/DocsPanel'
import { LibraryPanel } from './panels/LibraryPanel'
import { OutlinePanel } from './panels/OutlinePanel'
import { brand } from './theme'

// ------------------------------------------------------------------ 顶栏
function DocSwitcher() {
  const { docId, setDocId, docTitle, bumpDocs } = useApp()
  const docs = useDocList()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
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
      </Menu>
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
  const { docId, health, copilot, setCopilot } = useApp()
  const st = useCiteState()
  const [settings, setSettings] = useState(false)
  const changeStyle = (s: CiteStyle) => {
    citeStore.setStyle(s)
    if (docId) api.saveDoc(docId, { cite_style: s })
  }
  return (
    <Box sx={{ height: 52, display: 'flex', alignItems: 'center', px: 2, gap: 2, flexShrink: 0, bgcolor: '#fff' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: 300 }}>
        <Box component="img" src={mark} sx={{ width: 22, height: 22 }} />
        <Typography sx={{ fontSize: 18, fontWeight: 500, color: brand.ink, letterSpacing: 0.2 }}>Ariadne</Typography>
        <Typography sx={{ fontSize: 12, color: brand.faint, ml: 0.5 }}>论文写作助手</Typography>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        <DocSwitcher />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        {health && (
          <Tooltip title={health.fake ? '离线演示模式（LLM_FAKE=1），不调用模型' : '查看四档模型与调用统计'}>
            <Typography
              onClick={() => setSettings(true)}
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
        <ExportButton />
        <Tooltip title="模型设置">
          <IconButton onClick={() => setSettings(true)} sx={{ color: brand.muted }}>
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </Box>
  )
}

// ------------------------------------------------------------------ 左侧图标栏
const RAIL: [LeftView, string, typeof StorageOutlinedIcon][] = [
  ['assistant', 'AI 助手', AutoAwesomeOutlinedIcon],
  ['library', '文献库', StorageOutlinedIcon],
  ['outline', '大纲', FormatListBulletedIcon],
  ['docs', '我的论文', FolderOutlinedIcon],
]

function Rail() {
  const { leftView, setLeftView, setDocId, bumpDocs } = useApp()
  return (
    <Box sx={{ width: 52, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, pt: 1.5, borderRight: `1px solid ${brand.lineSoft}` }}>
      <Tooltip title="新建论文" placement="right">
        <IconButton
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
        const active = leftView === key
        return (
          <Tooltip key={key} title={label} placement="right">
            <IconButton
              aria-label={label}
              onClick={() => setLeftView(active ? null : key)}
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

// ------------------------------------------------------------------ 主布局
export default function App() {
  const { docId, leftView } = useApp()
  useBootstrapDoc()

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: '#fff' }}>
      <TopBar />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Rail />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Allotment proportionalLayout={false} separator={false}>
            <Allotment.Pane preferredSize={420} minSize={320} maxSize={640} visible={leftView !== null}>
              <Box sx={{ height: '100%', position: 'relative' }}>
                {(['assistant', 'library', 'outline', 'docs'] as LeftView[]).map((v) => (
                  <Box key={v} sx={{ position: 'absolute', inset: 0, display: leftView === v ? 'block' : 'none' }}>
                    {v === 'assistant' ? <AssistantPanel /> : v === 'library' ? <LibraryPanel /> : v === 'outline' ? <OutlinePanel /> : <DocsPanel />}
                  </Box>
                ))}
              </Box>
            </Allotment.Pane>
            <Allotment.Pane minSize={520}>
              <Box sx={{ height: '100%', p: 1.5, pl: leftView ? 0.5 : 1.5, pt: 0.5, boxSizing: 'border-box' }}>
                {docId ? <PaperEditor key={docId} docId={docId} /> : <Box sx={{ p: 4, color: 'text.secondary' }}>正在加载…</Box>}
              </Box>
            </Allotment.Pane>
          </Allotment>
        </Box>
      </Box>
    </Box>
  )
}
