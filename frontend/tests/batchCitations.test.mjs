import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { closeHistory, history, undo } from '@tiptap/pm/history'

// Compile the pure transaction helper with the existing TypeScript dependency.
// This keeps the tests runnable on Node 20 without a browser or another runner.
const cache = new URL('../node_modules/.cache/ariadne-tests/', import.meta.url)
mkdirSync(cache, { recursive: true })
const compiled = new URL(`batch-citations-${process.pid}.mjs`, cache)
const compiledSpans = new URL(`sentence-spans-${process.pid}.mjs`, cache)
const compiledPolicy = new URL(`review-policy-${process.pid}.mjs`, cache)
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
writeFileSync(compiledSpans, ts.transpileModule(readFileSync(new URL('../src/lib/sentenceSpans.ts', import.meta.url), 'utf8'), { compilerOptions }).outputText)
writeFileSync(compiledPolicy, ts.transpileModule(readFileSync(new URL('../src/lib/reviewPolicy.ts', import.meta.url), 'utf8'), { compilerOptions }).outputText)
const { stabilizeProse, rememberProse, reviewDismissKey, rewriteTransaction } = await import(compiledPolicy.href)
const source = readFileSync(new URL('../src/lib/batchCitations.ts', import.meta.url), 'utf8')
writeFileSync(compiled, ts.transpileModule(source, {
  compilerOptions,
}).outputText.replace(/(['"])\.\/sentenceSpans\1/g, JSON.stringify(compiledSpans.href)))
const { batchCitationTransaction, batchDismissalKeys, canInsertRow, createBatchRows, mapBatchRows } = await import(pathToFileURL(fileURLToPath(compiled)).href)
after(() => { unlinkSync(compiled); unlinkSync(compiledSpans); unlinkSync(compiledPolicy) })

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' },
  paragraph: { content: 'inline*', group: 'block', attrs: { live: { default: false } } },
  text: { group: 'inline' },
  citation: { inline: true, atom: true, group: 'inline', attrs: { ids: { default: [] }, pages: { default: {} } } },
} })
const available = new Set(['paper-a', 'paper-b'])
const sentence = '检索增强方法可以改善回答质量。'
function document(...texts) {
  return schema.node('doc', null, texts.map((t) => schema.node('paragraph', null, schema.text(t))))
}
function stateFor(doc) {
  return EditorState.create({ schema, doc, plugins: [history()] })
}
function noteFor(doc, index = 0, anchor = sentence, verdict = 'supports') {
  const paragraphs = []
  doc.descendants((node, pos) => { if (node.type.name === 'paragraph') paragraphs.push({ node, pos }) })
  const { node, pos } = paragraphs[index]
  const from = pos + 1 + node.textContent.indexOf(anchor)
  return {
    id: 'missing-1', key: `same-hash:missing-1`, kind: 'missing_citation', anchor, reason: 'needs evidence',
    from, to: from + anchor.length, insertAt: from + anchor.length - 1, paraPos: pos, citePos: [], card: true,
    candidates: [{ paper_id: 'paper-a', bibkey: 'a2024', title: 'Paper A', verdict }],
  }
}
function citations(doc) {
  const out = []
  doc.descendants((node, pos) => { if (node.type.name === 'citation') out.push({ pos, ids: node.attrs.ids, pages: node.attrs.pages }) })
  return out
}

test('defaults select supported candidates only, with a manual opt-in for partial support', () => {
  const doc = document(sentence, sentence, sentence)
  const rows = createBatchRows([
    noteFor(doc, 0), noteFor(doc, 1, sentence, 'partial'), noteFor(doc, 2, sentence, 'unknown'),
  ], available)
  assert.deepEqual(rows.map((r) => r.selected), [true, false, false])
  assert.equal(canInsertRow(rows[2], available), false)
  const result = batchCitationTransaction(stateFor(doc), rows.map((r, i) => i === 1 ? { ...r, selected: true } : r), available)
  assert.equal(result.inserted, 2)
})

test('inserts into repeated sentences at their own positions, preserving punctuation and Unicode', () => {
  const doc = document('😀' + sentence, sentence)
  const rows = createBatchRows([noteFor(doc, 0, '😀' + sentence), noteFor(doc, 1)], available)
  assert.notEqual(rows[0].id, rows[1].id)
  const result = batchCitationTransaction(stateFor(doc), rows, available)
  assert.equal(result.inserted, 2)
  assert.equal(citations(result.transaction.doc).length, 2)
  assert.equal(result.transaction.doc.textContent, doc.textContent)
  assert.equal(result.transaction.doc.child(0).lastChild.text, '。')
  assert.equal(result.transaction.doc.child(1).lastChild.text, '。')
})

test('one undo removes the whole batch without undoing previous typing', () => {
  const original = document('前言', sentence, sentence)
  let state = stateFor(original)
  state = state.apply(state.tr.insertText('补充', 1))
  const beforeBatch = state.doc
  const rows = createBatchRows([noteFor(state.doc, 1), noteFor(state.doc, 2)], available)
  state = state.apply(batchCitationTransaction(state, rows, available).transaction)
  state = state.apply(closeHistory(state.tr))
  assert.equal(citations(state.doc).length, 2)
  assert.equal(undo(state, (tr) => { state = state.apply(tr) }), true)
  assert.equal(state.doc.eq(beforeBatch), true)
  assert.equal(undo(state, (tr) => { state = state.apply(tr) }), true)
  assert.equal(state.doc.eq(original), true)
})

test('multiple sentences in one paragraph receive the intended papers', () => {
  const second = '结构化记忆也需要独立评测。'
  const doc = document(sentence + second)
  const note = noteFor(doc, 0, second)
  note.candidates = [{ paper_id: 'paper-b', bibkey: 'b2024', title: 'Paper B', verdict: 'supports' }]
  const rows = createBatchRows([noteFor(doc, 0), note], available)
  const result = batchCitationTransaction(stateFor(doc), rows, available)
  assert.equal(result.inserted, 2)
  assert.deepEqual(citations(result.transaction.doc).map((c) => c.ids), [['paper-a'], ['paper-b']])
  assert.equal(result.transaction.doc.textContent, doc.textContent)
  assert.equal(result.transaction.doc.child(0).child(2).text, '。' + second.slice(0, -1))
})

test('typing after the batch has a separate undo event', () => {
  let state = stateFor(document(sentence))
  const rows = createBatchRows([noteFor(state.doc)], available)
  state = state.apply(batchCitationTransaction(state, rows, available).transaction)
  state = state.apply(closeHistory(state.tr))
  const afterBatch = state.doc
  state = state.apply(state.tr.insertText('新内容', 1))
  undo(state, (tr) => { state = state.apply(tr) })
  assert.equal(state.doc.eq(afterBatch), true)
})

test('maps edits before later sentences and skips the sentence that was changed', () => {
  let state = stateFor(document(sentence, sentence))
  let rows = createBatchRows([noteFor(state.doc, 0), noteFor(state.doc, 1)], available)
  const edit = state.tr.insertText('改动', rows[0].from + 2)
  rows = mapBatchRows(rows, edit)
  state = state.apply(edit)
  assert.equal(rows[0].stale, true)
  assert.equal(rows[1].stale, false)
  const result = batchCitationTransaction(state, rows, available)
  assert.equal(result.inserted, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.transaction.doc.child(0).childCount, 1)
  assert.equal(result.transaction.doc.child(1).childCount, 3)
})

test('does not relocate a deleted sentence to an identical occurrence', () => {
  let state = stateFor(document(sentence, sentence))
  let rows = createBatchRows([noteFor(state.doc, 0)], available)
  const edit = state.tr.delete(0, state.doc.firstChild.nodeSize)
  rows = mapBatchRows(rows, edit)
  state = state.apply(edit)
  const result = batchCitationTransaction(state, rows, available)
  assert.equal(result.inserted, 0)
  assert.equal(result.skipped, 1)
})

test('text added at the sentence boundary invalidates the preview', () => {
  const state = stateFor(document(sentence))
  const rows = createBatchRows([noteFor(state.doc)], available)
  const edit = state.tr.insertText('仅在特定场景下，', rows[0].from)
  const mapped = mapBatchRows(rows, edit)
  assert.equal(mapped[0].stale, true)
  assert.equal(batchCitationTransaction(state.apply(edit), mapped, available).inserted, 0)
})

test('maps multi-step transactions without shifting later citations to the wrong sentence', () => {
  const state = stateFor(document('前言', sentence, sentence))
  const rows = createBatchRows([noteFor(state.doc, 1), noteFor(state.doc, 2)], available)
  const edit = state.tr.insertText('开头', 1).insertText('更多', 2)
  const mapped = mapBatchRows(rows, edit)
  const result = batchCitationTransaction(state.apply(edit), mapped, available)
  assert.equal(result.inserted, 2)
  assert.equal(result.transaction.doc.child(0).childCount, 1)
  assert.equal(result.transaction.doc.child(1).childCount, 3)
  assert.equal(result.transaction.doc.child(2).childCount, 3)
})

test('skips an already-cited sentence, including attempts to add another paper', () => {
  let state = stateFor(document(sentence))
  let rows = createBatchRows([noteFor(state.doc)], available)
  const edit = state.tr.insert(rows[0].insertAt, schema.nodes.citation.create({ ids: ['paper-a'], pages: { 'paper-a': '3' } }))
  rows = mapBatchRows(rows, edit)
  state = state.apply(edit)
  assert.equal(batchCitationTransaction(state, rows, available).inserted, 0)
  rows = rows.map((r) => ({ ...r, paperId: 'paper-b', note: { ...r.note, candidates: [...r.note.candidates, { paper_id: 'paper-b', verdict: 'supports' }] } }))
  const result = batchCitationTransaction(state, rows, available)
  assert.equal(result.inserted, 0)
  assert.deepEqual(citations(result.transaction.doc).map((c) => c.ids), [['paper-a']])
  assert.deepEqual(citations(result.transaction.doc)[0].pages, { 'paper-a': '3' })
})

test('recognizes a duplicate directly after sentence punctuation', () => {
  let state = stateFor(document(sentence))
  let rows = createBatchRows([noteFor(state.doc)], available)
  const edit = state.tr.insert(rows[0].to, schema.nodes.citation.create({ ids: ['paper-a'] }))
  rows = mapBatchRows(rows, edit)
  state = state.apply(edit)
  assert.equal(batchCitationTransaction(state, rows, available).inserted, 0)
})

test('rejects removed papers, duplicate suggestions, active drafts and changed text at apply time', () => {
  let state = stateFor(document(sentence))
  const rows = createBatchRows([noteFor(state.doc)], available)
  assert.equal(batchCitationTransaction(state, rows, new Set()).inserted, 0)
  const duplicate = batchCitationTransaction(state, [rows[0], rows[0]], available)
  assert.equal(duplicate.inserted, 1)
  assert.equal(duplicate.skipped, 1)
  state = state.apply(state.tr.setNodeMarkup(0, undefined, { live: true }))
  assert.equal(batchCitationTransaction(state, rows, available).inserted, 0)
  state = stateFor(document('其他句子，长度与原句不同。'))
  assert.equal(batchCitationTransaction(state, rows, available).inserted, 0)
})

test('existing citation issues cannot be batch-inserted', () => {
  const doc = document(sentence)
  const issue = { ...noteFor(doc), kind: 'cite_check', items: [] }
  const rows = createBatchRows([issue], available).map((r) => ({ ...r, selected: true, paperId: 'paper-a' }))
  const result = batchCitationTransaction(stateFor(doc), rows, available)
  assert.equal(result.inserted, 0)
  assert.equal(result.skipped, 1)
  assert.equal(result.transaction.docChanged, false)
})

test('batch ignore never dismisses an unselected occurrence with the same review key', () => {
  const doc = document(sentence, sentence)
  const rows = createBatchRows([noteFor(doc, 0), noteFor(doc, 1)], available)
  rows[1].selected = false
  assert.deepEqual(batchDismissalKeys(rows), { keys: [], ignored: 0, skipped: 1 })
  rows[1].selected = true
  assert.deepEqual(batchDismissalKeys(rows), { keys: ['same-hash:missing-1'], ignored: 2, skipped: 0 })
})

test('batch ignore skips stale rows and keeps other selections', () => {
  const doc = document(sentence, sentence)
  const notes = [noteFor(doc, 0), { ...noteFor(doc, 1), key: 'other-hash:missing-1' }]
  const rows = createBatchRows(notes, available)
  rows[0].stale = true
  assert.deepEqual(batchDismissalKeys(rows), { keys: ['other-hash:missing-1'], ignored: 1, skipped: 1 })
})

test('stale subclause suggestions cannot add citations to a sentence that is already cited', () => {
  const prefix = '在限定的实验中，'
  const text = prefix + sentence
  const doc = document(text)
  let state = stateFor(doc)
  const note = noteFor(doc, 0, sentence)
  const edit = state.tr.insert(1 + prefix.length, schema.nodes.citation.create({ ids: ['paper-b'] }))
  const rows = mapBatchRows(createBatchRows([note], available), edit)
  state = state.apply(edit)
  assert.equal(batchCitationTransaction(state, rows, available).inserted, 0)
  const snapshot = createBatchRows([{ ...note, from: note.from + 1, to: note.to + 1, insertAt: note.insertAt + 1 }], available, state.doc)
  assert.equal(snapshot[0].selected, false)
  assert.match(snapshot[0].blockedReason, /已有引用/)
})

test('uncited subclauses require a fresh full-sentence judgment before batch insertion', () => {
  const doc = document('在限定的实验中，' + sentence)
  const rows = createBatchRows([noteFor(doc, 0, sentence)], available, doc)
  assert.equal(rows[0].selected, false)
  rows[0].selected = true
  assert.equal(batchCitationTransaction(stateFor(doc), rows, available).inserted, 0)
})

test('repeated batches cannot pile up different references on the same sentence', () => {
  let state = stateFor(document(sentence))
  const rows = createBatchRows([noteFor(state.doc)], available)
  const first = batchCitationTransaction(state, rows, available)
  const mapped = mapBatchRows(rows, first.transaction)
  state = state.apply(first.transaction)
  const other = mapped.map((row) => ({ ...row, paperId: 'paper-b', note: { ...row.note, candidates: [{ paper_id: 'paper-b', verdict: 'supports' }] } }))
  assert.equal(batchCitationTransaction(state, other, available).inserted, 0)
  assert.equal(citations(state.doc).length, 1)
})

test('only one of two conflicting suggestions for the same complete sentence is inserted', () => {
  const doc = document(sentence)
  const one = noteFor(doc)
  const two = { ...one, id: 'other', key: 'other', candidates: [{ paper_id: 'paper-b', verdict: 'supports' }] }
  const result = batchCitationTransaction(stateFor(doc), createBatchRows([one, two], available), available)
  assert.equal(result.inserted, 1)
  assert.equal(result.skipped, 1)
})

test('citation-only changes do not cycle through different style suggestions', () => {
  const first = { id: 'rewrite-a', kind: 'rewrite', anchor: sentence, revised: '更简短的表达。' }
  const second = { ...first, id: 'rewrite-b', anchor: '其他句子。', revised: '另一个改写。' }
  const plain = sentence + '其他句子。'
  const round = stabilizeProse({}, plain, [first])
  const check = { id: 'cite', kind: 'cite_check', anchor: sentence, items: [{ paper_id: 'paper-a', verdict: 'partial' }] }
  const next = stabilizeProse(round.prose, plain, [check, second])
  assert.deepEqual(next.annotations, [check, first])
})

test('accepting a rewrite completes that paragraph style round without suppressing citation issues', () => {
  const revised = '作者确认过的精简段落。'
  const prose = rememberProse({}, revised, null)
  const rewrite = { id: 'again', kind: 'rewrite', anchor: revised, revised: '继续精简。' }
  const issue = { id: 'cite', kind: 'cite_check', anchor: revised, items: [{ paper_id: 'paper-a', verdict: 'partial' }] }
  assert.deepEqual(stabilizeProse(prose, revised, [issue, rewrite]).annotations, [issue])
  // A new explicit round (empty cache) can produce another suggestion.
  assert.deepEqual(stabilizeProse({}, revised, [rewrite]).annotations, [rewrite])
})

test('ignored advice identity survives paragraph and citation-only changes', () => {
  const original = { id: 'old-id', kind: 'rewrite', anchor: sentence, revised: '精简。' }
  assert.equal(reviewDismissKey(original), reviewDismissKey({ ...original, id: 'new-id', reason: 'different reason' }))
  assert.notEqual(reviewDismissKey(original), reviewDismissKey({ ...original, anchor: '正文已改动。' }))
})

test('an ignored citation issue resurfaces when its cited paper or verdict changes', () => {
  const issue = { id: 'cite', kind: 'cite_check', anchor: sentence, items: [{ paper_id: 'paper-a', verdict: 'partial', reason: 'first' }] }
  assert.equal(reviewDismissKey(issue), reviewDismissKey({ ...issue, items: [{ ...issue.items[0], reason: 'other words' }] }))
  assert.notEqual(reviewDismissKey(issue), reviewDismissKey({ ...issue, items: [{ paper_id: 'paper-b', verdict: 'partial' }] }))
  assert.notEqual(reviewDismissKey(issue), reviewDismissKey({ ...issue, items: [{ paper_id: 'paper-a', verdict: 'unrelated' }] }))
})

test('accepting a rewrite produces plain text with a predictable paragraph result', () => {
  const doc = document(sentence)
  const annotation = { ...noteFor(doc), kind: 'rewrite', revised: '<b>作者的新表述。</b>' }
  const result = rewriteTransaction(stateFor(doc), annotation)
  assert.equal(result.plainAfter, annotation.revised)
  assert.equal(result.transaction.doc.textContent, annotation.revised)
})

test('a rewrite cannot delete a citation hidden within its plain-text anchor', () => {
  let state = stateFor(document(sentence))
  const annotation = { ...noteFor(state.doc), kind: 'rewrite', revised: '作者的新表述。' }
  state = state.apply(state.tr.insert(annotation.insertAt, schema.nodes.citation.create({ ids: ['paper-a'] })))
  annotation.to++
  assert.equal(state.doc.textBetween(annotation.from, annotation.to, '', ''), annotation.anchor)
  assert.equal(rewriteTransaction(state, annotation), null)
  assert.equal(citations(state.doc).length, 1)
})

test('batch ignores use stable advice identities instead of changing paragraph hashes', () => {
  const doc = document(sentence, sentence)
  const first = { ...noteFor(doc, 0), key: 'first-paragraph-hash:id', dismissKey: 'advice:stable' }
  const second = { ...noteFor(doc, 1), key: 'second-paragraph-hash:id', dismissKey: 'advice:stable' }
  const result = batchDismissalKeys(createBatchRows([first, second], available))
  assert.deepEqual(result, { keys: ['advice:stable'], ignored: 2, skipped: 0 })
})
