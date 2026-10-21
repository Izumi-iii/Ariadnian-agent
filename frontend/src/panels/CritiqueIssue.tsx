/**
 * 一条审稿意见的内容与操作：页边批注卡片和 Agent 面板的意见列表共用。
 * 作者可以标「已修改」，或者「不改」并写下理由（下一轮会作为对审稿人的回复发过去）。
 */
import { useState } from 'react'
import { Box, Button, Chip, IconButton, InputBase, Tooltip, Typography } from '@mui/material'
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined'
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined'
import CheckIcon from '@mui/icons-material/Check'
import UndoIcon from '@mui/icons-material/Undo'
import { useApp } from '../lib/appContext'
import { authorYearLabel, citeStore } from '../lib/citations'
import { CATEGORY_LABEL, critiqueStore, useCritique, type CritiqueIssue } from '../lib/critique'
import { brand } from '../theme'

export const severityColor = (s: string) => (s === 'major' ? brand.red : brand.amber)

const FOLLOW: Record<string, string> = { partial: '上一轮改得还不够', unresolved: '上一轮没有解决' }

export function IssueHeader({ issue, compact }: { issue: CritiqueIssue; compact?: boolean }) {
  const c = severityColor(issue.severity)
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
      {!compact && <RateReviewOutlinedIcon sx={{ fontSize: 15, color: c }} />}
      <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: c, whiteSpace: 'nowrap' }}>
        {compact ? '' : '审稿意见 · '}
        {CATEGORY_LABEL[issue.category] ?? issue.category}
      </Typography>
      <Chip
        size="small"
        label={issue.severity === 'major' ? '主要' : '次要'}
        sx={{ height: 17, fontSize: 10.5, color: c, bgcolor: issue.severity === 'major' ? 'rgba(164,38,44,0.08)' : 'rgba(183,121,31,0.1)' }}
      />
      {issue.followup && issue.followup.status !== 'resolved' && (
        <Tooltip title={issue.followup.comment || ''}>
          <Chip size="small" label={FOLLOW[issue.followup.status] ?? '仍未解决'} sx={{ height: 17, fontSize: 10.5, bgcolor: 'rgba(0,0,0,0.06)', color: brand.muted }} />
        </Tooltip>
      )}
    </Box>
  )
}

/** 意见正文 + 建议 + 可用文献 + 作者的处理 */
export function IssueBody({ issue, insertAt }: { issue: CritiqueIssue; insertAt?: number }) {
  const { editor, notify, openReader, requestCitations } = useApp()
  const { responses, finished } = useCritique()
  const resp = responses[issue.id]
  const [rebut, setRebut] = useState<string | null>(null)
  const papers = citeStore.get().papers
  return (
    <Box>
      <Typography sx={{ fontSize: 12.5, color: brand.ink, lineHeight: 1.6, mt: 0.5 }}>{issue.comment}</Typography>
      {issue.suggestion && (
        <Typography sx={{ fontSize: 12, color: brand.muted, lineHeight: 1.6, mt: 0.5 }}>
          <b style={{ color: brand.ink, fontWeight: 500 }}>建议：</b>
          {issue.suggestion}
        </Typography>
      )}
      {issue.followup?.comment && issue.followup.status !== 'resolved' && (
        <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.5, pl: 1, borderLeft: `2px solid ${brand.line}` }}>
          第 {issue.followup.round} 轮复查：{issue.followup.comment}
        </Typography>
      )}
      {issue.candidates?.length > 0 && (
        <Box sx={{ mt: 0.75 }}>
          <Typography sx={{ fontSize: 11.5, color: brand.faint }}>文献库里可能用得上的：</Typography>
          {issue.candidates.map((c) => (
            <Box key={c.paper_id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
              <Typography noWrap sx={{ fontSize: 12, flex: 1, minWidth: 0 }} title={c.title}>
                {papers[c.paper_id] ? authorYearLabel(papers[c.paper_id]) : c.title}
              </Typography>
              <Tooltip title={c.page ? `看原文 p.${c.page}` : '看原文'}>
                <IconButton
                  aria-label="看原文"
                  onClick={() => openReader({ paperId: c.paper_id, claim: issue.anchor, insertAt, evidences: [{ page: c.page, snippet: c.snippet }] })}
                  sx={{ p: 0.25, color: brand.blue }}
                >
                  <PictureAsPdfOutlinedIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
              {editor && insertAt != null && (
                <Button
                  size="small"
                  onClick={() => {
                    editor.chain().focus().insertContentAt(insertAt, { type: 'citation', attrs: { ids: [c.paper_id] } }).run()
                    notify('已插入引用', 'success')
                  }}
                  sx={{ py: 0, minHeight: 22, fontSize: 11.5 }}
                >
                  插入
                </Button>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* 作者的处理 */}
      {resp ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
          <Chip
            size="small"
            icon={resp.status === 'fixed' ? <CheckIcon /> : undefined}
            label={resp.status === 'fixed' ? '已修改' : `不改${resp.note ? `：${resp.note}` : ''}`}
            sx={{
              height: 22, fontSize: 11.5, maxWidth: 220, color: resp.status === 'fixed' ? brand.green : brand.muted,
              bgcolor: resp.status === 'fixed' ? 'rgba(46,125,50,0.09)' : 'rgba(0,0,0,0.06)', '& svg': { fontSize: 14, color: 'inherit' },
            }}
          />
          {!finished && (
            <Tooltip title="撤销">
              <IconButton aria-label="撤销" onClick={() => critiqueStore.respond(issue.id, null)} sx={{ p: 0.25, color: brand.faint }}>
                <UndoIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      ) : rebut != null ? (
        <Box sx={{ mt: 1 }}>
          <InputBase
            autoFocus
            fullWidth
            multiline
            maxRows={4}
            placeholder="写给审稿人的理由，例如：这部分在第 4 节有实验支撑"
            value={rebut}
            onChange={(e) => setRebut(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) critiqueStore.respond(issue.id, { status: 'rebut', note: rebut.trim() })
              if (e.key === 'Escape') setRebut(null)
            }}
            sx={{ fontSize: 12, border: `1px solid ${brand.line}`, borderRadius: '6px', px: 1, py: 0.5, bgcolor: '#fff' }}
          />
          <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, '& .MuiButton-root': { py: 0.1, px: 1, fontSize: 12 } }}>
            <Button variant="contained" onClick={() => critiqueStore.respond(issue.id, { status: 'rebut', note: rebut.trim() })}>
              提交
            </Button>
            <Button onClick={() => setRebut(null)} sx={{ color: brand.muted }}>
              取消
            </Button>
          </Box>
        </Box>
      ) : (
        !finished && (
          <Box sx={{ display: 'flex', gap: 0.5, mt: 1, alignItems: 'center', '& .MuiButton-root': { py: 0.1, px: 1, fontSize: 12 } }}>
            <Button variant="outlined" onClick={() => critiqueStore.respond(issue.id, { status: 'fixed' })} sx={{ bgcolor: '#fff' }}>
              已修改
            </Button>
            <Button onClick={() => setRebut('')} sx={{ color: brand.muted }}>
              不改…
            </Button>
            {issue.category === 'evidence' && issue.anchor && insertAt != null && (
              <Button onClick={() => requestCitations(issue.anchor, insertAt)}>找文献</Button>
            )}
          </Box>
        )
      )}
    </Box>
  )
}
