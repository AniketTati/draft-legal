/**
 * SelectionMenu (docs/39 C1) — what a reader can do with words they select
 * in the document, without leaving it.
 *
 * The canvas offered a menu only while editing (bold, italic, ask AI), so a
 * reader who found the right value in the contract had to go and type it
 * into a field by hand. This menu appears over a selection in view mode; the
 * edit-mode bubble menu carries the same actions. PdfSelectionMenu puts it
 * over a selection in the original PDF too (pdf-selection.ts).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { BookmarkPlus, ListPlus, Tags, TextCursorInput } from 'lucide-react'
import { occurrenceAt, viewOf } from './SourceHighlight'
import { pdfSelectionOf } from './pdf-selection'

export interface TextSelection {
  /** The selected words, spaces collapsed. */
  text: string
  /** Which of the passages worded like this one the reader picked (0 = the first). */
  occurrence: number
  /** The words just before and after it: what a new field might be called (C3). */
  before?: string
  after?: string
  /** Where the selection is on screen, to place what opens from it. */
  rect: { top: number; bottom: number; left: number; right: number }
}

/** The longest passage a highlight can carry (the API keeps a 4,000-character quote). */
const MAX_SELECTION = 4000
/** Wording worth keeping in the library is a sentence, not a few words (E4). */
const MIN_WORDING = 40

/** The editor's selection as a highlight: its words, which of their kind, and where it is. */
export function selectionOf(editor: Editor): TextSelection | null {
  const view = viewOf(editor)
  if (!view) return null
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const text = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
  if (text.length < 2 || text.length > MAX_SELECTION) return null
  // The browser's box for the selection spans every line of it; the editor's
  // coordinates are the fallback when the DOM selection is elsewhere.
  const dom = window.getSelection()
  const range = dom && dom.rangeCount ? dom.getRangeAt(0) : null
  let rect: TextSelection['rect']
  if (range && !range.collapsed && view.dom.contains(range.commonAncestorContainer)) {
    const r = range.getBoundingClientRect()
    rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  } else {
    const a = view.coordsAtPos(from)
    const b = view.coordsAtPos(to)
    rect = { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) }
  }
  const size = editor.state.doc.content.size
  return {
    text,
    occurrence: occurrenceAt(editor, from, text),
    rect,
    before: editor.state.doc.textBetween(Math.max(0, from - 120), from, ' '),
    after: editor.state.doc.textBetween(to, Math.min(size, to + 120), ' '),
  }
}

/** What can be done with a selection: absent, an action someone may not take. */
export interface SelectionActionsProps {
  /** "Set as field value" (C2); absent for someone who can't edit fields. */
  onSetField?: (selection: TextSelection) => void
  /** "New field" (C3): add one, or suggest it to someone who can. */
  onNewField?: (selection: TextSelection) => void
  /** "Tag as clause" (E1); absent for someone who can't edit the contract. */
  onTagClause?: (selection: TextSelection) => void
  /** "Save to library" (E4); absent for someone who can't add clauses. */
  onSaveToLibrary?: (selection: TextSelection) => void
}

export function SelectionMenu({ editor, enabled, ...actions }: SelectionActionsProps & {
  editor: Editor | null
  /** Off while editing: the bubble menu carries the same actions there. */
  enabled: boolean
}) {
  const [sel, setSel] = useState<TextSelection | null>(null)
  const dragging = useRef(false)
  const anyAction = !!(actions.onSetField || actions.onNewField || actions.onTagClause || actions.onSaveToLibrary)

  useEffect(() => {
    setSel(null)
    const view = viewOf(editor)
    if (!editor || !view || !enabled || !anyAction) return
    const dom = view.dom
    const read = () => setSel(dragging.current ? null : selectionOf(editor))
    const down = () => { dragging.current = true; setSel(null) }
    // The editor takes the selection from the browser just after the mouse is released.
    const up = () => { if (dragging.current) { dragging.current = false; setTimeout(read, 0) } }
    // A click elsewhere moves the browser's selection out of the document; the editor keeps its own.
    const moved = () => {
      const s = window.getSelection()
      const inside = !!s && s.rangeCount > 0 && !s.isCollapsed && dom.contains(s.getRangeAt(0).commonAncestorContainer)
      if (!inside && !dragging.current) setSel(null)
    }
    const follow = () => setSel(s => (s ? selectionOf(editor) : s))
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    editor.on('selectionUpdate', read)
    dom.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    document.addEventListener('selectionchange', moved)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('keydown', esc)
    return () => {
      editor.off('selectionUpdate', read)
      dom.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
      document.removeEventListener('selectionchange', moved)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('keydown', esc)
    }
  }, [editor, enabled, anyAction])

  if (!sel || !anyAction) return null
  return <SelectionActions sel={sel} onDone={() => setSel(null)} {...actions} />
}

/**
 * docs/39 C1 — the same menu over the original PDF: the browser's selection
 * in its text layer, read as a highlight (pdf-selection.ts). `pageTexts`
 * holds each page's text once pdf.js has read it, to tell which of the
 * passages worded alike was picked.
 */
export function PdfSelectionMenu({ container, pageTexts, enabled, ...actions }: SelectionActionsProps & {
  container: HTMLElement | null
  pageTexts: React.MutableRefObject<string[] | null>
  enabled: boolean
}) {
  const [sel, setSel] = useState<TextSelection | null>(null)
  const dragging = useRef(false)
  const anyAction = !!(actions.onSetField || actions.onNewField || actions.onTagClause || actions.onSaveToLibrary)

  useEffect(() => {
    setSel(null)
    if (!container || !enabled || !anyAction) return
    const read = () => setSel(pdfSelectionOf(container, pageTexts.current))
    const down = (e: MouseEvent) => { if (container.contains(e.target as Node)) { dragging.current = true; setSel(null) } }
    // The browser settles the selection just after the mouse is released.
    const up = () => { if (dragging.current) { dragging.current = false; setTimeout(read, 0) } }
    const moved = () => {
      const s = window.getSelection()
      const inside = !!s && s.rangeCount > 0 && !s.isCollapsed && container.contains(s.getRangeAt(0).commonAncestorContainer)
      if (!inside && !dragging.current) setSel(null)
    }
    // The PDF scrolls in its own pane: the menu follows the words.
    const follow = () => setSel(s => (s ? pdfSelectionOf(container, pageTexts.current) : s))
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    document.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    document.addEventListener('selectionchange', moved)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
      document.removeEventListener('selectionchange', moved)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('keydown', esc)
    }
  }, [container, enabled, anyAction, pageTexts])

  if (!sel || !anyAction) return null
  return <SelectionActions sel={sel} onDone={() => setSel(null)} {...actions} />
}

/** The toolbar over a selection, wherever it was made. */
function SelectionActions({ sel, onDone, onSetField, onNewField, onTagClause, onSaveToLibrary }: SelectionActionsProps & {
  sel: TextSelection
  onDone: () => void
}) {
  const saveWording = onSaveToLibrary && sel.text.length >= MIN_WORDING ? onSaveToLibrary : undefined
  const act = (fn: ((s: TextSelection) => void) | undefined) => (e: React.MouseEvent | React.KeyboardEvent) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    fn?.(sel)
    onDone()
  }
  // Above the selection, or below it when it is at the top of the screen.
  const above = sel.rect.top > 56
  const left = Math.min(Math.max((sel.rect.left + sel.rect.right) / 2, 110), window.innerWidth - 110)
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selected text"
      data-testid="selection-menu"
      className="fixed z-50 inline-flex items-center gap-0.5 rounded-md border border-paper-200 bg-popover p-1 shadow-e2"
      style={{ left, top: above ? sel.rect.top - 8 : sel.rect.bottom + 8, transform: `translate(-50%, ${above ? '-100%' : '0'})` }}
    >
      {onSetField && (
        <button
          type="button"
          // Mouse-down, and no default: a click would first clear the selection it acts on.
          onMouseDown={act(onSetField)}
          onKeyDown={act(onSetField)}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-chip text-[12px] font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-950"
          data-testid="selection-set-field"
        >
          <TextCursorInput className="size-3.5" /> Set as field value
        </button>
      )}
      {onSetField && onNewField && <span className="mx-0.5 h-5 w-px bg-paper-200" aria-hidden />}
      {onNewField && (
        <button
          type="button"
          onMouseDown={act(onNewField)}
          onKeyDown={act(onNewField)}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-chip text-[12px] font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-950"
          data-testid="selection-new-field"
        >
          <ListPlus className="size-3.5" /> New field
        </button>
      )}
      {onTagClause && (onSetField || onNewField) && <span className="mx-0.5 h-5 w-px bg-paper-200" aria-hidden />}
      {onTagClause && (
        <button
          type="button"
          onMouseDown={act(onTagClause)}
          onKeyDown={act(onTagClause)}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-chip text-[12px] font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-950"
          data-testid="selection-tag-clause"
        >
          <Tags className="size-3.5" /> Tag as clause
        </button>
      )}
      {saveWording && (onSetField || onNewField || onTagClause) && <span className="mx-0.5 h-5 w-px bg-paper-200" aria-hidden />}
      {saveWording && (
        <button
          type="button"
          onMouseDown={act(saveWording)}
          onKeyDown={act(saveWording)}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-chip text-[12px] font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-950"
          data-testid="selection-save-to-library"
          title="Save this wording to the clause library"
        >
          <BookmarkPlus className="size-3.5" /> Save to library
        </button>
      )}
    </div>,
    document.body,
  )
}
