import { useEffect, useState } from 'react'
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material'
import { api } from '../lib/api'
import { useApp } from '../lib/appContext'
import type { TierStats } from '../lib/types'
import { brand } from '../theme'

const TIER_LABEL: Record<string, [string, string]> = {
  complete: ['行内续写', '延迟最敏感'],
  write: ['改写 / 问答', '质量优先，流式'],
  judge: ['引用判断', '量大，便宜稳定'],
  agent: ['综述 / 大纲', '长上下文，JSON'],
}

const ms = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`)

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { health } = useApp()
  const [stats, setStats] = useState<Record<string, TierStats> | null>(null)
  useEffect(() => {
    if (open) api.llmStats().then((s) => setStats(s.tiers)).catch(() => setStats(null))
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>模型设置</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          通过 LiteLLM 接入，按任务分四档模型。修改请编辑 <code>backend/.env</code>（MODEL_COMPLETE / MODEL_WRITE / MODEL_JUDGE / MODEL_AGENT）后重启后端。
          {health?.fake && (
            <Chip size="small" label="当前为离线演示模式 LLM_FAKE=1" sx={{ ml: 1, bgcolor: 'rgba(200,90,23,0.1)', color: brand.orange }} />
          )}
        </Typography>
        <Table size="small" sx={{ '& td, & th': { borderColor: brand.lineSoft, fontSize: 12.5, py: 1 } }}>
          <TableHead>
            <TableRow sx={{ '& th': { color: brand.muted, fontWeight: 500 } }}>
              <TableCell>档位</TableCell>
              <TableCell>模型</TableCell>
              <TableCell align="right">超时</TableCell>
              <TableCell align="right">调用</TableCell>
              <TableCell align="right">P50 / P95</TableCell>
              <TableCell align="right">首 token</TableCell>
              <TableCell align="right">tokens</TableCell>
              <TableCell align="right">费用</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {health &&
              (Object.keys(TIER_LABEL) as (keyof typeof health.tiers)[]).map((k) => {
                const t = health.tiers[k]
                const s = stats?.[k]
                return (
                  <TableRow key={k}>
                    <TableCell>
                      <Box sx={{ fontWeight: 500 }}>{TIER_LABEL[k][0]}</Box>
                      <Box sx={{ color: brand.faint, fontSize: 11 }}>{TIER_LABEL[k][1]}</Box>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ fontFamily: 'Roboto Mono', fontSize: 12 }}>{t.model}</Box>
                      {t.fallbacks.length > 0 && <Box sx={{ color: brand.faint, fontSize: 11 }}>备用：{t.fallbacks.join(', ')}</Box>}
                    </TableCell>
                    <TableCell align="right">{t.timeout}s</TableCell>
                    <TableCell align="right">
                      {s?.calls ?? 0}
                      {s?.errors ? <Box component="span" sx={{ color: brand.red }}> · {s.errors} 失败</Box> : null}
                    </TableCell>
                    <TableCell align="right">
                      {ms(s?.latency_p50_ms ?? null)} / {ms(s?.latency_p95_ms ?? null)}
                    </TableCell>
                    <TableCell align="right">{ms(s?.first_token_p50_ms ?? null)}</TableCell>
                    <TableCell align="right">{s ? (s.prompt_tokens + s.completion_tokens).toLocaleString() : '—'}</TableCell>
                    <TableCell align="right">{s?.cost_usd ? `$${s.cost_usd}` : '—'}</TableCell>
                  </TableRow>
                )
              })}
          </TableBody>
        </Table>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1.5 }}>
          统计最近 30 天。费用由 LiteLLM 按公开价格估算，部分国内模型可能没有价格数据。
          {health?.embedding ? ` 向量模型：${health.embedding}` : ' 未启用向量检索（仅 BM25）。'}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  )
}
