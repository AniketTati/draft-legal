/**
 * BB1 — a version's HTML as the Word engine compares it with the
 * counterparty's .docx: its paragraphs in reading order, each with what kind
 * of paragraph it is, so a new one can be formatted like its neighbours.
 *
 * Mammoth's footnotes (the list it appends, and the "[1]" markers in the
 * text) are left out: Word keeps notes in their own part, not in the body.
 */
import { parseFragment } from 'parse5'
import { acceptedHtml } from '../suggestions.js'

type Node = {
  nodeName: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
}

export type BlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'cell'
export interface TextBlock { text: string; kind: BlockKind; inTable: boolean }

const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'div', 'td', 'th', 'tr', 'table', 'thead',
  'tbody', 'tfoot', 'ul', 'ol', 'dl', 'dt', 'dd', 'caption', 'section', 'article', 'header', 'footer', 'figure',
  'figcaption', 'hr', 'address', 'main', 'nav', 'aside', 'details', 'summary',
])
const SKIP = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', '#comment'])

const attr = (n: Node, name: string) => n.attrs?.find(a => a.name === name)?.value ?? ''

const NOTE_REF = /^#(?:foot|end)note-\d+$/
const NOTE_BACKLINK = /^#(?:foot|end)note-ref-\d+$/

function textOf(n: Node): string {
  if (n.nodeName === '#text') return n.value ?? ''
  return (n.childNodes ?? []).map(textOf).join('')
}

/** A footnote or endnote as mammoth writes it, even after the editor dropped its id. */
function isNoteBody(li: Node): boolean {
  if (/^(?:foot|end)note-\d+$/.test(attr(li, 'id'))) return true
  const links: Node[] = []
  const walk = (n: Node) => { if (n.nodeName === 'a') links.push(n); n.childNodes?.forEach(walk) }
  walk(li)
  return links.some(a => NOTE_BACKLINK.test(attr(a, 'href'))) || /↑\s*$/.test(textOf(li))
}

function kindOf(tag: string, parent: BlockKind): BlockKind {
  if (/^h[1-6]$/.test(tag)) return tag as BlockKind
  if (tag === 'li') return 'li'
  if (tag === 'td' || tag === 'th') return 'cell'
  return parent === 'li' || parent === 'cell' ? parent : 'p'
}

export function htmlBlocks(html: string): TextBlock[] {
  const out: TextBlock[] = []
  let buf = ''
  const flush = (kind: BlockKind, inTable: boolean) => {
    const text = buf
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[^\S\n\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim()
    if (text.replace(/[\s\u00a0]+/g, '')) out.push({ text, kind, inTable })
    buf = ''
  }
  const walk = (n: Node, kind: BlockKind, inTable: boolean) => {
    for (const c of n.childNodes ?? []) {
      const tag = c.nodeName
      if (tag === '#text') { buf += (c.value ?? '').replace(/[ \t\n\r\f]+/g, ' '); continue }
      if (SKIP.has(tag)) continue
      if (tag === 'br') { buf += '\n'; continue }
      if (tag === 'a' && (NOTE_REF.test(attr(c, 'href')) || /^(?:foot|end)note-ref-/.test(attr(c, 'id')))) continue
      if (tag === 'li' && isNoteBody(c)) continue
      if (!BLOCK.has(tag)) { walk(c, kind, inTable); continue }
      flush(kind, inTable)
      const k = kindOf(tag, kind), t = inTable || tag === 'table'
      walk(c, k, t)
      flush(k, t)
    }
  }
  // C4 — the document's text with its pending suggestions accepted (lib/suggestions).
  walk(parseFragment(acceptedHtml(html)) as unknown as Node, 'p', false)
  flush('p', false)
  return out
}
