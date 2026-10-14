import { Box, Typography } from '@mui/material'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import AddIcon from '@mui/icons-material/Add'
import { useApp } from '../lib/appContext'
import { createDoc, relTime, useDocList } from '../lib/docs'
import { Card, SectionLabel, Thread, ThreadItem } from '../components/Thread'
import { brand } from '../theme'

export function DocsPanel() {
  const { docId, setDocId, bumpDocs } = useApp()
  const docs = useDocList()
  return (
    <Box sx={{ height: '100%', overflow: 'auto', px: 2, pt: 1.75, pb: 2 }}>
      <SectionLabel>我的论文 · {docs.length} 篇</SectionLabel>
      <Thread>
        {docs.map((d) => (
          <ThreadItem key={d.id} icon={<DescriptionOutlinedIcon />} dense>
            <Card variant={d.id === docId ? 'data' : 'plain'} onClick={() => setDocId(d.id)}>
              <Typography noWrap sx={{ fontSize: 13, fontWeight: d.id === docId ? 500 : 400 }}>
                {d.title}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: brand.muted }}>{relTime(d.updated_at)} 编辑</Typography>
            </Card>
          </ThreadItem>
        ))}
        <ThreadItem dense>
          <Card
            variant="dashed"
            onClick={async () => {
              const d = await createDoc()
              bumpDocs()
              setDocId(d.id)
            }}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: brand.muted }}
          >
            <AddIcon sx={{ fontSize: 16 }} /> 新建论文
          </Card>
        </ThreadItem>
      </Thread>
    </Box>
  )
}
