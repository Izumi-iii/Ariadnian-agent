import { useSyncExternalStore } from 'react'
import type { CiteStyle, Paper } from './types'

/**
 * 引用的全局状态：文献库 + 当前文档里各文献的出现顺序 + 引用格式。
 * Citation 节点（NodeView）和参考文献列表都从这里读，保证编号一致。
 */
interface CiteState {
  papers: Record<string, Paper>
  order: string[] // 文档中第一次出现的顺序 → 编号
  style: CiteStyle
}

let state: CiteState = { papers: {}, order: [], style: 'numeric' }
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

export const citeStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  setPapers(papers: Paper[]) {
    state = { ...state, papers: Object.fromEntries(papers.map((p) => [p.id, p])) }
    emit()
  },
  setOrder(order: string[]) {
    if (order.length === state.order.length && order.every((x, i) => x === state.order[i])) return
    state = { ...state, order }
    emit()
  },
  setStyle(style: CiteStyle) {
    state = { ...state, style }
    emit()
  },
}

export function useCiteState(): CiteState {
  return useSyncExternalStore(citeStore.subscribe, citeStore.get)
}

/** 遍历 ProseMirror 文档（或 JSON），得到引用出现顺序 */
export function collectCitationOrder(doc: { descendants: (f: (n: any) => void) => void }): string[] {
  const seen: string[] = []
  doc.descendants((node: any) => {
    if (node.type.name === 'citation') {
      for (const id of (node.attrs.ids as string[]) ?? []) if (!seen.includes(id)) seen.push(id)
    }
  })
  return seen
}

const CJK = /[一-鿿]/

export function lastName(name: string): string {
  if (CJK.test(name)) return name.trim()
  if (name.includes(',')) return name.split(',')[0].trim()
  const parts = name.trim().split(/\s+/)
  return parts[parts.length - 1] ?? name
}

function compressNumbers(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(j - i >= 2 ? `${s[i]}–${s[j]}` : j === i ? `${s[i]}` : `${s[i]}, ${s[j]}`)
    i = j
  }
  return out.join(', ')
}

export function authorYearLabel(p: Paper | undefined): string {
  if (!p) return '?'
  const a = p.authors ?? []
  const year = p.year ?? 'n.d.'
  if (!a.length) return `${p.title.slice(0, 12)}…, ${year}`
  const zh = CJK.test(a[0])
  if (a.length === 1) return `${lastName(a[0])}, ${year}`
  if (a.length === 2 && !zh) return `${lastName(a[0])} & ${lastName(a[1])}, ${year}`
  return zh ? `${lastName(a[0])}等, ${year}` : `${lastName(a[0])} et al., ${year}`
}

export function formatInline(ids: string[], st: CiteState): string {
  if (st.style === 'numeric') {
    const nums = ids.map((id) => st.order.indexOf(id) + 1).filter((n) => n > 0)
    return nums.length ? `[${compressNumbers(nums)}]` : '[?]'
  }
  return `(${ids.map((id) => authorYearLabel(st.papers[id])).join('; ')})`
}

/** 参考文献条目。numeric 采用简化的 GB/T 7714，author-year 采用 APA 风格 */
export function formatReference(p: Paper, style: CiteStyle): string {
  const a = p.authors ?? []
  const venue = p.venue || (p.arxiv_id ? `arXiv:${p.arxiv_id}` : '')
  if (style === 'numeric') {
    const names = a.slice(0, 3).map((n) => {
      if (CJK.test(n)) return n
      const parts = n.includes(',') ? [n.split(',')[1]?.trim() ?? '', n.split(',')[0]] : [n.split(/\s+/).slice(0, -1).join(' '), lastName(n)]
      const initials = parts[0]
        .split(/[\s-]+/)
        .filter(Boolean)
        .map((x) => x[0]?.toUpperCase())
        .join(' ')
      return `${parts[1]} ${initials}`.trim()
    })
    const etal = a.length > 3 ? (CJK.test(a[0]) ? ', 等' : ', et al') : ''
    const type = p.arxiv_id && !p.venue ? '[EB/OL]' : /journal|transactions|letters|review/i.test(p.venue ?? '') ? '[J]' : '[C]'
    const where = p.arxiv_id && !p.venue ? `arXiv preprint arXiv:${p.arxiv_id}` : `//${venue}`
    return `${names.join(', ')}${etal}. ${p.title}${type}${type === '[C]' ? where : `. ${where}`}. ${p.year ?? ''}.`
      .replace(/\.\./g, '.')
      .replace(/\s+\./g, '.')
  }
  const names =
    a.length > 7
      ? [...a.slice(0, 6), '…', a[a.length - 1]]
      : a
  const list = names
    .map((n) => (n === '…' ? n : CJK.test(n) ? n : `${lastName(n)}, ${n.split(/\s+/).slice(0, -1).map((x) => x[0] + '.').join(' ')}`))
    .join(', ')
  return `${list} (${p.year ?? 'n.d.'}). ${p.title}. ${venue ? `${venue}.` : ''}${p.doi ? ` https://doi.org/${p.doi}` : ''}`
}
