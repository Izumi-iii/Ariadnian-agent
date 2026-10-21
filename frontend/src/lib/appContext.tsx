import type { Editor } from '@tiptap/core'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Alert, Snackbar } from '@mui/material'
import { api } from './api'
import { citeStore } from './citations'
import { notesStore } from './notes'
import type { Health, Paper, PaperIn } from './types'

/** 右侧抽屉里的视图 */
export type RightTab = 'agent' | 'cite' | 'ask' | 'library' | 'reader' | 'docs'

export interface CiteRequest {
  sentence: string
  insertAt: number
  nonce: number
}

/** 一处引用依据：页码 + 原文片段，在「原文」里高亮 */
export interface Evidence {
  page?: number | null
  snippet?: string
  section?: string | null
  verdict?: string
  reason?: string
}

/** 在抽屉「原文」里打开一篇文献库论文 */
export interface ReaderTarget {
  paperId: string
  /** 正文里的那句话：用来从依据片段里挑出最相关的句子高亮 */
  claim?: string
  evidences?: Evidence[]
  /** 插入引用的位置（来自页边批注）；没有就插到光标处 */
  insertAt?: number | null
  nonce: number
}

export interface PreviewAction {
  label: string
  primary?: boolean
  onClick: () => void | Promise<void>
}

/** 检索预览弹窗：可以是文献库论文（有 id），也可以是还没入库的检索结果 */
export interface PreviewTarget {
  paper: PaperIn & { id?: string; has_pdf?: boolean }
  claim?: string
  verdict?: string
  reason?: string
  actions?: PreviewAction[]
}

interface AppCtx {
  editor: Editor | null
  setEditor: (e: Editor | null) => void
  papers: Paper[]
  refreshPapers: () => Promise<Paper[]>
  docId: string | null
  setDocId: (id: string | null) => void
  docTitle: string
  setDocTitle: (t: string) => void
  rightTab: RightTab
  setRightTab: (t: RightTab) => void
  citeRequest: CiteRequest | null
  requestCitations: (sentence: string, insertAt: number) => void
  notify: (msg: string, severity?: 'success' | 'info' | 'warning' | 'error') => void
  health: Health | null
  drawerOpen: boolean
  setDrawerOpen: (v: boolean) => void
  /** 打开抽屉并切到某个视图；已经打开在同一视图时再点一次就收起 */
  toggleDrawer: (tab: RightTab) => void
  copilot: boolean
  setCopilot: (v: boolean) => void
  review: boolean
  setReview: (v: boolean) => void
  docsVersion: number
  bumpDocs: () => void
  /** 打开设置页，可指定页签 */
  settingsTab: SettingsTab | null
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  refreshHealth: () => Promise<void>
  reader: ReaderTarget | null
  openReader: (t: Omit<ReaderTarget, 'nonce'>) => void
  preview: PreviewTarget | null
  openPreview: (t: PreviewTarget) => void
  closePreview: () => void
}

export type SettingsTab = 'model' | 'search' | 'embedding' | 'usage'

const Ctx = createContext<AppCtx | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [papers, setPapers] = useState<Paper[]>([])
  const [docId, setDocId] = useState<string | null>(null)
  const [docTitle, setDocTitle] = useState('')
  const [rightTab, setRightTab] = useState<RightTab>('agent')
  const [citeRequest, setCiteRequest] = useState<CiteRequest | null>(null)
  const [toast, setToast] = useState<{ msg: string; severity: 'success' | 'info' | 'warning' | 'error' } | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [docsVersion, setDocsVersion] = useState(0)
  const bumpDocs = useCallback(() => setDocsVersion((v) => v + 1), [])
  const [copilot, setCopilotState] = useState(() => {
    try {
      return localStorage.getItem('aria.copilot') !== '0'
    } catch {
      return true
    }
  })
  const setCopilot = useCallback((v: boolean) => {
    setCopilotState(v)
    try {
      localStorage.setItem('aria.copilot', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])
  const [review, setReviewState] = useState(() => {
    try {
      return localStorage.getItem('aria.review') !== '0'
    } catch {
      return true
    }
  })
  const setReview = useCallback((v: boolean) => {
    setReviewState(v)
    try {
      localStorage.setItem('aria.review', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const openSettings = useCallback((tab: SettingsTab = 'model') => setSettingsTab(tab), [])
  const closeSettings = useCallback(() => setSettingsTab(null), [])
  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health())
    } catch {
      setHealth(null)
    }
  }, [])

  const [reader, setReader] = useState<ReaderTarget | null>(null)
  const openReader = useCallback((t: Omit<ReaderTarget, 'nonce'>) => {
    setReader({ ...t, nonce: Date.now() })
    setRightTab('reader')
    setDrawerOpen(true)
  }, [])
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const openPreview = useCallback((t: PreviewTarget) => setPreview(t), [])
  const closePreview = useCallback(() => setPreview(null), [])

  const notify = useCallback<AppCtx['notify']>((msg, severity = 'info') => setToast({ msg, severity }), [])

  const refreshPapers = useCallback(async () => {
    const list = await api.papers()
    setPapers(list)
    citeStore.setPapers(list)
    notesStore.refresh().catch(() => undefined) // 删除文献时笔记也会被删掉
    return list
  }, [])

  useEffect(() => {
    refreshPapers().catch((e) => notify(`无法连接后端：${e.message}`, 'error'))
    api
      .health()
      .then((h) => {
        setHealth(h)
        // 第一次打开、还没配置模型：直接带用户去设置页
        let seen = false
        try {
          seen = localStorage.getItem('aria.onboarded') === '1'
          localStorage.setItem('aria.onboarded', '1')
        } catch {
          /* ignore */
        }
        if (!h.llm_ready && !seen) setSettingsTab('model')
      })
      .catch(() => setHealth(null))
  }, [refreshPapers, notify])

  const toggleDrawer = useCallback(
    (tab: RightTab) => {
      // 综述 Agent / 找引用 / 文献问答 同属「AI 助手」，图标栏上是同一个按钮
      const group = (t: RightTab) => (t === 'agent' || t === 'cite' || t === 'ask' ? 'assistant' : t)
      if (drawerOpen && group(tab) === group(rightTab)) {
        setDrawerOpen(false)
        return
      }
      if (group(tab) !== group(rightTab)) setRightTab(tab)
      setDrawerOpen(true)
    },
    [drawerOpen, rightTab],
  )

  const requestCitations = useCallback((sentence: string, insertAt: number) => {
    setDrawerOpen(true)
    setRightTab('cite')
    setCiteRequest({ sentence, insertAt, nonce: Date.now() })
  }, [])

  const value = useMemo<AppCtx>(
    () => ({
      editor, setEditor, papers, refreshPapers, docId, setDocId, docTitle, setDocTitle,
      rightTab, setRightTab, citeRequest, requestCitations, notify, health,
      drawerOpen, setDrawerOpen, toggleDrawer, copilot, setCopilot, review, setReview, docsVersion, bumpDocs,
      settingsTab, openSettings, closeSettings, refreshHealth, reader, openReader, preview, openPreview, closePreview,
    }),
    [editor, papers, refreshPapers, docId, docTitle, rightTab, citeRequest, requestCitations, notify, health,
      drawerOpen, toggleDrawer, copilot, setCopilot, review, setReview, docsVersion, bumpDocs,
      settingsTab, openSettings, closeSettings, refreshHealth, reader, openReader, preview, openPreview, closePreview],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.severity} variant="filled" onClose={() => setToast(null)} sx={{ maxWidth: 560 }}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Ctx.Provider>
  )
}

export function useApp(): AppCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside AppProvider')
  return v
}
