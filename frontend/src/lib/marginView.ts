/**
 * 页边批注的呈现规则：按类型筛选、同一句话的批注合并成一组、按重要程度排序。
 */
import type { PlacedAnnotation } from './review'

export type MarginKind = 'critic' | 'cite' | 'missing' | 'style'
export const MARGIN_KINDS: { key: MarginKind; label: string; color: string }[] = [
  { key: 'critic', label: '审稿', color: '#a4262c' },
  { key: 'cite', label: '引用问题', color: '#b7791f' },
  { key: 'missing', label: '缺引用', color: '#8764b8' },
  { key: 'style', label: '精简', color: '#0078d4' },
]
export type MarginFilter = Record<MarginKind, boolean>
// 「可以更简洁」是风格建议，默认不打扰
export const DEFAULT_FILTER: MarginFilter = { critic: true, cite: true, missing: true, style: false }

export function kindOf(a: PlacedAnnotation): MarginKind {
  if (a.kind === 'reviewer') return 'critic'
  if (a.kind === 'cite_check') return 'cite'
  if (a.kind === 'missing_citation') return 'missing'
  return 'style'
}

const badCite = (a: PlacedAnnotation) => a.kind === 'cite_check' && a.items.some((i) => i.verdict === 'unrelated' || i.verdict === 'missing')

/** 越小越重要：主要审稿意见 > 引用撑不起 > 缺引用 > 次要审稿意见 > 引用待确认 > 精简 */
export function priority(a: PlacedAnnotation, handled = false): number {
  const base =
    a.kind === 'reviewer' ? (a.issue.severity === 'major' ? 0 : 3)
    : badCite(a) ? 1
    : a.kind === 'missing_citation' ? 2
    : a.kind === 'cite_check' ? 4
    : 5
  return base + (handled ? 10 : 0)
}

/** 收起时显示的一行标题与颜色 */
export function summaryOf(a: PlacedAnnotation, categoryLabel: (c: string) => string): { label: string; color: string } {
  if (a.kind === 'reviewer') return { label: `审稿 · ${categoryLabel(a.issue.category)}`, color: a.issue.severity === 'major' ? '#a4262c' : '#b7791f' }
  if (a.kind === 'cite_check') return badCite(a) ? { label: '引用撑不起这句话', color: '#a4262c' } : { label: '引用只部分支持', color: '#b7791f' }
  if (a.kind === 'missing_citation') return { label: '缺少引用', color: '#8764b8' }
  return { label: '可以更简洁', color: '#0078d4' }
}

export interface NoteGroup {
  /** 组内第一条批注的 key，作为组的标识 */
  key: string
  from: number
  to: number
  notes: PlacedAnnotation[]
}

/** 位置重叠（同一句话）的批注合并成一组，组内按重要程度排序 */
export function groupNotes(notes: PlacedAnnotation[], handled: (a: PlacedAnnotation) => boolean = () => false): NoteGroup[] {
  const sorted = [...notes].sort((a, b) => a.from - b.from || a.to - b.to)
  const groups: NoteGroup[] = []
  for (const n of sorted) {
    const g = groups[groups.length - 1]
    if (g && n.from < g.to) {
      g.notes.push(n)
      g.to = Math.max(g.to, n.to)
    } else groups.push({ key: n.key, from: n.from, to: n.to, notes: [n] })
  }
  for (const g of groups) {
    g.notes.sort((a, b) => priority(a, handled(a)) - priority(b, handled(b)))
    g.key = g.notes[0].key
  }
  return groups
}

export function loadFilter(): MarginFilter {
  try {
    return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem('aria.marginFilter') || '{}') }
  } catch {
    return DEFAULT_FILTER
  }
}
export function saveFilter(f: MarginFilter) {
  try {
    localStorage.setItem('aria.marginFilter', JSON.stringify(f))
  } catch {
    /* ignore */
  }
}
