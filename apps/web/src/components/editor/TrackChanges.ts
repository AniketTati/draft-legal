/**
 * docs/41 Part 16 (C4) — suggestion mode: track changes inside the editor.
 *
 * No maintained TipTap track-changes extension is in the lockfile (the
 * official one is a paid Pro extension), so this is a small one of our own:
 *
 *   - two marks, `insertion` and `deletion`, each with {id, authorId,
 *     authorName, at}. They are stored in the document's HTML as
 *     <ins data-change-id data-author-id data-author data-time> and
 *     <del …>, which is also what the Word export reads (w:ins / w:del).
 *   - while suggesting, a plugin rewrites each edit after it happens
 *     (appendTransaction): typed or pasted words get an insertion mark, and
 *     words removed are put back with a deletion mark instead of going. A
 *     selection typed over is both: its words marked deleted, the new ones
 *     inserted after them.
 *   - deleting your own suggested words removes them (nothing to review),
 *     and so does deleting someone else's: it takes back that part of their
 *     suggestion rather than piling a deletion on an insertion.
 *   - accept / reject one change by id, or every change.
 *
 * What it does not track: formatting (bold…), splitting or joining
 * paragraphs, tables. Those apply as ordinary edits, as before C4.
 */
import { Extension, Mark } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Fragment, Slice, type Mark as PMMark, type MarkType, type Node as PMNode } from '@tiptap/pm/model'
import { ReplaceStep } from '@tiptap/pm/transform'

export interface SuggestionAuthor { id: string; name: string }
export type SuggestionKind = 'insertion' | 'deletion'

/** Meta that tells the plugin to leave a transaction as it is. */
export const SKIP_TRACKING = 'trackChangesSkip'

/** Colours a person's suggestions take, picked by their id (stable across sessions). */
export const SUGGESTION_COLOURS = 6
export function colourOf(authorId: string | null | undefined): number {
  let h = 0
  for (const c of authorId ?? '') h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % SUGGESTION_COLOURS
}

export const newChangeId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function suggestionMark(name: SuggestionKind, tag: 'ins' | 'del') {
  return Mark.create({
    name,
    // Above StarterKit's Strike, which would otherwise take every <del>.
    priority: 1000,
    inclusive: false,
    // A word is either suggested in or suggested out, never both.
    excludes: name === 'insertion' ? 'deletion' : 'insertion',
    addAttributes() {
      return {
        id: { default: null, parseHTML: el => el.getAttribute('data-change-id'), renderHTML: a => ({ 'data-change-id': a.id }) },
        authorId: { default: null, parseHTML: el => el.getAttribute('data-author-id'), renderHTML: a => (a.authorId ? { 'data-author-id': a.authorId, 'data-color': String(colourOf(a.authorId)) } : {}) },
        authorName: { default: null, parseHTML: el => el.getAttribute('data-author'), renderHTML: a => (a.authorName ? { 'data-author': a.authorName } : {}) },
        at: { default: null, parseHTML: el => el.getAttribute('data-time'), renderHTML: a => (a.at ? { 'data-time': a.at } : {}) },
      }
    },
    parseHTML() {
      return [{ tag: `${tag}[data-change-id]` }]
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, { ...HTMLAttributes, class: `suggestion suggestion-${tag}` }, 0]
    },
  })
}

export const Insertion = suggestionMark('insertion', 'ins')
export const Deletion = suggestionMark('deletion', 'del')

/** One pending change: its id and kind, who made it, and where it is now. */
export interface SuggestionRange {
  id: string
  kind: SuggestionKind
  authorId: string | null
  authorName: string | null
  at: string | null
  from: number
  to: number
  text: string
}

/** Every pending suggestion in the document, one entry per change (runs joined). */
export function suggestionsIn(doc: PMNode): SuggestionRange[] {
  const byId = new Map<string, SuggestionRange>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.marks) {
      const kind = m.type.name as SuggestionKind
      if (kind !== 'insertion' && kind !== 'deletion') continue
      const id = String(m.attrs.id ?? '')
      const key = `${kind}:${id}`
      const r = byId.get(key)
      if (r) { r.from = Math.min(r.from, pos); r.to = Math.max(r.to, pos + node.nodeSize); r.text += node.text ?? '' }
      else byId.set(key, { id, kind, authorId: m.attrs.authorId ?? null, authorName: m.attrs.authorName ?? null, at: m.attrs.at ?? null, from: pos, to: pos + node.nodeSize, text: node.text ?? '' })
    }
    return false
  })
  return [...byId.values()].sort((a, b) => a.from - b.from)
}

/** The text runs carrying a suggestion mark `id` (both kinds, unless one is given). */
function runsOf(doc: PMNode, id: string | null, kind?: SuggestionKind): Array<{ from: number; to: number; kind: SuggestionKind; mark: PMMark }> {
  const out: Array<{ from: number; to: number; kind: SuggestionKind; mark: PMMark }> = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.marks) {
      const k = m.type.name as SuggestionKind
      if ((k === 'insertion' || k === 'deletion') && (!kind || kind === k) && (id == null || m.attrs.id === id)) {
        out.push({ from: pos, to: pos + node.nodeSize, kind: k, mark: m })
      }
    }
    return false
  })
  return out
}

/**
 * Accept or reject one change (by id) or every change (id null). Accepting
 * keeps inserted words and removes deleted ones; rejecting does the reverse.
 * Returns the transaction, or null when there was nothing to decide.
 */
export function decideSuggestions(state: EditorState, id: string | null, decision: 'accept' | 'reject', into?: Transaction): Transaction | null {
  const tr = into ?? state.tr
  const runs = runsOf(tr.doc, id)
  if (!runs.length) return null
  // Right to left, so earlier positions stay where they are.
  for (const r of [...runs].sort((a, b) => b.from - a.from)) {
    const goes = (decision === 'accept') === (r.kind === 'deletion')
    if (goes) tr.delete(r.from, r.to)
    else tr.removeMark(r.from, r.to, r.mark)
  }
  return tr.setMeta(SKIP_TRACKING, true).setMeta('addToHistory', true)
}

/** The document's HTML as if every suggestion were accepted (analysis reads this). */
export function acceptedHtml(html: string): string {
  return html
    .replace(/<del\b[^>]*\bdata-change-id=[^>]*>[\s\S]*?<\/del>/gi, '')
    .replace(/<ins\b[^>]*\bdata-change-id=[^>]*>([\s\S]*?)<\/ins>/gi, '$1')
}

// ─── Tracking an edit ──────────────────────────────────────────────────────

/** A suggestion mark's id next to `pos` by the same author, to extend rather than start a new change. */
function neighbourId(doc: PMNode, pos: number, type: MarkType, authorId: string): string | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  for (const node of [$pos.nodeBefore, $pos.nodeAfter]) {
    const m = node?.isText ? node.marks.find(x => x.type === type && x.attrs.authorId === authorId) : null
    if (m?.attrs.id) return m.attrs.id as string
  }
  return null
}

/** The removed content to put back, marked deleted; words that were only suggested go for good. */
function markRemoved(fragment: Fragment, del: MarkType, ins: MarkType, attrs: Record<string, unknown>): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach(node => {
    if (node.isText) {
      if (ins.isInSet(node.marks)) return
      nodes.push(del.isInSet(node.marks) ? node : node.mark(del.create(attrs).addToSet(node.marks)))
    } else if (node.isInline) {
      // An atom (a hard break, an image) is kept: its removal isn't tracked.
      nodes.push(node)
    } else {
      nodes.push(node.copy(markRemoved(node.content, del, ins, attrs)))
    }
  })
  return Fragment.from(nodes)
}

const hasText = (f: Fragment) => { let t = false; f.descendants(n => { if (n.isText) t = true; return !t }); return t }

/**
 * Rewrite a user's edit as suggestions: what `tr` inserted gets an insertion
 * mark, what it removed comes back with a deletion mark. Returns the
 * transaction to append, or null to leave the edit as it is.
 */
export function trackEdit(tr: Transaction, oldState: EditorState, newState: EditorState, author: SuggestionAuthor, now = new Date()): Transaction | null {
  if (!tr.docChanged || tr.getMeta(SKIP_TRACKING) || tr.getMeta('history$') || tr.getMeta('y-sync$')) return null
  const ins = newState.schema.marks.insertion, del = newState.schema.marks.deletion
  if (!ins || !del) return null
  const out = newState.tr
  const at = now.toISOString()
  let deletedAt: { pos: number; size: number } | null = null
  let touched = false

  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep)) return
    const before = tr.docs[i]
    const { from, to } = step as unknown as { from: number; to: number }
    // Replacing the whole document is a load (setContent), not an edit.
    if (from === 0 && to === before.content.size) return
    const after = tr.mapping.slice(i + 1)
    const insFrom = out.mapping.map(after.map(from, -1), -1)
    const insTo = out.mapping.map(after.map(from + step.slice.size, 1), 1)

    if (step.slice.size > 0 && insTo > insFrom) {
      out.removeMark(insFrom, insTo, del)
      const id = neighbourId(out.doc, insFrom, ins, author.id) ?? neighbourId(out.doc, insTo, ins, author.id) ?? newChangeId()
      out.addMark(insFrom, insTo, ins.create({ id, authorId: author.id, authorName: author.name, at }))
      touched = true
    }
    if (to > from) {
      const removed = before.slice(from, to)
      if (!hasText(removed.content)) return
      const id = neighbourId(out.doc, insFrom, del, author.id) ?? newChangeId()
      const content = markRemoved(removed.content, del, ins, { id, authorId: author.id, authorName: author.name, at })
      if (!hasText(content)) { touched = true; return }
      const slice = new Slice(content, removed.openStart, removed.openEnd)
      const sizeBefore = out.doc.content.size
      out.replace(insFrom, insFrom, slice)
      deletedAt = { pos: insFrom, size: out.doc.content.size - sizeBefore }
      touched = true
    }
  })
  if (!touched) return null

  // A deletion with the caret: Backspace leaves it before the words marked
  // deleted (so the next Backspace goes on leftwards), Delete after them.
  const d = deletedAt as { pos: number; size: number } | null
  if (d && newState.selection.empty && tr.steps.every(s => s instanceof ReplaceStep && s.slice.size === 0)) {
    const backspace = oldState.selection.empty ? oldState.selection.from > d.pos : false
    const pos = backspace || !oldState.selection.empty ? d.pos : d.pos + d.size
    out.setSelection(TextSelection.create(out.doc, Math.min(pos, out.doc.content.size)))
  }
  return out.setMeta(SKIP_TRACKING, true)
}

// ─── The extension ─────────────────────────────────────────────────────────

/** Whether a suggestion's author is the person picked in "Document discussion". */
export function isByPerson(authorId: string | null | undefined, person: string | null): boolean {
  if (!person || !authorId) return false
  return person === 'portal' ? authorId.startsWith('portal:') : authorId === person
}

interface FocusState { person: string | null; only: boolean; set: DecorationSet }
const focusKey = new PluginKey<FocusState>('suggestionFocus')

function focusDecorations(doc: PMNode, person: string | null): DecorationSet {
  if (!person) return DecorationSet.empty
  const decos = suggestionsIn(doc).filter(s => isByPerson(s.authorId, person))
    .map(s => Decoration.inline(s.from, s.to, { class: 'suggestion--focus' }))
  return DecorationSet.create(doc, decos)
}

export interface TrackChangesStorage {
  enabled: boolean
  author: SuggestionAuthor | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      /** Turn suggestion mode on or off, as `author`. */
      setSuggesting: (enabled: boolean, author?: SuggestionAuthor | null) => ReturnType
      acceptSuggestion: (id: string) => ReturnType
      rejectSuggestion: (id: string) => ReturnType
      acceptAllSuggestions: () => ReturnType
      rejectAllSuggestions: () => ReturnType
      /** Highlight one person's suggestions (null: nobody's); `only` mutes everyone else's. */
      setSuggestionFocus: (person: string | null, only?: boolean) => ReturnType
    }
  }
  interface Storage {
    trackChanges: TrackChangesStorage
  }
}

export const TrackChanges = Extension.create<Record<string, never>, TrackChangesStorage>({
  name: 'trackChanges',

  addStorage() {
    return { enabled: false, author: null }
  },

  addExtensions() {
    return [Insertion, Deletion]
  },

  addCommands() {
    // TipTap dispatches the command's own `tr`: the decision is made in it.
    const decide = (id: string | null, d: 'accept' | 'reject') => ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: unknown }) => {
      if (!dispatch) return runsOf(tr.doc, id).length > 0
      return decideSuggestions(state, id, d, tr) !== null
    }
    return {
      setSuggesting: (enabled, author) => () => {
        this.storage.enabled = enabled
        if (author !== undefined) this.storage.author = author
        return true
      },
      acceptSuggestion: id => decide(id, 'accept'),
      rejectSuggestion: id => decide(id, 'reject'),
      acceptAllSuggestions: () => decide(null, 'accept'),
      rejectAllSuggestions: () => decide(null, 'reject'),
      setSuggestionFocus: (person, only = false) => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(focusKey, { person, only }).setMeta(SKIP_TRACKING, true).setMeta('addToHistory', false)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin({
        key: new PluginKey('trackChanges'),
        appendTransaction(transactions, oldState, newState) {
          if (!storage.enabled || !storage.author) return null
          // One user edit at a time (TipTap dispatches them so); anything
          // appended by another plugin is left alone.
          const edits = transactions.filter(t => t.docChanged && !t.getMeta('appendedTransaction'))
          if (edits.length !== 1 || transactions.length !== 1) return null
          return trackEdit(edits[0], oldState, newState, storage.author)
        },
      }),
      new Plugin({
        key: focusKey,
        state: {
          init: (): FocusState => ({ person: null, only: false, set: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(focusKey) as { person: string | null; only: boolean } | undefined
            if (meta === undefined && !tr.docChanged) return prev
            const { person, only } = meta ?? prev
            return { person, only: only && !!person, set: focusDecorations(tr.doc, person) }
          },
        },
        props: {
          decorations: state => focusKey.getState(state)?.set,
          // "Only this person": everyone else's suggestions lose their colours (contract-paper.css).
          attributes: (state): Record<string, string> => (focusKey.getState(state)?.only ? { class: 'suggestions-only' } : {}),
        },
      }),
    ]
  },
})
