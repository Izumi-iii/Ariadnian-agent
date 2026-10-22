import { useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle,
  MenuItem, Tab, Tabs, TextField, Typography,
} from '@mui/material'
import { useApp } from '../lib/appContext'
import { authorYearLabel, citeStore, useCiteState } from '../lib/citations'
import {
  batchCitationTransaction, batchDismissalKeys, canInsertRow, createBatchRows, mapBatchRows, type BatchCitationRow,
} from '../lib/batchCitations'
import type { PlacedAnnotation } from '../lib/review'
import { VerdictChip } from '../panels/CitePanel'
import { brand } from '../theme'

type Group = 'supported' | 'manual' | 'issues'

function groupOf(row: BatchCitationRow, available: Set<string>): Group {
  if (row.note.kind === 'cite_check') return 'issues'
  if (row.blockedReason) return 'manual'
  return row.note.candidates.some((c) => c.verdict === 'supports' && available.has(c.paper_id)) ? 'supported' : 'manual'
}

export function BatchCitationsDialog({ editor, notes, coverage, onClose, onDismissMany }: {
  editor: Editor
  notes: PlacedAnnotation[]
  coverage: { checked: number; total: number; pending: number }
  onClose: () => void
  onDismissMany: (keys: string[]) => void
}) {
  const { notify, openReader, requestCitations } = useApp()
  const { papers } = useCiteState()
  const available = useMemo(() => new Set(Object.keys(papers)), [papers])
  // Freeze the suggestions at open time; map positions as the document changes.
  const [rows, setRows] = useState(() => createBatchRows(notes, available, editor.state.doc))
  const [group, setGroup] = useState<Group>('supported')
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) setRows((current) => mapBatchRows(current, transaction))
    }
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor])

  const shown = rows.filter((r) => groupOf(r, available) === group)
  const selected = rows.filter((r) => r.selected)
  const insertable = selected.filter((r) => canInsertRow(r, available))
  const update = (id: string, changes: Partial<BatchCitationRow>) => setRows((current) => current.map((r) => r.id === id ? { ...r, ...changes } : r))
  const selectGroup = (checked: boolean) => setRows((current) => current.map((r) => groupOf(r, available) === group && !r.stale ? { ...r, selected: checked } : r))

  const insert = () => {
    if (editor.isDestroyed) return
    const result = batchCitationTransaction(editor.state, rows, new Set(Object.keys(citeStore.get().papers)))
    if (!result.inserted) {
      notify('未插入：原句已变化、引用已存在或所选项没有可用候选，请重新检查选择', 'warning')
      return
    }
    editor.view.dispatch(result.transaction)
    // Isolate subsequent typing from this batch as well as previous edits.
    editor.view.dispatch(closeHistory(editor.state.tr))
    onClose()
    editor.commands.focus(undefined, { scrollIntoView: false })
    notify(`已处理 ${result.inserted} 条引用建议${result.skipped ? `，跳过 ${result.skipped} 项（含需单独审阅或已失效的项）` : ''}；可撤销本次全部插入`, 'success')
  }

  const dismiss = () => {
    const result = batchDismissalKeys(rows)
    if (!result.ignored) {
      notify('未忽略：原句已变化，或相同段落的重复建议尚未一并选中', 'warning')
      return
    }
    onDismissMany(result.keys)
    onClose()
    notify(`已忽略 ${result.ignored} 条建议${result.skipped ? `，跳过 ${result.skipped} 项（原句已变化或重复建议未全选）` : ''}；正文未修改`, 'info')
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="batch-citations-title">
      <DialogTitle id="batch-citations-title">批量处理引用</DialogTitle>
      <DialogContent dividers sx={{ p: { xs: 1.5, sm: 3 } }}>
        {(coverage.pending > 0 || coverage.checked < coverage.total) && <Alert severity="warning" sx={{ mb: 1.5 }}>
          全文检查尚未完成：已覆盖 {coverage.checked}/{coverage.total} 段。此处为打开时的结果，后续提示数量仍可能变化。
        </Alert>}
        <Alert severity="info" sx={{ mb: 1.5 }}>
          只为尚无引用的完整句子补入文献，默认选中每句一个判为“支持”的候选。“部分支持”需手动确认；请结合原文核对模型判断。
        </Alert>
        <Typography sx={{ fontSize: 12, color: brand.muted, mb: 1 }}>
          使用打开面板时的建议；原句改动后会跳过。新检查结果可关闭后重新打开查看。插入可一次撤销。
        </Typography>
        <Tabs value={group} onChange={(_, value: Group) => setGroup(value)} variant="scrollable" allowScrollButtonsMobile>
          <Tab value="supported" label={`有支持候选 ${rows.filter((r) => groupOf(r, available) === 'supported').length}`} />
          <Tab value="manual" label={`待确认 ${rows.filter((r) => groupOf(r, available) === 'manual').length}`} />
          <Tab value="issues" label={`已有引用问题 ${rows.filter((r) => groupOf(r, available) === 'issues').length}`} />
        </Tabs>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', my: 1 }}>
          <Button size="small" onClick={() => selectGroup(true)} disabled={!shown.some((r) => !r.stale)}>选中本组</Button>
          <Button size="small" onClick={() => selectGroup(false)}>清空本组</Button>
          <Typography sx={{ fontSize: 12, color: brand.muted }}>跨分组共选中 {selected.length} 项</Typography>
        </Box>
        {group === 'issues' && <Alert severity="warning" sx={{ mb: 1.5 }}>已有引用的问题需要核对原文、替换引用或修改表述，此处仅支持逐条审阅或批量忽略。</Alert>}
        {!shown.length && <Typography sx={{ py: 4, textAlign: 'center', color: brand.muted }}>本组暂无建议</Typography>}
        {shown.map((row, index) => {
          const note = row.note
          const candidates = note.kind === 'missing_citation' ? note.candidates.filter((c) => available.has(c.paper_id) && ['supports', 'partial'].includes(c.verdict)) : []
          const chosen = candidates.find((c) => c.paper_id === row.paperId)
          return (
            <Box key={row.id} sx={{ mb: 1.5, p: 1.5, border: `1px solid ${brand.line}`, borderRadius: 2, opacity: row.stale ? 0.6 : 1 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Checkbox checked={row.selected} disabled={row.stale} onChange={(_, checked) => update(row.id, { selected: checked })}
                  slotProps={{ input: { 'aria-label': `选择第 ${index + 1} 条建议：${note.anchor}` } }} sx={{ p: 0.25 }} />
                <Typography sx={{ fontSize: 14, lineHeight: 1.8, flex: 1 }}>{note.anchor}</Typography>
              </Box>
              {row.stale || row.blockedReason ? <Typography color="warning.main" sx={{ fontSize: 12, mt: 1 }}>{row.blockedReason || '原句已变化，将跳过本项。请重新检查正文。'}</Typography> : (
                <Box sx={{ ml: 4, mt: 1 }}>
                  {note.kind === 'missing_citation' ? (
                    <>
                      {candidates.length ? (
                        <TextField select size="small" fullWidth label="插入的文献" value={chosen?.paper_id ?? ''}
                          onChange={(e) => update(row.id, { paperId: e.target.value, selected: true })}>
                          <MenuItem value="" disabled>请选择候选文献</MenuItem>
                          {candidates.map((c) => <MenuItem key={c.paper_id} value={c.paper_id} sx={{ whiteSpace: 'normal' }}>
                            {c.verdict === 'supports' ? '支持' : '部分支持'} · {authorYearLabel(papers[c.paper_id])} · {c.title}
                          </MenuItem>)}
                        </TextField>
                      ) : <Typography sx={{ color: brand.muted, fontSize: 12 }}>没有可直接补入的候选，可去检索或勾选后忽略。</Typography>}
                      {chosen && <Box sx={{ mt: 1 }}>
                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                          <VerdictChip v={chosen.verdict} />
                          {chosen.page && <Typography sx={{ fontSize: 12, color: brand.muted }}>依据页码：{chosen.page}</Typography>}
                        </Box>
                        {chosen.reason && <Typography sx={{ fontSize: 12, mt: 0.5 }}>{chosen.reason}</Typography>}
                        {chosen.snippet && <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.5, whiteSpace: 'pre-wrap' }}>{chosen.snippet}</Typography>}
                        <Button size="small" onClick={() => {
                          openReader({ paperId: chosen.paper_id, claim: note.anchor, evidences: [{ page: chosen.page, snippet: chosen.snippet, verdict: chosen.verdict, reason: chosen.reason }] })
                          onClose()
                        }}>查看原文</Button>
                      </Box>}
                    </>
                  ) : note.items.filter((item) => item.verdict !== 'supports').map((item) => (
                    <Box key={item.bibkey} sx={{ mb: 1 }}>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}><VerdictChip v={item.verdict} /><Typography sx={{ fontSize: 12 }}>{item.title || item.bibkey}</Typography></Box>
                      <Typography sx={{ fontSize: 12, color: brand.muted, mt: 0.5 }}>{item.reason}</Typography>
                    </Box>
                  ))}
                  <Button size="small" onClick={() => { requestCitations(note.anchor, row.insertAt); onClose() }}>
                    {note.kind === 'cite_check' ? '逐条审阅 / 换引用' : '去检索其他文献'}
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={dismiss} disabled={!selected.some((r) => !r.stale)} sx={{ color: brand.muted }}>忽略所选 {selected.filter((r) => !r.stale).length} 项</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>关闭</Button>
        <Button variant="contained" onClick={insert} disabled={!insertable.length}>批量插入 {insertable.length} 项</Button>
      </DialogActions>
    </Dialog>
  )
}
