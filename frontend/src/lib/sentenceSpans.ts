export interface SentenceSpan { start: number; end: number; text: string }

/** Match the backend's sentence boundaries without counting citation atoms. */
export function sentenceSpans(plain: string): SentenceSpan[] {
  const result: SentenceSpan[] = []
  const add = (from: number, to: number) => {
    while (from < to && /\s/.test(plain[from])) from++
    while (to > from && /\s/.test(plain[to - 1])) to--
    if (to > from) result.push({ start: from, end: to, text: plain.slice(from, to) })
  }
  let start = 0
  for (const match of plain.matchAll(/[。！？!?；]|[.](?=\s)/g)) {
    const end = match.index + 1
    add(start, end)
    start = end
  }
  add(start, plain.length)
  return result
}

export function containingSentence(plain: string, from: number, to: number): SentenceSpan | undefined {
  return sentenceSpans(plain).find((span) => span.start <= from && span.end >= to)
}

export function sentenceHasCitation(span: SentenceSpan, cites: { plainIdx: number }[]): boolean {
  // A citation directly after punctuation belongs to the preceding sentence.
  return cites.some((c) => c.plainIdx <= span.end && (c.plainIdx > span.start || (span.start === 0 && c.plainIdx === 0)))
}
