import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { PillToggle } from '../components/Thread'
import { useApp, type RightTab } from '../lib/appContext'
import { brand } from '../theme'
import { AgentPanel } from './AgentPanel'
import { AskPanel } from './AskPanel'
import { CitePanel } from './CitePanel'
import { DocsPanel } from './DocsPanel'
import { LibraryPanel } from './LibraryPanel'

const VIEWS: RightTab[] = ['agent', 'cite', 'ask', 'library', 'docs']

/** 右侧抽屉：综述 Agent / 找引用 / 文献问答 / 文献库 / 我的论文。平时收起，Ctrl+J 切换 */
export function DrawerPanel() {
  const { rightTab, setRightTab, setDrawerOpen } = useApp()
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: '#fcfcfc', borderLeft: `1px solid ${brand.lineSoft}` }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        {rightTab === 'docs' ? (
          <Typography sx={{ fontSize: 14, fontWeight: 500, flex: 1 }}>我的论文</Typography>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <PillToggle<RightTab>
              value={rightTab}
              onChange={setRightTab}
              options={[
                ['agent', '综述 Agent'],
                ['cite', '找引用'],
                ['ask', '文献问答'],
                ['library', '文献库'],
              ]}
            />
          </Box>
        )}
        <Tooltip title="收起（Ctrl+J）">
          <IconButton aria-label="收起抽屉" onClick={() => setDrawerOpen(false)} sx={{ color: brand.faint }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      {VIEWS.map((t) => (
        <Box key={t} sx={{ flex: 1, minHeight: 0, display: rightTab === t ? 'flex' : 'none', flexDirection: 'column' }}>
          {t === 'agent' ? (
            <AgentPanel />
          ) : t === 'cite' ? (
            <CitePanel />
          ) : t === 'ask' ? (
            <AskPanel />
          ) : t === 'library' ? (
            <LibraryPanel />
          ) : (
            <DocsPanel />
          )}
        </Box>
      ))}
    </Box>
  )
}
