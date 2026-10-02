/**
 * SourceHighlight (docs/39 B2) — "show in document": highlight the passage a
 * field's value came from and scroll to it.
 *
 * A value used to show its source only as a hover tooltip, so checking it
 * meant reading the contract to find the sentence. The store keeps each
 * value's exact wording from the current version (anchor.text); this finds it
 * in the canvas — ignoring case, spacing, curly quotes and paragraph breaks —
 * and marks it with a transient decoration (the document itself never
 * changes).
 */
import { Extension, type Editor } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

const key = new PluginKey<DecorationSet>('sourceHighlight')

type Meta = { from: number; to: number } | null

export const SourceHighlight = Extension.create({
  name: 'sourceHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, prev) {
            const meta = tr.getMeta(key) as Meta | undefined
            if (meta === null) return DecorationSet.empty
            if (meta) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: 'source-highlight', 'data-testid': 'source-highlight' }),
              ])
            }
            return prev.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) { return key.getState(state) ?? null },
        },
      }),
    ]
  },
})

/**
 * The editor's view, or null while there is none to use: a destroyed editor,
 * or one not mounted yet (TipTap throws on any use of its view then, and
 * the page swaps editors when editing starts and stops).
 */
export function viewOf(editor: Editor | null): EditorView | null {
  if (!editor || editor.isDestroyed) return null
  try {
    void editor.view.dom
    return editor.view
  } catch {
    return null
  }
}

/** The document's text with block boundaries as spaces, and each character's position. */
function flatten(doc: PMNode): { text: string; pos: number[] } {
  const chars: string[] = []
  const pos: number[] = []
  doc.descendants((node, p) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) { chars.push(node.text[i]); pos.push(p + i) }
    } else if (node.isBlock && chars.length && chars[chars.length - 1] !== ' ') {
      chars.push(' ')
      pos.push(p)
    }
    return true
  })
  return { text: chars.join(''), pos }
}

function normalize(s: string): { norm: string; map: number[] } {
  const norm: string[] = []
  const map: number[] = []
  let space = false
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]
    if (/\s/.test(ch)) {
      if (space || norm.length === 0) continue
      ch = ' '
      space = true
    } else {
      space = false
      if (ch === '‘' || ch === '’' || ch === '`') ch = "'"
      else if (ch === '“' || ch === '”') ch = '"'
      else if (ch === '–' || ch === '—') ch = '-'
      else ch = ch.toLowerCase()
    }
    norm.push(ch)
    map.push(i)
  }
  return { norm: norm.join(''), map }
}

/** The passage as written, then shorter openings of it (a quote may run past what the canvas shows). */
function candidates(text: string): string[] {
  // docs/39 A10 — a PDF table's row reads "cell | cell" in the contract's
  // text; the document shows the cells side by side.
  const t = text.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const out = [t]
  for (const n of [160, 80]) {
    if (t.length > n) {
      const cut = t.slice(0, n).lastIndexOf(' ')
      if (cut > n / 2) out.push(t.slice(0, cut))
    }
  }
  return out
}

let clearTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Which of the passages worded like `text` is the one starting at `from`
 * (0 = the first): what a highlight sends, so its value is placed at the
 * words the reader picked and not the first ones like them (docs/39 C2).
 */
export function occurrenceAt(editor: Editor, from: number, text: string): number {
  const { text: flat, pos } = flatten(editor.state.doc)
  const hay = normalize(flat)
  const needle = normalize(text).norm.trim()
  if (!needle) return 0
  let k = 0
  for (let at = hay.norm.indexOf(needle); at >= 0; at = hay.norm.indexOf(needle, at + needle.length)) {
    if (pos[hay.map[at]] >= from) return k
    k++
  }
  return 0
}

/** Where the `occurrence`-th passage worded like `needle` starts, else the first. */
function nth(hay: string, needle: string, occurrence: number): number {
  let at = hay.indexOf(needle)
  const first = at
  for (let i = 0; i < occurrence && at >= 0; i++) at = hay.indexOf(needle, at + needle.length)
  return at >= 0 ? at : first
}

/**
 * Highlight `text` in the canvas and scroll it into view: the
 * `occurrence`-th passage worded like it, when the same words appear more
 * than once. Returns whether it was found.
 */
export function revealInCanvas(editor: Editor | null, text: string, occurrence = 0): boolean {
  const view = viewOf(editor)
  if (!editor || !view || !text?.trim()) return false
  const { text: flat, pos } = flatten(editor.state.doc)
  const hay = normalize(flat)
  for (const c of candidates(text)) {
    const needle = normalize(c).norm.trim()
    if (needle.length < 3) continue
    const at = nth(hay.norm, needle, occurrence)
    if (at < 0) continue
    return revealRange(editor, pos[hay.map[at]], pos[hay.map[at + needle.length - 1]] + 1)
  }
  return false
}

/**
 * docs/41 Part 16 — where a comment's words are in the canvas: the passage
 * worded like `text` nearest `nearChar` (its old place in the plain text),
 * as editor positions, or null when the words are no longer there.
 */
export function findInCanvas(editor: Editor | null, text: string, nearChar = 0): { from: number; to: number } | null {
  if (!editor || editor.isDestroyed || !text?.trim()) return null
  const { text: flat, pos } = flatten(editor.state.doc)
  const hay = normalize(flat)
  const needle = normalize(text).norm.trim()
  if (needle.length < 2) return null
  let best = -1
  for (let at = hay.norm.indexOf(needle); at >= 0; at = hay.norm.indexOf(needle, at + 1)) {
    if (best < 0 || Math.abs(hay.map[at] - nearChar) < Math.abs(hay.map[best] - nearChar)) best = at
  }
  if (best < 0) return null
  return { from: pos[hay.map[best]], to: pos[hay.map[best + needle.length - 1]] + 1 }
}

/** The selection's place in the document's plain text, for a comment's anchor. */
export function charOffsetAt(editor: Editor, from: number): number {
  return editor.state.doc.textBetween(0, Math.max(0, from), ' ').length
}

/** Highlight the canvas between two positions and scroll it into view (docs/39 H2: a variable's place). */
export function revealRange(editor: Editor | null, from: number, to: number): boolean {
  const view = viewOf(editor)
  if (!editor || !view || to <= from || to > editor.state.doc.content.size) return false
  view.dispatch(editor.state.tr.setMeta(key, { from, to } satisfies Meta))
  // The highlight itself, not its paragraph: an uploaded contract is often
  // one paragraph pages long, and centring that loses the passage.
  const mark = view.dom.querySelector('.source-highlight')
  const dom = view.domAtPos(from).node
  const el = mark ?? (dom instanceof HTMLElement ? dom : dom.parentElement)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    viewOf(editor)?.dispatch(editor.state.tr.setMeta(key, null))
  }, 8000)
  return true
}

const QUOTES = /['‘’`]/g
const DOUBLE_QUOTES = /["“”]/g
const DASHES = /[–—-]/g

/**
 * The same passage as a pattern for the original PDF's search, whose page
 * text runs lines together without spaces: its opening words, any spacing
 * (or none) between them, curly or straight quotes, any dash.
 *
 * Global on purpose: the viewer's search loops `exec` until it returns
 * null, which a non-global pattern never does.
 */
export function pdfSearchPattern(text: string, maxWords = 12): RegExp | null {
  // A10 — a table's cell separators aren't on the page.
  const words = text.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, maxWords)
  if (!words.length) return null
  const word = (w: string) => w
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(QUOTES, "['‘’`]")
    .replace(DOUBLE_QUOTES, '["“”]')
    .replace(DASHES, '[-–—]')
  return new RegExp(words.map(word).join('\\s*'), 'gi')
}
