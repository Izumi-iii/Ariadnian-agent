import { Box } from '@mui/material'
import { PillToggle } from '../components/Thread'
import { useApp, type RightTab } from '../lib/appContext'
import { AgentPanel } from './AgentPanel'
import { AskPanel } from './AskPanel'
import { CitePanel } from './CitePanel'

/** 左侧「AI 助手」列：综述 Agent / 找引用 / 文献问答，共用时间线样式和底部输入框 */
export function AssistantPanel() {
  const { rightTab, setRightTab } = useApp()
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 1, display: 'flex' }}>
        <PillToggle<RightTab>
          value={rightTab}
          onChange={setRightTab}
          options={[
            ['agent', '综述 Agent'],
            ['cite', '找引用'],
            ['ask', '文献问答'],
          ]}
        />
      </Box>
      {(['agent', 'cite', 'ask'] as RightTab[]).map((t) => (
        <Box key={t} sx={{ flex: 1, minHeight: 0, display: rightTab === t ? 'flex' : 'none', flexDirection: 'column' }}>
          {t === 'agent' ? <AgentPanel /> : t === 'cite' ? <CitePanel /> : <AskPanel />}
        </Box>
      ))}
    </Box>
  )
}
