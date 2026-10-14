import type { ReactNode } from 'react'
import { Box, InputBase, IconButton, Tooltip, Typography, type SxProps } from '@mui/material'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import { brand, card, shadow } from '../theme'

/** Alidade 式的时间线：左侧一条细竖线，每个节点一个小图标，右侧是卡片 */
export function Thread({ children, sx }: { children: ReactNode; sx?: SxProps }) {
  return (
    <Box
      sx={{
        position: 'relative',
        '&::before': {
          content: '""', position: 'absolute', left: 11, top: 6, bottom: 6, width: '1px', bgcolor: 'rgba(0,0,0,0.09)',
        },
        ...sx,
      }}
    >
      {children}
    </Box>
  )
}

export function ThreadItem({ icon, children, dense }: { icon?: ReactNode; children: ReactNode; dense?: boolean }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, mb: dense ? 0.75 : 1.25, position: 'relative' }}>
      <Box
        sx={{
          width: 23, flexShrink: 0, display: 'flex', justifyContent: 'center', pt: '7px',
          color: brand.faint, '& svg': { fontSize: 15, bgcolor: '#fff', borderRadius: '50%' },
        }}
      >
        {icon ?? <Box sx={{ width: 7, height: 7, mt: '4px', borderRadius: '50%', bgcolor: '#d0d0d0', border: '2px solid #fff' }} />}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  )
}

export function Card({
  variant = 'plain', children, sx, onClick, selected,
}: {
  variant?: keyof typeof card
  children: ReactNode
  sx?: SxProps
  onClick?: () => void
  selected?: boolean
}) {
  return (
    <Box
      onClick={onClick}
      sx={{
        ...card[variant],
        borderRadius: '6px',
        px: 1.25,
        py: 0.9,
        fontSize: 13,
        lineHeight: 1.55,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all .15s ease',
        ...(selected ? card.data : {}),
        ...(onClick ? { '&:hover': { borderColor: 'rgba(0,120,212,0.55)', boxShadow: shadow.sm } } : {}),
        ...sx,
      }}
    >
      {children}
    </Box>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
      <Typography sx={{ fontSize: 12, color: brand.muted, flex: 1 }}>{children}</Typography>
      {right}
    </Box>
  )
}

/** 底部输入框（Alidade 的「有什么问题，有什么想要探索的？」） */
export function Composer({
  value, onChange, onSubmit, placeholder, disabled, left, busy,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  disabled?: boolean
  busy?: boolean
  left?: ReactNode
}) {
  return (
    <Box sx={{ p: 1.5, pt: 1 }}>
      <Box
        sx={{
          border: `1px solid ${brand.line}`, borderRadius: '12px', boxShadow: shadow.md, bgcolor: '#fff', px: 1.5, pt: 1.25, pb: 0.75,
          '&:focus-within': { borderColor: 'rgba(0,120,212,0.5)' },
        }}
      >
        <InputBase
          fullWidth
          multiline
          minRows={2}
          maxRows={8}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!disabled && value.trim()) onSubmit()
            }
          }}
          sx={{ fontSize: 13.5, '& textarea::placeholder': { color: brand.faint, opacity: 1 } }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, minHeight: 30 }}>
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>{left}</Box>
          <Tooltip title="发送（Enter）">
            <span>
              <IconButton
                onClick={onSubmit}
                disabled={disabled || busy || !value.trim()}
                sx={{ color: value.trim() ? brand.blue : brand.faint }}
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  )
}

/** 顶栏上的灰底药丸切换（Alidade 的「关于 / 应用」「EN / 中文」） */
export function PillToggle<T extends string>({
  value, options, onChange, size = 'md',
}: {
  value: T
  options: [T, ReactNode][]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <Box sx={{ display: 'inline-flex', border: `1px solid ${brand.line}`, borderRadius: '6px', overflow: 'hidden', bgcolor: '#fff' }}>
      {options.map(([v, label]) => (
        <Box
          key={v}
          role="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          sx={{
            px: size === 'sm' ? 1 : 1.25, py: size === 'sm' ? 0.25 : 0.5, fontSize: size === 'sm' ? 12 : 13, cursor: 'pointer',
            color: v === value ? brand.ink : brand.muted, bgcolor: v === value ? brand.pill : 'transparent',
            fontWeight: v === value ? 500 : 400, userSelect: 'none', whiteSpace: 'nowrap',
            '&:not(:last-of-type)': { borderRight: `1px solid ${brand.line}` },
            '&:hover': { color: brand.ink },
          }}
        >
          {label}
        </Box>
      ))}
    </Box>
  )
}
