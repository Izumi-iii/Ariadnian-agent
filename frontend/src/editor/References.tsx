import { Box, Typography } from '@mui/material'
import { formatReference, lastName, useCiteState } from '../lib/citations'
import { brand } from '../theme'

/** 根据文档中引用的出现顺序自动生成参考文献列表 */
export function References() {
  const st = useCiteState()
  const items = st.order.map((id) => st.papers[id]).filter(Boolean)
  if (!items.length) return null
  const sorted =
    st.style === 'author-year'
      ? [...items].sort((a, b) =>
          (a.authors?.[0] ? lastName(a.authors[0]) : a.title).localeCompare(b.authors?.[0] ? lastName(b.authors[0]) : b.title, 'zh-CN') ||
          (a.year ?? 0) - (b.year ?? 0),
        )
      : items
  return (
    <Box className="references" sx={{ mt: 6, pt: 2.5, borderTop: `1px solid ${brand.line}` }}>
      <Typography variant="h6" sx={{ fontFamily: 'var(--paper-font)', fontWeight: 700, mb: 1.5, fontSize: 18, color: brand.ink }}>
        参考文献
        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1, fontFamily: 'Roboto' }}>
          根据正文引用自动生成
        </Typography>
      </Typography>
      {sorted.map((p, i) => (
        <Box key={p.id} sx={{ display: 'flex', gap: 1, mb: 0.75, fontFamily: 'var(--paper-font)', fontSize: 13.5, lineHeight: 1.7, color: '#444' }}>
          {st.style === 'numeric' && <Box sx={{ minWidth: 30, color: brand.blue }}>[{i + 1}]</Box>}
          <Box sx={{ pl: st.style === 'author-year' ? 3 : 0, textIndent: st.style === 'author-year' ? '-1.5em' : 0 }}>
            {formatReference(p, st.style)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
