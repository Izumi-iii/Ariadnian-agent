export interface Paper {
  id: string
  bibkey: string
  title: string
  authors: string[]
  year?: number | null
  venue?: string | null
  doi?: string | null
  arxiv_id?: string | null
  url?: string | null
  pdf_url?: string | null
  abstract?: string | null
  source?: string | null
  citation_count?: number | null
  has_fulltext?: boolean
  chunk_count?: number
}

export type PaperIn = Omit<Paper, 'id' | 'bibkey' | 'has_fulltext' | 'chunk_count'>

export interface DocMeta {
  id: string
  title: string
  cite_style: CiteStyle
  created_at: string
  updated_at: string
}

export interface DocFull extends DocMeta {
  content: any
}

export type CiteStyle = 'numeric' | 'author-year'

export type Verdict = 'supports' | 'partial' | 'unrelated' | 'unknown' | 'missing'

export interface CiteCandidate {
  paper: Paper
  snippet: string
  section?: string | null
  page?: number | null
  score: number
  verdict?: Verdict
  reason?: string
}

export interface OutlineSection {
  title: string
  goal: string
  bibkeys: string[]
}

export interface TierInfo {
  model: string
  api_base?: string | null
  timeout: number
  retries: number
  fallbacks: string[]
}

export interface Health {
  ok: boolean
  llm_ready: boolean
  fake: boolean
  model: string
  tiers: Record<'complete' | 'write' | 'judge' | 'agent', TierInfo>
  embedding?: string | null
}

export interface TierStats {
  calls: number
  errors: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  first_token_p50_ms: number | null
  prompt_tokens: number
  cached_tokens: number
  completion_tokens: number
  /** 按官网价格表计算的费用（元）；没有价格时为 null */
  cost_cny: number | null
  unpriced_calls: number
  /** LiteLLM 自带价格表估算（美元），仅作参考 */
  cost_usd: number
}

export interface ModelPrice {
  input: number
  cached: number
  output: number
  peak_multiplier: number
  source: string
  note: string
}

export interface UsageStats {
  days: number
  currency: 'CNY'
  prices_checked: string
  pricing_pages: Record<string, string>
  tiers: Record<'complete' | 'write' | 'judge' | 'agent', TierStats>
  total: TierStats
  daily: { date: string; tiers: Record<string, { calls: number; tokens: number; cost_cny: number }> }[]
  models: (TierStats & { model: string; price: ModelPrice | null })[]
}

export interface SettingValue {
  source: 'ui' | 'env' | 'default'
  set: boolean
  value?: string | null
  hint?: string | null
}

export interface SettingsView {
  values: Record<string, SettingValue>
  tiers: Health['tiers']
  llm_ready: boolean
  fake: boolean
  settings_file: string
}

export interface TestResult {
  ok: boolean
  fake?: boolean
  model?: string
  latency_ms: number
  reply?: string
  sample?: string | null
  error?: string
  hint?: string
  authenticated?: boolean
}
