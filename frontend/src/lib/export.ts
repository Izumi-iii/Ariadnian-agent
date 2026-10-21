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

export function download(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
