import { diffChars, diffWordsWithSpace } from 'diff'
import { Box } from '@mui/material'
import { brand } from '../theme'
import { CITE_RE, citeStore, formatInline, parseCiteBody, type CitePages } from '../lib/citations'

/** 把 [@key; @key2] 显示成当前引用格式的标签，如 [1, 2] */
function prettyCites(text: string): string {
  const st = citeStore.get()
  const byKey = new Map(Object.values(st.papers).map((p) => [p.bibkey, p.id]))
  return text.replace(CITE_RE, (m, body: string) => {
    const ids: string[] = []
    const pages: CitePages = {}
    for (const { key, page } of parseCiteBody(body)) {
      const id = byKey.get(key)
      if (!id) continue
      ids.push(id)
      if (page) pages[id] = page
    }
    return ids.length ? formatInline(ids, st, pages) : m
  })
}

/** 修订模式式的差异显示：删除标红划线、新增标绿 */
export function DiffView({ before: rawBefore, after: rawAfter }: { before: string; after: string }) {
  const before = prettyCites(rawBefore)
  const after = prettyCites(rawAfter)
  const zh = /[一-鿿]/.test(before + after)
  const parts = zh ? diffChars(before, after) : diffWordsWithSpace(before, after)
  return (
    <Box sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 14, fontFamily: 'var(--paper-font)' }}>
      {parts.map((p, i) =>
        p.added ? (
          <Box key={i} component="ins" sx={{ bgcolor: 'rgba(46,125,91,0.14)', color: brand.green, textDecoration: 'none', borderRadius: '2px' }}>
            {p.value}
          </Box>
        ) : p.removed ? (
          <Box key={i} component="del" sx={{ bgcolor: 'rgba(192,57,43,0.10)', color: brand.red, borderRadius: '2px' }}>
            {p.value}
          </Box>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </Box>
  )
}
