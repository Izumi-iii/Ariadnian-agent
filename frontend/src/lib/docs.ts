import { useEffect, useState } from 'react'
import { api } from './api'
import { useApp } from './appContext'
import type { DocMeta } from './types'

export const STARTER_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '引言' }] },
    { type: 'paragraph' },
  ],
}

export async function createDoc(title = '未命名论文') {
  return api.createDoc(title, STARTER_DOC)
}

/** 文档列表（随保存/重命名自动刷新） */
export function useDocList(): DocMeta[] {
  const { docsVersion } = useApp()
  const [docs, setDocs] = useState<DocMeta[]>([])
  useEffect(() => {
    api.docs().then(setDocs).catch(() => undefined)
  }, [docsVersion])
  return docs
}

/** 启动时选中上次打开的文档；一篇都没有就新建 */
export function useBootstrapDoc() {
  const { docId, setDocId, notify, bumpDocs } = useApp()
  useEffect(() => {
    if (docId) return
    ;(async () => {
      const list = await api.docs()
      let saved: string | null = null
      try {
        saved = localStorage.getItem('aria.lastDoc')
      } catch {
        /* ignore */
      }
      const pick = list.find((d) => d.id === saved) ?? list[0]
      if (pick) setDocId(pick.id)
      else {
        const d = await createDoc()
        bumpDocs()
        setDocId(d.id)
      }
    })().catch((e) => notify(`无法连接后端：${e.message}`, 'error'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!docId) return
    try {
      localStorage.setItem('aria.lastDoc', docId)
    } catch {
      /* ignore */
    }
  }, [docId])
}

export function relTime(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + 'Z')
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString()
}
