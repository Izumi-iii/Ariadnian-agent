/**
 * 分屏对照的右半边：多篇论文用标签页切换，每个标签页是一个完整的原文阅读器（带目录、划线、笔记、引用这句、问 AI）。
 * 正文里点引用的「看原文」、页边批注的「看原文」，分屏模式下都会在这里打开。
 */
import { useState } from 'react'
import { Box, ButtonBase, IconButton, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import AddIcon from '@mui/icons-material/Add'
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined'
import { useApp } from '../lib/appContext'
import { authorYearLabel } from '../lib/citations'
import { brand } from '../theme'
import { ReaderPanel } from './ReaderPanel'

/** 标签页上的短名：冒号前的简称（Self-RAG），否则「作者 年份」 */
function shortName(title: string, label: string): string {
  const head = title.split(/[:：]/)[0].trim()
  return head !== title.trim() && head.length <= 22 ? `${label.replace(/,\s*\d{4}.*$/, '')} · ${head}` : label
}

export function SplitReader() {
  const { papers, splitTabs, splitActive, setSplitActive, closeSplitTab, openReader } = useApp()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const byId = Object.fromEntries(papers.map((p) => [p.id, p]))
  const tabs = splitTabs.filter((t) => byId[t.paperId])
  const active = tabs.find((t) => t.paperId === splitActive) ?? tabs[0] ?? null
  const candidates = papers.filter((p) => p.has_pdf || p.pdf_url)

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: '#fcfcfc', borderLeft: `1px solid ${brand.lineSoft}` }}>
      {/* 标签页 */}
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.25, px: 1, pt: 0.75, borderBottom: `1px solid ${brand.line}`, overflowX: 'auto', scrollbarWidth: 'thin', flexShrink: 0 }}>
        {tabs.map((t) => {
          const p = byId[t.paperId]
          const on = t.paperId === active?.paperId
          return (
            <Tooltip key={t.paperId} title={p.title} enterDelay={500}>
              <Box
                role="tab"
                aria-selected={on}
                onClick={() => setSplitActive(t.paperId)}
                onAuxClick={(e) => e.button === 1 && closeSplitTab(t.paperId)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.5, pl: 1.25, pr: 0.5, height: 30, maxWidth: 220, cursor: 'pointer', flexShrink: 0,
                  borderRadius: '6px 6px 0 0', border: `1px solid ${on ? brand.line : 'transparent'}`, borderBottom: 'none', mb: '-1px',
                  bgcolor: on ? '#fff' : 'transparent', color: on ? brand.ink : brand.muted, '&:hover': { bgcolor: on ? '#fff' : 'rgba(0,0,0,0.04)' },
                }}
              >
                <PictureAsPdfOutlinedIcon sx={{ fontSize: 14, color: on ? '#c62828' : brand.faint }} />
                <Typography noWrap sx={{ fontSize: 12, fontWeight: on ? 500 : 400 }}>
                  {shortName(p.title, authorYearLabel(p))}
                </Typography>
                <IconButton
                  aria-label="关闭"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeSplitTab(t.paperId)
                  }}
                  sx={{ p: 0.25, ml: 0.25, color: brand.faint }}
                >
                  <CloseIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Box>
            </Tooltip>
          )
        })}
        <Tooltip title="打开文献库里的另一篇">
          <IconButton aria-label="打开论文" onClick={(e) => setAnchor(e.currentTarget)} sx={{ mb: 0.25, color: brand.muted }}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { maxWidth: 420, maxHeight: 420 } } }}>
        {candidates.length ? (
          candidates.map((p) => (
            <MenuItem
              key={p.id}
              dense
              selected={tabs.some((t) => t.paperId === p.id)}
              onClick={() => {
                setAnchor(null)
                openReader({ paperId: p.id })
              }}
            >
              <ListItemText
                primary={p.title}
                secondary={`${authorYearLabel(p)}${p.has_pdf ? '' : ' · 未下载，打开时自动下载'}`}
                slotProps={{ primary: { noWrap: true, sx: { fontSize: 13 } }, secondary: { sx: { fontSize: 11.5 } } }}
              />
            </MenuItem>
          ))
        ) : (
          <MenuItem disabled dense>
            文献库里还没有带 PDF 的论文
          </MenuItem>
        )}
      </Menu>

      {/* 当前标签页的阅读器（只挂载当前这一篇，切回来时会重新打开） */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', pt: 1 }}>
        {active ? (
          <ReaderPanel key={active.paperId} target={active} variant="split" />
        ) : (
          <Box sx={{ p: 3, color: brand.muted }}>
            <Typography sx={{ fontSize: 14, fontWeight: 500, color: brand.ink, mb: 1 }}>分屏对照</Typography>
            <Typography sx={{ fontSize: 13, lineHeight: 1.8 }}>
              左边写，右边读。点正文里引用的「看原文」或页边批注的「看原文」，论文会在这里打开；也可以点上面的 + 从文献库选。
              在原文里选中一句话，可以直接引用到光标处、问 AI 或记笔记。
            </Typography>
            {candidates.slice(0, 6).map((p) => (
              <ButtonBase
                key={p.id}
                onClick={() => openReader({ paperId: p.id })}
                sx={{ display: 'flex', width: '100%', justifyContent: 'flex-start', gap: 1, mt: 1, p: 1, borderRadius: '6px', border: `1px solid ${brand.line}`, bgcolor: '#fff', textAlign: 'left' }}
              >
                <PictureAsPdfOutlinedIcon sx={{ fontSize: 16, color: '#c62828' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: 12.5 }}>{p.title}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: brand.faint }}>{authorYearLabel(p)}</Typography>
                </Box>
              </ButtonBase>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}
