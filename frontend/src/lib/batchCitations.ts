import { closeHistory } from '@tiptap/pm/history'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { PlacedAnnotation } from './review'
import { containingSentence, sentenceHasCitation } from './sentenceSpans'

type CitationNote = Extract<PlacedAnnotation, { kind: 'missing_citation' | 'cite_check' }>

export interface BatchCitationRow {
  id: string
  note: CitationNote
  from: number
  to: number
  insertAt: number
  selected: boolean
  paperId: string
  stale: boolean
  blockedReason?: string
}

export function createBatchRows(notes: PlacedAnnotation[], available: Set<string>, doc?: ProseMirrorNode): BatchCitationRow[] {
  return notes.filter((n): n is CitationNote => n.kind === 'missing_citation' || n.kind === 'cite_check').map((note) => {
    const candidates = note.kind === 'missing_citation' ? note.candidates.filter((c) => available.has(c.paper_id)) : []
    const supported = candidates.find((c) => c.verdict === 'supports')
    const candidate = supported ?? candidates.find((c) => c.verdict === 'partial')
    const row: BatchCitationRow = {
      id: `${note.key}:${note.from}`, note, from: note.from, to: note.to, insertAt: note.insertAt,
      selected: !!supported, paperId: candidate?.paper_id ?? '', stale: false,
    }
    if (doc) row.blockedReason = missingSentenceIssue(doc, row)
    if (row.blockedReason) row.selected = false
    return row
  })
}

function missingSentenceIssue(doc: ProseMirrorNode, row: BatchCitationRow): string | undefined {
  if (row.note.kind !== 'missing_citation') return undefined
  if (!matches(doc, row)) return '原句已变化，请重新检查'
  const start = doc.resolve(row.from)
  let plain = ''
  const positions: number[] = []
  const cites: { plainIdx: number }[] = []
  start.parent.forEach((child, offset) => {
    if (child.isText) {
      for (let i = 0; i < (child.text ?? '').length; i++) positions.push(start.start() + offset + i)
      plain += child.text
    } else if (child.type.name === 'citation') {
      cites.push({ plainIdx: plain.length })
    } else if (child.type.name === 'hardBreak') {
      positions.push(start.start() + offset)
      plain += '\n'
    }
  })
  const from = positions.indexOf(row.from)
  const to = positions.indexOf(row.to - 1) + 1
  const sentence = from >= 0 && to > from ? containingSentence(plain, from, to) : undefined
  if (!sentence) return '无法确定完整句子，请重新检查'
  if (sentenceHasCitation(sentence, cites)) return '这句话已有引用，请核查依据，不再重复补入'
  if (sentence.text !== row.note.anchor) return '建议只覆盖了句子的一部分，请重新检查全文后再处理'
  return undefined
}

function matches(doc: ProseMirrorNode, row: BatchCitationRow): boolean {
  if (row.stale || row.from < 0 || row.to > doc.content.size || row.from >= row.to || row.insertAt < row.from || row.insertAt > row.to) return false
  const start = doc.resolve(row.from)
  const end = doc.resolve(row.to)
  return start.sameParent(end) && start.parent.type.name === 'paragraph' && !start.parent.attrs.live
    && doc.textBetween(row.from, row.to, '', '') === row.note.anchor
}

/** Map the original occurrence through edits; never search for a similar sentence elsewhere. */
export function mapBatchRows(rows: BatchCitationRow[], transaction: Transaction): BatchCitationRow[] {
  if (!transaction.docChanged) return rows
  return rows.map((row) => {
    const mapped = { ...row }
    transaction.mapping.maps.forEach((map, index) => {
      map.forEach((oldFrom, oldTo, newFrom, newTo) => {
        if (oldFrom <= mapped.to && oldTo >= mapped.from) {
          const before = transaction.docs[index]
          const after = transaction.docs[index + 1] ?? transaction.doc
          // Include text edits at the sentence boundaries (e.g. a new qualifier),
          // while allowing citation atoms added by another action to be deduped.
          if (before.textBetween(oldFrom, oldTo, '', '') || after.textBetween(newFrom, newTo, '', '')) mapped.stale = true
        }
      })
      const from = map.mapResult(mapped.from, 1)
      const to = map.mapResult(mapped.to, -1)
      mapped.from = from.pos
      mapped.to = to.pos
      mapped.insertAt = map.map(mapped.insertAt, -1)
      mapped.stale ||= from.deletedAcross || to.deletedAcross
    })
    mapped.stale = !matches(transaction.doc, mapped)
    if (!mapped.stale) mapped.blockedReason = missingSentenceIssue(transaction.doc, mapped)
    return mapped
  })
}

export function canInsertRow(row: BatchCitationRow, available: Set<string>): boolean {
  return !row.stale && !row.blockedReason && row.note.kind === 'missing_citation' && available.has(row.paperId)
    && row.note.candidates.some((c) => c.paper_id === row.paperId && (c.verdict === 'supports' || c.verdict === 'partial'))
}

/** Legacy review keys can be shared by identical paragraphs. Never ignore an
 * unselected occurrence as a side effect of dismissing another occurrence. */
export function batchDismissalKeys(rows: BatchCitationRow[]) {
  const groups = new Map<string, BatchCitationRow[]>()
  for (const row of rows) {
    const key = row.note.dismissKey ?? row.note.key
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const keys: string[] = []
  let ignored = 0
  for (const [key, group] of groups) {
    if (group.every((row) => row.selected && !row.stale)) {
      keys.push(key)
      ignored += group.length
    }
  }
  return { keys, ignored, skipped: rows.filter((row) => row.selected).length - ignored }
}

/** Validate against the current document and build a single isolated undo event. */
export function batchCitationTransaction(state: EditorState, rows: BatchCitationRow[], available: Set<string>) {
  const transaction = closeHistory(state.tr)
  const schema = state.schema.nodes.citation
  const groups = new Map<number, Set<string>>()
  const seen = new Set<string>()
  let inserted = 0
  let skipped = 0
  for (const row of rows.filter((r) => r.selected)) {
    if (!schema || !canInsertRow(row, available) || !matches(state.doc, row) || missingSentenceIssue(state.doc, row)) {
      skipped++
      continue
    }
    const key = `${row.from}:${row.to}`
    let exists = seen.has(key)
    state.doc.nodesBetween(row.from, row.to, (node) => {
      if (node.type.name === 'citation' && (node.attrs.ids as string[]).includes(row.paperId)) exists = true
    })
    // Also recognize citations directly after the sentence punctuation.
    const after = state.doc.nodeAt(row.to)
    if (after?.type.name === 'citation' && (after.attrs.ids as string[]).includes(row.paperId)) exists = true
    if (exists) {
      skipped++
      continue
    }
    seen.add(key)
    const ids = groups.get(row.insertAt) ?? new Set<string>()
    ids.add(row.paperId)
    groups.set(row.insertAt, ids)
    inserted++
  }
  // Later insertions must not shift positions still to be processed.
  for (const [pos, ids] of [...groups].sort(([a], [b]) => b - a)) {
    const at = state.doc.nodeAt(pos)
    const before = state.doc.resolve(pos).nodeBefore
    const existing = at?.type.name === 'citation' ? at : before?.type.name === 'citation' ? before : null
    if (existing) {
      const citePos = at === existing ? pos : pos - existing.nodeSize
      transaction.setNodeMarkup(citePos, undefined, { ...existing.attrs, ids: [...new Set([...existing.attrs.ids, ...ids])] })
    } else {
      transaction.insert(pos, schema.create({ ids: [...ids] }))
    }
  }
  return { transaction, inserted, skipped }
}
