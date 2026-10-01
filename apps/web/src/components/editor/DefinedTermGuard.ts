/**
 * DefinedTermGuard — P6.4 / docs/30 Wave G.4, docs/41 Part 10
 *
 * Defined terms on the contract canvas:
 *
 *   - Hover a defined term: its definition shows. Click it while reading:
 *     the page jumps to where it is defined.
 *   - A variant typed in another case ("the services" for "Services") gets a
 *     dotted underline; "Apply defined term everywhere" fixes them.
 *
 * The glossary comes from the API (GET /contracts/:id/defined-terms, worked
 * out by lib/defined-terms.ts on the version's text), pushed in with
 * `updateDefinedTermGlossary`. Until it arrives (or while a new draft is being
 * typed) the terms are read here, from the standard markers:
 *       “Term” means …   (the “Term”)   hereinafter referred to as “Term”
 * in straight AND curly quotes: DOCX files carry curly ones, which the first
 * version of this file didn't match, so most real contracts showed nothing.
 *
 * Purely client-side; no LLM round-trip.
 */
import { Extension } from '@tiptap/react' // re-exported from @tiptap/core
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export interface DefinedTerm {
  canonical: string
  aliases:   string[]            // variants the author deliberately used
  definedAt: { from: number; to: number }
  /** The definition as the contract writes it (from the API's glossary). */
  definition?: string
}

export interface TermFlag {
  term:       string            // canonical defined term
  found:      string            // what the author actually typed
  reason:     'case' | 'variant'
  from:       number
  to:         number
}

/** A glossary entry from the API. */
export interface GlossaryTerm {
  term: string
  definition: string
}

export interface LexiconState {
  terms:    DefinedTerm[]
  flags:    TermFlag[]
  glossary: GlossaryTerm[]
  decos:    DecorationSet
}

const LexiconKey = new PluginKey<LexiconState>('definedTermGuard')

// The standard defined-term markers, straight or curly quotes:
//   `"Term" means`, `(the "Term")`, `(hereinafter "Term")`, `as "Term"`
const QO = '["“‘]'
const QC = '["”’]'
const T = '([A-Z][A-Za-z0-9\\- ]{1,40}?)'
const PATTERNS: RegExp[] = [
  new RegExp(`${QO}${T}${QC}\\s+(?:means|shall mean|has the meaning)`, 'g'),
  new RegExp(`\\(\\s*(?:the\\s+|each\\s+an?\\s+|together\\s+the\\s+)?${QO}${T}${QC}`, 'g'),
  new RegExp(`\\(\\s*hereinafter[^"“”]{0,40}${QO}${T}${QC}\\s*\\)`, 'gi'),
  new RegExp(`hereinafter\\s+referred\\s+to\\s+as\\s+${QO}${T}${QC}`, 'gi'),
  new RegExp(`as\\s+${QO}${T}${QC}\\s*(?:\\)|,|\\.)`, 'g'),
]

/** Defined terms read from the text itself, with where each is defined. */
export function extractTerms(text: string): Array<{ term: string; index: number }> {
  const out: Array<{ term: string; index: number }> = []
  const seen = new Set<string>()
  for (const rx of PATTERNS) {
    rx.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      const t = m[1].trim()
      if (t.length < 3) continue
      if (seen.has(t.toLowerCase())) continue
      seen.add(t.toLowerCase())
      out.push({ term: t, index: m.index + m[0].indexOf(m[1]) })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DRIFT_CUE = /(?:^|[^A-Za-z])(?:the|this|such|said|that|each)\s+$/i

/**
 * Uses of a defined term typed in another case. A one-word term ("Services")
 * only counts where the sentence points at the defined thing ("the services"):
 * "other services" is the ordinary word. Same rule as the API's check.
 */
export function findFlags(text: string, terms: string[]): TermFlag[] {
  const flags: TermFlag[] = []
  for (const term of terms) {
    const rx = new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?![A-Za-z0-9])`, 'gi')
    const single = !/\s/.test(term)
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      const found = m[0]
      if (found === term) continue                       // exact match — no flag
      if (found === found.toUpperCase()) continue         // a heading in capitals
      if (single && !DRIFT_CUE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
      if (/^\s*["“‘]/.test(text.slice(m.index + found.length, m.index + found.length + 3))) continue
      // The term's own definition ("“Services” means the services in Schedule 1").
      const before = text.slice(Math.max(0, m.index - 200), m.index)
      const quoted = before.search(new RegExp(`${QO}${esc(term)}${QC}[^.;\\n]*$`))
      if (quoted >= 0) continue
      flags.push({ term, found, reason: 'case', from: m.index, to: m.index + found.length })
    }
  }
  return flags
}

/** Exact uses of the terms, longest first so "Customer" inside "Customer Data" isn't one. */
export function findUses(text: string, terms: string[]): Array<{ term: string; from: number; to: number }> {
  const uses: Array<{ term: string; from: number; to: number }> = []
  const taken: Array<[number, number]> = []
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const rx = new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?:s|es)?(?![A-Za-z0-9])`, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(text))) {
      const from = m.index, to = from + m[0].length
      if (taken.some(([a, b]) => from < b && to > a)) continue
      taken.push([from, to])
      uses.push({ term, from, to })
    }
  }
  return uses
}

// ─── Text ↔ document positions ───────────────────────────────────────────────

interface Segment { posStart: number; textStart: number; text: string }

/** The document's text, and where each text node starts in it and in the document. */
function segmentsOf(doc: PMNode): { text: string; segments: Segment[] } {
  const segments: Segment[] = []
  let text = ''
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    segments.push({ posStart: pos, textStart: text.length, text: node.text ?? '' })
    text += node.text ?? ''
    return false
  })
  return { text, segments }
}

/** The document range of [from, to) in the text, when it sits in one text node. */
function rangeOf(segments: Segment[], from: number, to: number): { from: number; to: number } | null {
  let lo = 0, hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid]
    if (from < s.textStart) hi = mid - 1
    else if (from >= s.textStart + s.text.length) lo = mid + 1
    else {
      if (to > s.textStart + s.text.length) return null
      return { from: s.posStart + (from - s.textStart), to: s.posStart + (to - s.textStart) }
    }
  }
  return null
}

function flattenText(doc: PMNode): string {
  return segmentsOf(doc).text
}

function shortDefinition(def: string): string {
  const t = def.replace(/\s+/g, ' ').trim()
  return t.length > 280 ? `${t.slice(0, 279)}…` : t
}

function scanState(doc: PMNode, glossary: GlossaryTerm[]): { terms: DefinedTerm[]; flags: TermFlag[] } {
  const text = flattenText(doc)
  const local = extractTerms(text)
  const byTerm = new Map(glossary.map(g => [g.term, g.definition]))
  // The API's glossary when there is one; terms only typed here since join it.
  const names = [...new Set([...glossary.map(g => g.term), ...local.map(l => l.term)])]
  const terms: DefinedTerm[] = names.map(name => {
    let index = local.find(l => l.term === name)?.index ?? -1
    if (index < 0) {
      const quoted = text.search(new RegExp(`${QO}${esc(name)}${QC}`))
      index = quoted >= 0 ? quoted + 1 : text.indexOf(name)
    }
    return {
      canonical: name,
      aliases: [],
      definedAt: { from: Math.max(0, index), to: Math.max(0, index) + name.length },
      definition: byTerm.get(name),
    }
  })
  return { terms, flags: names.length ? findFlags(text, names) : [] }
}

function decorationsFor(doc: PMNode, terms: DefinedTerm[], flags: TermFlag[]): DecorationSet {
  const { text, segments } = segmentsOf(doc)
  const decos: Decoration[] = []
  for (const f of flags) {
    const r = rangeOf(segments, f.from, f.to)
    if (!r) continue
    decos.push(Decoration.inline(r.from, r.to, {
      class: 'defined-term-flag',
      'data-testid': `defined-term-${f.term.toLowerCase().replace(/\s+/g, '-')}`,
      'data-term':   f.term,
      'data-found':  f.found,
      title: `Defined term written differently: "${f.found}" should be "${f.term}"`,
    }))
  }
  // Hover: a defined term's uses show its definition.
  const withDefinition = terms.filter(t => t.definition)
  const definitions = new Map(withDefinition.map(t => [t.canonical, t]))
  for (const u of findUses(text, withDefinition.map(t => t.canonical))) {
    const t = definitions.get(u.term)!
    // Its own definition isn't a use.
    if (u.from >= t.definedAt.from - 1 && u.to <= t.definedAt.to + 1) continue
    const r = rangeOf(segments, u.from, u.to)
    if (!r) continue
    decos.push(Decoration.inline(r.from, r.to, {
      class: 'defined-term-use',
      'data-term': u.term,
      title: `${u.term}: ${shortDefinition(t.definition!)}`,
    }))
  }
  return DecorationSet.create(doc, decos)
}

/** Select and scroll to [from, to) of the document's text. */
function revealTextRange(view: EditorView, from: number, to: number): boolean {
  const r = rangeOf(segmentsOf(view.state.doc).segments, from, to)
  if (!r) return false
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from, r.to)).scrollIntoView())
  // A read-only view neither draws its selection nor scrolls the page's own
  // scroller to it: bring the passage to the middle of the screen.
  const at = view.domAtPos(r.from)
  const el = (at.node.nodeType === 1 ? at.node : at.node.parentElement) as HTMLElement | null
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  return true
}

export interface DefinedTermGuardOptions {
  enabled: boolean
  /** How often to rescan after doc changes (ms). */
  debounceMs: number
}

export const DefinedTermGuard = Extension.create<DefinedTermGuardOptions>({
  name: 'definedTermGuard',

  addOptions() {
    return { enabled: true, debounceMs: 600 }
  },

  addProseMirrorPlugins() {
    const opts = this.options
    let timer: ReturnType<typeof setTimeout> | null = null

    const scan = (view: EditorView) => {
      const glossary = LexiconKey.getState(view.state)?.glossary ?? []
      view.dispatch(view.state.tr.setMeta('lexiconScan', scanState(view.state.doc, glossary)))
    }

    const schedule = (view: EditorView) => {
      if (!opts.enabled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => scan(view), opts.debounceMs)
    }

    return [
      new Plugin({
        key: LexiconKey,
        state: {
          init: (): LexiconState => ({ terms: [], flags: [], glossary: [], decos: DecorationSet.empty }),
          apply(tr, value, _old, newState): LexiconState {
            const glossary = tr.getMeta('lexiconGlossary') as GlossaryTerm[] | undefined
            if (glossary) {
              const { terms, flags } = scanState(newState.doc, glossary)
              return { terms, flags, glossary, decos: decorationsFor(newState.doc, terms, flags) }
            }
            const meta = tr.getMeta('lexiconScan') as { terms: DefinedTerm[]; flags: TermFlag[] } | undefined
            if (meta) {
              return { ...value, terms: meta.terms, flags: meta.flags, decos: decorationsFor(newState.doc, meta.terms, meta.flags) }
            }
            if (tr.docChanged) {
              // Rebuilt on the next scan; meanwhile they follow the edits.
              return { ...value, decos: value.decos.map(tr.mapping, newState.doc) }
            }
            return value
          },
        },
        props: {
          decorations(state) { return this.getState(state)?.decos ?? DecorationSet.empty },
          // Reading, a click on a defined term jumps to its definition. Editing,
          // a click places the caret as usual. A DOM handler: ProseMirror's
          // handleClick only runs while the document is editable.
          handleDOMEvents: {
            click(view, event) {
              if (view.editable) return false
              const el = (event.target as HTMLElement | null)?.closest?.('.defined-term-use') as HTMLElement | null
              const name = el?.getAttribute('data-term')
              if (!name) return false
              const term = LexiconKey.getState(view.state)?.terms.find(t => t.canonical === name)
              return !!term && revealTextRange(view, term.definedAt.from, term.definedAt.to)
            },
          },
        },
        view(view) {
          setTimeout(() => scan(view), 200)
          return {
            update(view, prev) {
              if (view.state.doc !== prev.doc) schedule(view)
            },
            destroy() { if (timer) clearTimeout(timer) },
          }
        },
      }),
    ]
  },
})

/**
 * Snapshot helpers so the container page can read the current
 * state without taking a dependency on ProseMirror internals.
 */
export function getLexiconState(editor: import('@tiptap/react').Editor): LexiconState | null {
  return LexiconKey.getState(editor.state) ?? null
}

/** Give the canvas the API's glossary: hovering a term then shows its definition. */
export function updateDefinedTermGlossary(editor: import('@tiptap/react').Editor, glossary: GlossaryTerm[]): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta('lexiconGlossary', glossary))
}

/**
 * Show a passage in the canvas: the first place `needle` is written (quotes
 * and spacing however typed), or a defined term's definition. False when the
 * canvas doesn't have it.
 */
export function revealInCanvas(editor: import('@tiptap/react').Editor, needle: string): boolean {
  const { text } = segmentsOf(editor.state.doc)
  const words = needle.replace(/[“”"‘’']/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 12).map(esc)
  if (!words.length) return false
  const m = new RegExp(words.join(`[\\s"“”‘’']+`)).exec(text.replace(/[“”‘’]/g, '"'))
  if (!m) return false
  return revealTextRange(editor.view, m.index, m.index + m[0].length)
}

/**
 * "Apply everywhere" — replace every flagged occurrence with its
 * canonical form in a single tx. Returns the number of edits made.
 */
export function normalizeDefinedTerms(editor: import('@tiptap/react').Editor): number {
  const plug = LexiconKey.getState(editor.state)
  if (!plug || plug.flags.length === 0) return 0
  // Re-scan + replace ONE flag per iteration. Walking fresh each
  // time dodges positional-drift bugs that plague batched multi-op
  // transactions.
  let edits = 0
  let safety = 100
  while (safety-- > 0) {
    const glossary = LexiconKey.getState(editor.state)?.glossary ?? []
    const { flags } = scanState(editor.state.doc, glossary)
    if (flags.length === 0) break
    const f = flags[0]
    const r = rangeOf(segmentsOf(editor.state.doc).segments, f.from, f.to)
    if (!r) break
    const ok = editor.commands.insertContentAt(r, f.term, {
      updateSelection: false,
      parseOptions:    { preserveWhitespace: 'full' },
    })
    if (!ok) break
    edits++
  }
  // Repaint now rather than on the debounced tick.
  if (edits > 0) {
    const glossary = LexiconKey.getState(editor.state)?.glossary ?? []
    editor.view.dispatch(editor.state.tr.setMeta('lexiconScan', scanState(editor.state.doc, glossary)))
  }
  return edits
}

export default DefinedTermGuard
