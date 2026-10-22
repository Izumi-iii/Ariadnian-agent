import type { JSONContent } from '@tiptap/core'
import { citeStore, citeToken, collectCitationOrder, pageLabel } from './citations'

function keysOf(ids: string[]): string[] {
  const papers = citeStore.get().papers
  return ids.map((id) => papers[id]?.bibkey).filter(Boolean) as string[]
}

// ------------------------------------------------------------------ Markdown（pandoc 引用语法）
function mdInline(nodes: JSONContent[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'citation') return citeToken((n.attrs?.ids ?? []).filter((id: string) => citeStore.get().papers[id]), n.attrs?.pages)
      if (n.type === 'hardBreak') return '  \n'
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'code') t = `\`${t}\``
        else if (m.type === 'strike') t = `~~${t}~~`
      }
      return t
    })
    .join('')
}

function mdBlock(n: JSONContent, indent = ''): string {
  switch (n.type) {
    case 'heading':
      return `${'#'.repeat(n.attrs?.level ?? 1)} ${mdInline(n.content)}`
    case 'paragraph':
      return indent + mdInline(n.content)
    case 'blockquote':
      return (n.content ?? []).map((c) => '> ' + mdBlock(c)).join('\n>\n')
    case 'bulletList':
    case 'orderedList':
      return (n.content ?? [])
        .map((li, i) => {
          const bullet = n.type === 'bulletList' ? '-' : `${i + 1}.`
          const inner = (li.content ?? []).map((c) => mdBlock(c, indent + '   ')).join('\n')
          return `${indent}${bullet} ${inner.trimStart()}`
        })
        .join('\n')
    case 'codeBlock':
      return '```' + (n.attrs?.language ?? '') + '\n' + mdInline(n.content) + '\n```'
    case 'horizontalRule':
      return '---'
    default:
      return mdInline(n.content)
  }
}

export function toMarkdown(doc: JSONContent, title: string): string {
  return `---\ntitle: "${title}"\nbibliography: refs.bib\n---\n\n` + (doc.content ?? []).map((b) => mdBlock(b)).join('\n\n') + '\n'
}

// ------------------------------------------------------------------ LaTeX
const TEX_ESC: Record<string, string> = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
}
const esc = (s: string) => s.replace(/[\\&%$#_{}~^]/g, (c) => TEX_ESC[c])

/** \\cite{a,b}；带页码的文献单独写成 \\cite[p.~3]{a} */
function texCite(ids: string[], pages?: Record<string, string>): string {
  const papers = citeStore.get().papers
  const plain = ids.filter((id) => papers[id] && !pages?.[id])
  const located = ids.filter((id) => papers[id] && pages?.[id])
  const parts = located.map((id) => `\\cite[${pageLabel(pages![id]).replace(' ', '~')}]{${papers[id].bibkey}}`)
  if (plain.length) parts.unshift(`\\cite{${keysOf(plain).join(',')}}`)
  return parts.join('')
}

function texInline(nodes: JSONContent[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'citation') return texCite(n.attrs?.ids ?? [], n.attrs?.pages)
      if (n.type === 'hardBreak') return '\\\\\n'
      let t = esc(n.text ?? '')
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `\\textbf{${t}}`
        else if (m.type === 'italic') t = `\\emph{${t}}`
        else if (m.type === 'code') t = `\\texttt{${t}}`
      }
      return t
    })
    .join('')
}

function texBlock(n: JSONContent): string {
  switch (n.type) {
    case 'heading': {
      const cmd = ['section', 'section', 'subsection', 'subsubsection'][n.attrs?.level ?? 1] ?? 'paragraph'
      return `\\${cmd}{${texInline(n.content)}}`
    }
    case 'paragraph':
      return texInline(n.content)
    case 'blockquote':
      return `\\begin{quote}\n${(n.content ?? []).map(texBlock).join('\n\n')}\n\\end{quote}`
    case 'bulletList':
    case 'orderedList': {
      const env = n.type === 'bulletList' ? 'itemize' : 'enumerate'
      const items = (n.content ?? []).map((li) => '  \\item ' + (li.content ?? []).map(texBlock).join('\n')).join('\n')
      return `\\begin{${env}}\n${items}\n\\end{${env}}`
    }
    case 'codeBlock':
      return `\\begin{verbatim}\n${(n.content ?? []).map((c) => c.text).join('')}\n\\end{verbatim}`
    default:
      return texInline(n.content)
  }
}

export function toLatex(doc: JSONContent, title: string): string {
  const body = (doc.content ?? []).map(texBlock).filter(Boolean).join('\n\n')
  const zh = /[一-鿿]/.test(body + title)
  return `\\documentclass[11pt]{${zh ? 'ctexart' : 'article'}}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{hyperref}
\\usepackage[numbers,sort&compress]{natbib}

\\title{${esc(title)}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

${body}

\\bibliographystyle{${zh ? 'unsrtnat' : 'plainnat'}}
\\bibliography{refs}
\\end{document}
`
}

export function citedIds(doc: JSONContent): string[] {
  const nodes: JSONContent[] = []
  const walk = (n: JSONContent) => {
    nodes.push(n)
    n.content?.forEach(walk)
  }
  walk(doc)
  return collectCitationOrder({
    descendants: (f: (n: any) => void) => nodes.forEach((n) => f({ type: { name: n.type }, attrs: n.attrs ?? {} })),
  })
}

export function download(filename: string, text: string | Blob, mime = 'text/plain') {
  const blob = typeof text === 'string' ? new Blob([text], { type: `${mime};charset=utf-8` }) : text
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ------------------------------------------------------------------ Word（后端 pandoc + citeproc）
export type DocxStyle = 'gbt-numeric' | 'gbt-author-date' | 'apa'

/** 编辑器里的引用样式 → Word 的参考文献格式：顺序编码用 GB/T 7714；作者-年份中文用 GB/T 7714 著者-出版年，英文用 APA */
export function docxStyleFor(citeStyle: string, doc: JSONContent): DocxStyle {
  if (citeStyle === 'numeric') return 'gbt-numeric'
  const text = JSON.stringify(doc)
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk > 50 ? 'gbt-author-date' : 'apa'
}

export async function exportDocx(doc: JSONContent, title: string, style: DocxStyle): Promise<Blob> {
  const res = await fetch('/api/export/docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: toMarkdown(doc, title), title, paper_ids: citedIds(doc), style }),
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      msg = (await res.json()).detail ?? msg
    } catch {
      /* ignore */
    }
    throw new Error(`Word 导出失败：${msg}`)
  }
  return res.blob()
}
