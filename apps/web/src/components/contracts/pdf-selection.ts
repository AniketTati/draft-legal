/**
 * docs/39 C1 — a selection in the original PDF as a highlight (TextSelection):
 * its words, which of the passages worded alike it is, what's around it, and
 * where it is on screen.
 *
 * The PDF's text layer (pdf.js, under @react-pdf-viewer) is runs of text laid
 * out absolutely, one per span, with no space where a line breaks or where
 * pdf.js split a line into runs. The selection's words are rebuilt from those
 * runs: a space where a run starts a new line or leaves a gap, none where a
 * run continues a word. Which occurrence it is counts the matches before it —
 * in the earlier pages (their text from pdf.js, read once the file loads) and
 * on its own page — ignoring spacing, so it agrees with the version's text.
 */
import type { TextSelection } from './SelectionMenu'

/** A run of the text layer, with where it sits. */
export interface TextRun { text: string; top: number; bottom: number; left: number; right: number }

/** Text as compared for "which occurrence": no spaces, lower case. */
export const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '')

/** How many times `needle` appears in `hay`, not overlapping. */
export function countIn(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/**
 * Runs joined as they read: a space where the next run starts a new line (its
 * top is past the middle of the one before) or leaves a gap of more than a
 * quarter of the line's height; nothing where it carries on the same word.
 */
export function joinRuns(runs: readonly TextRun[]): string {
  let out = ''
  let prev: TextRun | null = null
  for (const r of runs) {
    if (!r.text) continue
    if (prev) {
      const height = Math.max(prev.bottom - prev.top, 1)
      const newLine = r.top > prev.top + height / 2 || r.top < prev.top - height / 2
      const gap = r.left - prev.right > height / 4
      if ((newLine || gap) && !/\s$/.test(out) && !/^\s/.test(r.text)) out += ' '
    }
    out += r.text
    prev = r
  }
  return out.replace(/\s+/g, ' ')
}

/** A run of text: pdf.js 5 draws each as a span, some inside a markedContent wrapper. */
const RUN = '.rpv-core__text-layer span:not(.markedContent)'
const MAX_SELECTION = 4000

/** The part of each run a range covers, in the order they read. */
function runsIn(range: Range, root: Element): TextRun[] {
  const out: TextRun[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(RUN))) {
    if (el.firstChild?.nodeType !== Node.TEXT_NODE || !range.intersectsNode(el)) continue
    const node = el.firstChild
    let text = el.textContent ?? ''
    // Cut to the range where it starts or ends in this run: in its text, or at the run itself (a child index).
    const at = (container: Node, offset: number, fallback: number) =>
      container === node ? offset : container === el ? (offset === 0 ? 0 : text.length) : fallback
    const start = at(range.startContainer, range.startOffset, 0)
    const end = at(range.endContainer, range.endOffset, text.length)
    text = text.slice(start, Math.max(start, end))
    const b = el.getBoundingClientRect()
    out.push({ text, top: b.top, bottom: b.bottom, left: b.left, right: b.right })
  }
  return out
}

/** The page a node is on (0-based), from react-pdf-viewer's page layers. */
function pageOf(node: Node): { layer: Element; page: number } | null {
  const el = node instanceof Element ? node : node.parentElement
  const layer = el?.closest('.rpv-core__text-layer')
  if (!layer) return null
  const page = Number(layer.closest('[data-testid^="core__page-layer-"]')?.getAttribute('data-testid')?.replace('core__page-layer-', '') ?? 0)
  return { layer, page: Number.isFinite(page) ? page : 0 }
}

/**
 * The browser's selection in the PDF as a highlight, or null when there's
 * none there. `pageTexts`: each page's text (squashed), once read; without
 * them the count starts at the selection's own page.
 */
export function pdfSelectionOf(container: HTMLElement, pageTexts: readonly string[] | null): TextSelection | null {
  const s = window.getSelection()
  if (!s || s.rangeCount === 0 || s.isCollapsed) return null
  const range = s.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const at = pageOf(range.startContainer)
  if (!at) return null
  const text = joinRuns(runsIn(range, container)).trim()
  if (text.length < 2 || text.length > MAX_SELECTION) return null

  // What's before and after it on its page: a new field's name is in there (C3).
  const pre = document.createRange()
  pre.setStart(at.layer, 0)
  pre.setEnd(range.startContainer, range.startOffset)
  const post = document.createRange()
  post.setStart(range.endContainer, range.endOffset)
  post.setEnd(at.layer, at.layer.childNodes.length)
  const before = joinRuns(runsIn(pre, at.layer))
  const after = joinRuns(runsIn(post, at.layer))

  const needle = squash(text)
  let occurrence = countIn(squash(before), needle)
  for (let i = 0; i < at.page; i++) occurrence += countIn(pageTexts?.[i] ?? '', needle)

  const r = range.getBoundingClientRect()
  return {
    text, occurrence,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
    before: before.slice(-120), after: after.slice(0, 120),
  }
}

/** A pdf.js page's text, squashed, as pdfSelectionOf counts with it. */
export const pageTextOf = (items: ReadonlyArray<{ str?: string }>) => squash(items.map(i => i.str ?? '').join(''))
