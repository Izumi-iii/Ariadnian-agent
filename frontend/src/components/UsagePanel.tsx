import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Link, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { api } from '../lib/api'
import type { UsageStats } from '../lib/types'
import { brand } from '../theme'

type TierKey = 'complete' | 'write' | 'judge' | 'agent'
interface TierDef {
  key: TierKey
  label: string
}

/** 四档模型的固定配色（按顺序分配，已用色盲模拟校验相邻可分） */
const TIER_COLOR: Record<TierKey, string> = { complete: '#2a78d6', write: '#eb6834', judge: '#1baf7a', agent: '#eda100' }
const AXIS = '#898781'
const GRID = 'rgba(0,0,0,0.07)'

const yuan = (v: number | null | undefined, digits = 2) => (v == null ? '—' : v > 0 && v < 0.01 ? '<¥0.01' : `¥${v.toFixed(digits)}`)
const ms = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`)
const num = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : v.toLocaleString())

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** 「好看」的坐标轴上限与刻度 */
function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

function ChartCard({ title, desc, right, children }: { title: string; desc?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ border: `1px solid ${brand.line}`, borderRadius: '10px', p: 2, mb: 2, bgcolor: '#fff' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', mb: 1.5, gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{title}</Typography>
          {desc && <Typography sx={{ fontSize: 11.5, color: brand.muted, mt: 0.25 }}>{desc}</Typography>}
        </Box>
        {right}
      </Box>
      {children}
    </Box>
  )
}

function Legend({ tiers }: { tiers: TierDef[] }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
      {tiers.map((t) => (
        <Box key={t.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.6, fontSize: 12, color: brand.muted }}>
          <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: TIER_COLOR[t.key] }} />
          {t.label}
        </Box>
      ))}
    </Box>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <Box sx={{ display: 'flex', bgcolor: brand.pill, borderRadius: '6px', p: '2px', flexShrink: 0 }}>
      {options.map(([k, l]) => (
        <Box
          key={k}
          role="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          sx={{
            px: 1.1, py: 0.3, fontSize: 12, borderRadius: '5px', cursor: 'pointer', userSelect: 'none',
            bgcolor: value === k ? '#fff' : 'transparent', color: value === k ? brand.ink : brand.muted,
            boxShadow: value === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none', fontWeight: value === k ? 500 : 400,
          }}
        >
          {l}
        </Box>
      ))}
    </Box>
  )
}

/** 悬停提示：跟随鼠标，限制在图表容器内 */
function HoverTip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 14), width - 200)
  return (
    <Box
      sx={{
        position: 'absolute', left, top: Math.max(0, y - 10), width: 190, pointerEvents: 'none', zIndex: 5,
        bgcolor: '#fff', border: `1px solid ${brand.line}`, borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        px: 1.25, py: 1, fontSize: 12,
      }}
    >
      {children}
    </Box>
  )
}

// ------------------------------------------------------------------ 每日趋势（堆叠柱）
type Metric = 'cost_cny' | 'tokens' | 'calls'
function DailyChart({ data, tiers, metric }: { data: UsageStats['daily']; tiers: TierDef[]; metric: Metric }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const H = 190
  const pad = { l: 46, r: 8, t: 8, b: 22 }
  const plotW = width - pad.l - pad.r
  const plotH = H - pad.t - pad.b
  const totals = data.map((d) => tiers.reduce((s, t) => s + (d.tiers[t.key]?.[metric] ?? 0), 0))
  const max = niceMax(Math.max(...totals, 0))
  const slot = plotW / data.length
  const barW = Math.max(3, Math.min(22, slot * 0.62))
  const fmt = (v: number) => (metric === 'cost_cny' ? (max < 1 ? `¥${v.toFixed(2)}` : `¥${v.toFixed(v < 10 ? 1 : 0)}`) : num(v))
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 58)))

  return (
    <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label="每日用量">
        {[0, 0.5, 1].map((f) => {
          const y = pad.t + plotH * (1 - f)
          return (
            <g key={f}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke={GRID} />
              <text x={pad.l - 6} y={y + 3.5} textAnchor="end" fontSize={10.5} fill={AXIS}>{fmt(max * f)}</text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const cx = pad.l + slot * (i + 0.5)
          let yTop = pad.t + plotH
          const segs = tiers.map((t) => {
            const v = d.tiers[t.key]?.[metric] ?? 0
            const h = (v / max) * plotH
            const seg = { t, y: yTop - h, h }
            yTop -= h
            return seg
          }).filter((s) => s.h > 0)
          return (
            <g key={d.date} opacity={hover && hover.i !== i ? 0.45 : 1}>
              {segs.map((s, j) => (
                // 段与段之间留 2px 白缝；最上面一段顶部圆角
                <rect
                  key={s.t.key}
                  x={cx - barW / 2}
                  y={s.y + (j < segs.length - 1 ? 0 : 0)}
                  width={barW}
                  height={Math.max(1, s.h - (j > 0 ? 2 : 0))}
                  rx={j === segs.length - 1 ? Math.min(3, barW / 3) : 0}
                  fill={TIER_COLOR[s.t.key]}
                />
              ))}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={10.5} fill={AXIS}>{d.date.slice(5)}</text>
              )}
              {/* 命中区域比柱子大，鼠标容易对准 */}
              <rect
                x={cx - slot / 2}
                y={pad.t}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseMove={(e) => {
                  const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                  setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top })
                }}
              />
            </g>
          )
        })}
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + plotH} y2={pad.t + plotH} stroke={AXIS} strokeOpacity={0.5} />
      </svg>
      {hover && (
        <HoverTip x={hover.x} y={hover.y} width={width}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>{data[hover.i].date}</Typography>
          {tiers.map((t) => {
            const v = data[hover.i].tiers[t.key]
            return (
              <Box key={t.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, lineHeight: 1.7 }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: TIER_COLOR[t.key] }} />
                <Box sx={{ flex: 1, color: brand.muted }}>{t.label}</Box>
                <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>{metric === 'cost_cny' ? yuan(v?.cost_cny, 3) : num(v?.[metric] ?? 0)}</Box>
              </Box>
            )
          })}
          <Box sx={{ display: 'flex', borderTop: `1px solid ${brand.lineSoft}`, mt: 0.5, pt: 0.5, fontWeight: 600 }}>
            <Box sx={{ flex: 1 }}>合计</Box>
            {metric === 'cost_cny' ? yuan(totals[hover.i], 3) : num(totals[hover.i])}
          </Box>
        </HoverTip>
      )}
    </Box>
  )
}

// ------------------------------------------------------------------ 延迟：P50 → P95 区间
function LatencyChart({ stats, tiers }: { stats: UsageStats; tiers: TierDef[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ k: TierKey; x: number; y: number } | null>(null)
  const rows = tiers.filter((t) => stats.tiers[t.key]?.latency_p50_ms != null)
  const pad = { l: 86, r: 92, t: 4, b: 22 }
  const rowH = 30
  const H = pad.t + rows.length * rowH + pad.b
  // 续写不到 1 秒、综述几十秒，差两个数量级，用对数刻度才都看得清
  const vals = rows.flatMap((t) => [stats.tiers[t.key].latency_p50_ms ?? 0, stats.tiers[t.key].latency_p95_ms ?? 0]).filter((v) => v > 0)
  const TICKS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000]
  const lo = [...TICKS].reverse().find((t) => t <= Math.min(...vals, 1000)) ?? 100
  const hi = TICKS.find((t) => t >= Math.max(...vals, 1000)) ?? 200000
  const ticks = TICKS.filter((t) => t >= lo && t <= hi)
  const x = (msv: number) => pad.l + (Math.log(Math.max(msv, lo) / lo) / Math.log(hi / lo)) * (width - pad.l - pad.r)
  const tickLabel = (t: number) => (t >= 1000 ? `${t / 1000}s` : `${t}ms`)
  if (!rows.length) return <Typography sx={{ fontSize: 12.5, color: brand.faint }}>还没有调用记录</Typography>
  return (
    <Box ref={ref} sx={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label="各档延迟">
        {ticks.map((t, i) => {
          // 刻度太密时隔一个标一个，避免文字挤在一起
          const step = Math.ceil(ticks.length / Math.max(2, Math.floor((width - pad.l - pad.r) / 44)))
          return (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={pad.t} y2={H - pad.b} stroke={GRID} />
              {i % step === 0 && <text x={x(t)} y={H - 6} textAnchor="middle" fontSize={10.5} fill={AXIS}>{tickLabel(t)}</text>}
            </g>
          )
        })}
        {rows.map((t, i) => {
          const s = stats.tiers[t.key]
          const y = pad.t + rowH * (i + 0.5)
          const x1 = x(s.latency_p50_ms ?? 0)
          const x2 = x(s.latency_p95_ms ?? s.latency_p50_ms ?? 0)
          return (
            <g
              key={t.key}
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                setHover({ k: t.key, x: e.clientX - r.left, y: e.clientY - r.top })
              }}
            >
              <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill="transparent" />
              <text x={pad.l - 10} y={y + 4} textAnchor="end" fontSize={12} fill={brand.ink}>{t.label}</text>
              <line x1={x1} x2={x2} y1={y} y2={y} stroke={TIER_COLOR[t.key]} strokeWidth={3} strokeLinecap="round" strokeOpacity={0.35} />
              <circle cx={x1} cy={y} r={5} fill={TIER_COLOR[t.key]} stroke="#fff" strokeWidth={2} />
              <circle cx={x2} cy={y} r={5} fill="#fff" stroke={TIER_COLOR[t.key]} strokeWidth={2} />
              <text x={width - pad.r + 10} y={y + 4} fontSize={11.5} fill={brand.muted}>
                {ms(s.latency_p50_ms)} / {ms(s.latency_p95_ms)}
              </text>
            </g>
          )
        })}
      </svg>
      {hover && (
        <HoverTip x={hover.x} y={hover.y} width={width}>
          <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>{tiers.find((t) => t.key === hover.k)?.label}</Typography>
          {[
            ['P50（一般情况）', ms(stats.tiers[hover.k].latency_p50_ms)],
            ['P95（最慢 5%）', ms(stats.tiers[hover.k].latency_p95_ms)],
            ['首 token P50', ms(stats.tiers[hover.k].first_token_p50_ms)],
            ['调用次数', String(stats.tiers[hover.k].calls)],
          ].map(([k, v]) => (
            <Box key={k} sx={{ display: 'flex', lineHeight: 1.7 }}>
              <Box sx={{ flex: 1, color: brand.muted }}>{k}</Box>
              <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>{v}</Box>
            </Box>
          ))}
        </HoverTip>
      )}
    </Box>
  )
}

// ------------------------------------------------------------------ 各模型费用（横向条）
function ModelCostChart({ stats }: { stats: UsageStats }) {
  const rows = stats.models.filter((m) => m.calls > 0)
  const max = Math.max(...rows.map((m) => m.cost_cny ?? 0), 0)
  if (!rows.length) return <Typography sx={{ fontSize: 12.5, color: brand.faint }}>还没有调用记录</Typography>
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {rows.map((m) => {
        const share = m.cost_cny && max ? m.cost_cny / max : 0
        const cacheRate = m.prompt_tokens ? m.cached_tokens / m.prompt_tokens : 0
        return (
          <Tooltip
            key={m.model}
            placement="top-start"
            title={
              <Box sx={{ fontSize: 12, lineHeight: 1.7 }}>
                <div style={{ fontFamily: 'Roboto Mono' }}>{m.model}</div>
                <div>{m.calls} 次调用</div>
                <div>输入 {num(m.prompt_tokens)}（缓存命中 {(cacheRate * 100).toFixed(0)}%）· 输出 {num(m.completion_tokens)}</div>
                {m.price ? (
                  <div>
                    单价：输入 ¥{m.price.input} · 缓存 ¥{m.price.cached} · 输出 ¥{m.price.output} / 百万 tokens
                    {m.price.peak_multiplier !== 1 ? `（高峰 ×${m.price.peak_multiplier}）` : ''}
                  </div>
                ) : (
                  <div>没有价格，可在下方填写</div>
                )}
              </Box>
            }
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 42%) 1fr 70px', alignItems: 'center', gap: 1.25, cursor: 'default' }}>
              {/* 去掉 openai/ 这类接口前缀，只显示模型名；完整名称在悬停提示里 */}
              <Typography noWrap sx={{ fontSize: 12, fontFamily: 'Roboto Mono', color: brand.ink }}>{m.model.includes('/') ? m.model.split('/').slice(1).join('/') : m.model}</Typography>
              <Box sx={{ height: 14, bgcolor: brand.lineSoft, borderRadius: '3px', overflow: 'hidden' }}>
                {m.cost_cny != null ? (
                  <Box sx={{ width: `${Math.max(share * 100, m.cost_cny > 0 ? 1.5 : 0)}%`, height: '100%', bgcolor: '#2a78d6', borderRadius: '0 3px 3px 0' }} />
                ) : (
                  <Box sx={{ height: '100%', backgroundImage: `repeating-linear-gradient(45deg, ${brand.line} 0 4px, transparent 4px 8px)` }} />
                )}
              </Box>
              <Typography sx={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: m.cost_cny == null ? brand.faint : brand.ink }}>
                {m.cost_cny == null ? '无价格' : yuan(m.cost_cny, 3)}
              </Typography>
            </Box>
          </Tooltip>
        )
      })}
    </Box>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Box sx={{ border: `1px solid ${brand.line}`, borderRadius: '10px', px: 1.75, py: 1.25, minWidth: 0 }}>
      <Typography sx={{ fontSize: 11.5, color: brand.muted }}>{label}</Typography>
      <Typography sx={{ fontSize: 22, fontWeight: 600, color: brand.ink, lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      {sub && <Typography noWrap sx={{ fontSize: 11.5, color: brand.faint }}>{sub}</Typography>}
    </Box>
  )
}

// ------------------------------------------------------------------ 自定义价格
type PriceDraft = Record<string, { input: string; cached: string; output: string }>

function parsePrices(raw: string): PriceDraft {
  try {
    const d = JSON.parse(raw || '{}') as Record<string, { input?: number; cached?: number; output?: number }>
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { input: String(v.input ?? ''), cached: String(v.cached ?? ''), output: String(v.output ?? '') }]))
  } catch {
    return {}
  }
}

function PriceEditor({ stats, raw, onChange }: { stats: UsageStats; raw: string; onChange: (json: string) => void }) {
  const draft = useMemo(() => parsePrices(raw), [raw])
  const models = useMemo(() => {
    const names = new Set([...stats.models.map((m) => m.model), ...Object.keys(draft)])
    return [...names]
  }, [stats.models, draft])
  const update = (model: string, field: 'input' | 'cached' | 'output', value: string) => {
    const base = draft[model] ?? { input: '', cached: '', output: '' }
    const next = { ...draft, [model]: { ...base, [field]: value.replace(/[^\d.]/g, '') } }
    const out: Record<string, { input: number; cached?: number; output: number }> = {}
    for (const [k, v] of Object.entries(next)) {
      if (v.input === '' && v.output === '' && v.cached === '') continue
      out[k] = { input: Number(v.input || 0), output: Number(v.output || 0), ...(v.cached !== '' ? { cached: Number(v.cached) } : {}) }
    }
    onChange(Object.keys(out).length ? JSON.stringify(out) : '')
  }
  if (!models.length) return <Typography sx={{ fontSize: 12.5, color: brand.faint }}>调用过模型之后，这里会列出用到的模型和单价。</Typography>
  return (
    <Table size="small" sx={{ '& td, & th': { borderColor: brand.lineSoft, fontSize: 12.5, py: 0.75 } }}>
      <TableHead>
        <TableRow sx={{ '& th': { color: brand.muted, fontWeight: 500 } }}>
          <TableCell>模型</TableCell>
          <TableCell align="right">输入</TableCell>
          <TableCell align="right">缓存命中</TableCell>
          <TableCell align="right">输出</TableCell>
          <TableCell>来源</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {models.map((name) => {
          const m = stats.models.find((x) => x.model === name)
          const builtin = m?.price && m.price.source !== '自定义' ? m.price : null
          const d = draft[name]
          const cell = (field: 'input' | 'cached' | 'output') => (
            <TextField
              value={d?.[field] ?? ''}
              placeholder={builtin ? String(builtin[field]) : '—'}
              onChange={(e) => update(name, field, e.target.value)}
              slotProps={{ htmlInput: { style: { textAlign: 'right', padding: '4px 8px', fontSize: 12.5 }, 'aria-label': `${name} ${field}` } }}
              sx={{ width: 84 }}
            />
          )
          return (
            <TableRow key={name}>
              <TableCell sx={{ fontFamily: 'Roboto Mono', fontSize: '12px !important', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</TableCell>
              <TableCell align="right">{cell('input')}</TableCell>
              <TableCell align="right">{cell('cached')}</TableCell>
              <TableCell align="right">{cell('output')}</TableCell>
              <TableCell sx={{ fontSize: '12px !important', color: brand.muted }}>
                {d ? '自定义' : builtin ? (
                  <Link href={builtin.source} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: 12 }}>
                    官网价格{builtin.peak_multiplier !== 1 ? `（高峰 ×${builtin.peak_multiplier}）` : ''}
                  </Link>
                ) : m?.price?.source === '本地模型' ? '本地，不计费' : <Box component="span" sx={{ color: brand.amber }}>未知，请填写</Box>}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

// ------------------------------------------------------------------ 主面板
export function UsagePanel({ tiers, priceRaw, onPriceChange, reloadKey }: { tiers: TierDef[]; priceRaw: string; onPriceChange: (json: string) => void; reloadKey: unknown }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [metric, setMetric] = useState<Metric>('cost_cny')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.llmStats(Number(days)).then((s) => alive && setStats(s)).catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [days, reloadKey]) // 保存设置（如修改单价）后重新拉取

  if (error) return <Typography sx={{ fontSize: 13, color: brand.red }}>读取用量失败：{error}</Typography>
  if (!stats) return <Typography sx={{ fontSize: 13, color: brand.faint }}>加载中…</Typography>

  const t = stats.total
  const tokens = t.prompt_tokens + t.completion_tokens
  const cacheRate = t.prompt_tokens ? (t.cached_tokens / t.prompt_tokens) * 100 : 0
  const anyCost = stats.daily.some((d) => Object.values(d.tiers).some((x) => x.cost_cny > 0))

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ fontSize: 12, color: brand.muted, flex: 1 }}>
          费用按各家官网价格（元 / 百万 tokens）计算，价格核对于 {stats.prices_checked}，以官网为准。
        </Typography>
        <Segmented value={days} onChange={setDays} options={[['7', '7 天'], ['30', '30 天'], ['90', '90 天']]} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.25, mb: 2 }}>
        <Kpi label="费用" value={yuan(t.cost_cny)} sub={t.unpriced_calls ? `${t.unpriced_calls} 次调用无价格未计入` : '全部按官网价计算'} />
        <Kpi label="调用次数" value={t.calls.toLocaleString()} sub={t.errors ? `失败 ${t.errors} 次（${((t.errors / Math.max(1, t.calls)) * 100).toFixed(1)}%）` : '没有失败'} />
        <Kpi label="tokens" value={num(tokens)} sub={`输入 ${num(t.prompt_tokens)} · 输出 ${num(t.completion_tokens)}`} />
        <Kpi label="缓存命中" value={`${cacheRate.toFixed(0)}%`} sub="命中部分按缓存价计费" />
      </Box>

      <ChartCard
        title="每日用量"
        desc="按北京时间统计，鼠标移到柱子上看各档明细"
        right={<Segmented value={metric} onChange={setMetric} options={[['cost_cny', '费用'], ['tokens', 'tokens'], ['calls', '调用']]} />}
      >
        <Legend tiers={tiers} />
        {metric === 'cost_cny' && !anyCost ? (
          <Typography sx={{ fontSize: 12.5, color: brand.faint, py: 4, textAlign: 'center' }}>
            这段时间没有可计价的调用。用到的模型没有价格的话，可以在下面「模型单价」里填写。
          </Typography>
        ) : (
          <DailyChart data={stats.daily} tiers={tiers} metric={metric} />
        )}
      </ChartCard>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 2 }}>
        <ChartCard
          title="各档延迟"
          desc={
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              实心点 P50（一般情况），空心点 P95（最慢 5%）
              <Tooltip title="P50：一半请求比它快；P95：只有 5% 的请求比它慢。两点离得越远，速度越不稳定。">
                <InfoOutlinedIcon sx={{ fontSize: 13, color: brand.faint }} />
              </Tooltip>
            </Box>
          }
        >
          <LatencyChart stats={stats} tiers={tiers} />
        </ChartCard>
        <ChartCard title="各模型费用" desc="鼠标移上去看单价和 token 构成；斜纹表示没有价格">
          <ModelCostChart stats={stats} />
        </ChartCard>
      </Box>

      <ChartCard title="各档明细" desc="与上面图表同一份数据的表格视图">
        <Table size="small" sx={{ '& td, & th': { borderColor: brand.lineSoft, fontSize: 12.5, py: 0.9 } }}>
          <TableHead>
            <TableRow sx={{ '& th': { color: brand.muted, fontWeight: 500 } }}>
              <TableCell>档位</TableCell>
              <TableCell align="right">调用</TableCell>
              <TableCell align="right">P50 / P95</TableCell>
              <TableCell align="right">首 token</TableCell>
              <TableCell align="right">输入 / 输出 tokens</TableCell>
              <TableCell align="right">费用</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tiers.map((tier) => {
              const s = stats.tiers[tier.key]
              return (
                <TableRow key={tier.key}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: TIER_COLOR[tier.key] }} />
                      {tier.label}
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    {s.calls}
                    {s.errors ? <Box component="span" sx={{ color: brand.red }}> · {s.errors} 失败</Box> : null}
                  </TableCell>
                  <TableCell align="right">{ms(s.latency_p50_ms)} / {ms(s.latency_p95_ms)}</TableCell>
                  <TableCell align="right">{ms(s.first_token_p50_ms)}</TableCell>
                  <TableCell align="right">{num(s.prompt_tokens)} / {num(s.completion_tokens)}</TableCell>
                  <TableCell align="right">{yuan(s.cost_cny, 3)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </ChartCard>

      <ChartCard
        title="模型单价"
        desc={
          <>
            元 / 百万 tokens。DeepSeek、Kimi 已内置官网价格（DeepSeek 工作日 9–12、14–18 点为高峰，价格翻倍）；其他模型请对照官网填写，保存后费用会重新计算。
            {Object.entries(stats.pricing_pages).map(([name, url]) => (
              <Link key={name} href={url} target="_blank" rel="noreferrer" underline="hover" sx={{ ml: 1, fontSize: 11.5 }}>
                {name}
              </Link>
            ))}
          </>
        }
      >
        <PriceEditor stats={stats} raw={priceRaw} onChange={onPriceChange} />
      </ChartCard>
    </Box>
  )
}
