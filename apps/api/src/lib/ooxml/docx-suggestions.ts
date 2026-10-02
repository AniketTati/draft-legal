/**
 * docs/41 Part 16 (C4) — a Word file's tracked changes, shown as suggestions.
 *
 * mammoth reads a .docx with every tracked change accepted and keeps no
 * trace of them, so an upload's changes used to arrive as plain text. Here
 * the file's own tracked changes (docxTrackedParagraphs) are laid back over
 * mammoth's HTML as suggestion marks — <ins>/<del data-change-id
 * data-author data-time> — with the author and date Word recorded, so the
 * editor shows them and they can be accepted or rejected one by one.
 *
 * Only where it is safe: a paragraph is marked when mammoth's text for it is
 * exactly Word's accepted text, in the same order. Anything else (a
 * paragraph mammoth reshaped: a list re-read from "\t•\t" text, a line break,
 * a footnote marker; a table cell's own changes) keeps mammoth's text with
 * the changes accepted, as before — the known limit.
 */
import { parseFragment, serialize, defaultTreeAdapter as A } from 'parse5'
import type { TrackedParagraph, TrackedSegment } from './docx-redline.js'

type Node = {
  nodeName: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
  parentNode?: Node | null
}

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th'])

/** A block's text nodes in order, unless it holds a nested block or a line break. */
function textNodesOf(block: Node): Node[] | null {
  const out: Node[] = []
  let ok = true
  const walk = (n: Node) => {
    for (const c of n.childNodes ?? []) {
      if (c.nodeName === '#text') out.push(c)
      else if (BLOCKS.has(c.nodeName) || c.nodeName === 'br' || c.nodeName === 'ul' || c.nodeName === 'ol') ok = false
      else walk(c)
    }
  }
  walk(block)
  return ok ? out : null
}

function blocksOf(root: Node): Node[] {
  const out: Node[] = []
  const walk = (n: Node) => { for (const c of n.childNodes ?? []) { if (BLOCKS.has(c.nodeName)) out.push(c); walk(c) } }
  walk(root)
  return out
}

/** "word:<name>": an author known only by the name in the file. */
export const wordAuthorId = (name: string) => `word:${name}`

function markEl(tag: 'ins' | 'del', s: TrackedSegment, at: string, salt: string): Node {
  const date = s.date && !Number.isNaN(new Date(s.date).getTime()) ? new Date(s.date).toISOString() : at
  return A.createElement(tag, 'http://www.w3.org/1999/xhtml' as never, [
    // Word's ids are unique in one file only: salted per import, so a later
    // upload's w:id 3 is not the same change as this one's.
    { name: 'data-change-id', value: `w${s.id || Math.random().toString(36).slice(2, 8)}-${salt}` },
    { name: 'data-author-id', value: wordAuthorId(s.author) },
    { name: 'data-author', value: s.author },
    { name: 'data-time', value: date },
  ]) as unknown as Node
}

/** Put the paragraph's changes into its text nodes. Returns false when they don't line up. */
function overlay(block: Node, para: TrackedParagraph, at: string, salt: string): boolean {
  const texts = textNodesOf(block)
  if (!texts || texts.map(t => t.value ?? '').join('') !== para.accepted) return false
  // Where each segment falls in the accepted text.
  const cuts: Array<{ start: number; end: number; seg: TrackedSegment }> = []
  let o = 0
  for (const seg of para.segments) {
    if (seg.kind === 'del') { cuts.push({ start: o, end: o, seg }); continue }
    cuts.push({ start: o, end: o + seg.text.length, seg })
    o += seg.text.length
  }
  let base = 0
  texts.forEach((t, ti) => {
    const value = t.value ?? ''
    const from = base, to = base + value.length
    base = to
    const last = ti === texts.length - 1
    const parent = t.parentNode as Node
    const made: Node[] = []
    for (const c of cuts) {
      if (c.seg.kind === 'del') {
        // A deletion goes in the text node it falls in (at its end only for the last).
        if (c.start >= from && (c.start < to || (last && c.start === to))) {
          const el = markEl('del', c.seg, at, salt)
          A.insertText(el as never, c.seg.text)
          made.push(el)
        }
        continue
      }
      const a = Math.max(c.start, from), b = Math.min(c.end, to)
      if (b <= a) continue
      const piece = value.slice(a - from, b - from)
      if (c.seg.kind === 'ins') {
        const el = markEl('ins', c.seg, at, salt)
        A.insertText(el as never, piece)
        made.push(el)
      } else {
        made.push({ nodeName: '#text', value: piece, parentNode: parent })
      }
    }
    for (const m of made) A.insertBefore(parent as never, m as never, t as never)
    A.detachNode(t as never)
  })
  return true
}

/**
 * mammoth's HTML with the file's tracked changes as suggestions, where they
 * line up (see the header). Returns the HTML unchanged when there are none.
 */
export function withSuggestions(html: string, paras: TrackedParagraph[], now = new Date()): { html: string; marked: number; skipped: number } {
  if (!paras.length) return { html, marked: 0, skipped: 0 }
  const root = parseFragment(html) as unknown as Node
  const blocks = blocksOf(root)
  let next = 0, marked = 0
  const salt = Math.random().toString(36).slice(2, 7)
  for (const para of paras) {
    // A paragraph deleted whole has no text in mammoth's reading to hang on.
    if (!para.accepted) continue
    // Paragraphs come in document order; look forward from the last match.
    for (let i = next; i < blocks.length; i++) {
      const texts = textNodesOf(blocks[i])
      if (!texts || texts.map(t => t.value ?? '').join('') !== para.accepted) continue
      if (overlay(blocks[i], para, now.toISOString(), salt)) { marked++; next = i + 1 }
      break
    }
  }
  return { html: marked ? serialize(root as never) : html, marked, skipped: paras.length - marked }
}
