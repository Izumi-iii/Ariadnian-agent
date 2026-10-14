import { alpha, createTheme } from '@mui/material/styles'

/**
 * 与 Alidade 同一套设计语言（Fluent 配色）：
 * 白底、细边框、蓝色「数据/内容」卡片、桃色「用户输入」卡片、紫色表示编排节点、绿色表示完成。
 * 品牌标识（Logo）保留海军蓝 + 橙色。
 */
export const brand = {
  blue: '#0078d4',
  purple: '#8764b8',
  orange: '#c85a17',
  red: '#a4262c',
  green: '#2e7d32',
  amber: '#b7791f',
  ink: '#242424',
  muted: '#616161',
  faint: '#9e9e9e',
  line: 'rgba(0,0,0,0.10)',
  lineSoft: 'rgba(0,0,0,0.06)',
  bg: '#ffffff',
  subtle: '#fafafa',
  pill: '#ebebeb',
  logoNavy: '#1F3A5F',
  logoOrange: '#E8743B',
  // 兼容旧代码里的命名
  navy: '#0078d4',
  paper: '#ffffff',
  cream: '#ffffff',
}

export const card = {
  data: { bgcolor: alpha(brand.blue, 0.07), border: `1px solid ${alpha(brand.blue, 0.28)}` },
  user: { bgcolor: alpha(brand.orange, 0.08), border: `1px solid ${alpha(brand.orange, 0.26)}` },
  plain: { bgcolor: '#fff', border: `1px solid ${brand.line}` },
  agent: { bgcolor: alpha(brand.purple, 0.07), border: `1px solid ${alpha(brand.purple, 0.35)}` },
  dashed: { bgcolor: 'transparent', border: `1px dashed ${alpha('#000', 0.22)}` },
}

export const shadow = {
  sm: '0 1px 2px rgba(0,0,0,0.05)',
  md: '0 2px 4px rgba(0,0,0,0.08)',
  lg: '0 2px 8px rgba(0,0,0,0.12)',
  pill: '0 1px 4px rgba(0,0,0,0.12)',
}

export const theme = createTheme({
  palette: {
    primary: { main: brand.blue },
    secondary: { main: brand.purple },
    success: { main: brand.green },
    warning: { main: brand.amber },
    error: { main: brand.red },
    background: { default: '#fff', paper: '#fff' },
    text: { primary: brand.ink, secondary: brand.muted },
    divider: brand.line,
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: ['Roboto', 'Arial', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'].join(','),
    fontSize: 13,
    button: { textTransform: 'none', fontWeight: 500 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true, size: 'small' },
      styleOverrides: { root: { borderRadius: 6, lineHeight: 1.4, minWidth: 0, whiteSpace: 'nowrap' } },
    },
    MuiIconButton: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiTooltip: { defaultProps: { arrow: false, enterDelay: 400, describeChild: true } },
    MuiChip: { styleOverrides: { root: { borderRadius: 4, fontWeight: 500 } } },
    MuiPaper: { styleOverrides: { outlined: { borderColor: brand.line } } },
    MuiMenu: { styleOverrides: { paper: { border: `1px solid ${brand.line}`, boxShadow: shadow.lg } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 12 } } },
  },
})
