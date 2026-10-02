/**
 * DocumentCanvas — the primary document view on the contract detail page.
 *
 * Renders the contract as styled "paper" via TipTap, independent of whether
 * the user is viewing or editing. Same rendering, toggleable `editable`
 * prop flips behavior. Replaces the former PDF-viewer-only main area.
 *
 * B.5.1 — first slice: view-only, read-only default, contract-paper CSS.
 * B.5.2 — dual-view toggle adds an alternate render path to the original PDF.
 * B.5.3 — edit toggle flips `editable` on this same component.
 * B.5.8 — bubble menu + slash commands attach here in edit mode.
 */
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TextAlign from '@tiptap/extension-text-align'
import {
  AlertTriangle, Loader2, FileWarning,
  Bold, Italic, Underline as UnderlineIcon, Heading2, Sparkles, TextCursorInput,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { editedHtml } from '@/lib/canvas-update'
import { Button } from '@/components/ui/button'
import {
  RiskHighlights,
  updateRiskHighlights,
  type RiskClause,
  type RiskView,
} from './RiskDecorations'
import GhostCompletion from '../editor/GhostCompletion'
import ClauseClassifier from '../editor/ClauseClassifier'
import { MARGIN_CLASSIFIER_ENABLED } from '@/lib/feature-flags'
import DefinedTermGuard from '../editor/DefinedTermGuard'
import { SourceHighlight } from './SourceHighlight'
import { Variable } from '../editor/VariableMark'
import { TrackChanges, suggestionsIn, type SuggestionAuthor } from '../editor/TrackChanges'
import { SuggestionPopover, type OpenSuggestion } from './SuggestionPopover'
import { selectionIcon, selectionItems, selectionOf, type SelectionActionsProps, type TextSelection } from './SelectionMenu'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Pre-process HTML content before feeding to TipTap.
// Some upstream extractions emit bare text (no tags) — wrap in <p>.
// Others emit giant <pre> blocks that we want to interpret as paragraphs.
function normalizeHtml(html: string): string {
  const trimmed = (html ?? '').trim()
  if (!trimmed) return ''
  // No tags at all → assume plain text; split on blank lines into paragraphs.
  if (!/<[a-z][\s\S]*?>/i.test(trimmed)) {
    return trimmed
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('')
  }
  return trimmed
}

export type CanvasState =
  | { kind: 'loading' }
  | { kind: 'analysis_failed'; reason?: string; onReanalyze?: () => void }
  | { kind: 'empty' }
  | { kind: 'ready'; html: string }

export function DocumentCanvas({
  state,
  editable = false,
  onChange,
  onReady,
  riskClauses,
  riskView = 'full',
  riskTone,
  onRiskClick,
  onAiAction,
  onSetField,
  onVariableClick,
  selectionActions,
  suggesting = false,
  suggestionAuthor = null,
  className,
}: {
  state: CanvasState
  editable?: boolean
  onChange?: (html: string) => void
  /** Fires once the TipTap editor instance is mounted. Parent uses this
   *  to drive imperative actions (undo/redo, focus, scroll-to-clause). */
  onReady?: (editor: Editor) => void
  /** Clauses to mark inline (red for risk, blue for deviation). */
  riskClauses?: RiskClause[]
  riskView?: RiskView
  /** B.5.10 — Recolor the risk markers for a different persona context.
   *  Default (undefined) = red-for-risk / blue-for-deviation (Legal).
   *  'amber' = amber-for-risk / blue-for-deviation (Approver Mode). */
  riskTone?: 'amber'
  /** Called when the user clicks an inline risk marker. Used by B.5.6 to
   *  open the Focused Review drawer. */
  onRiskClick?: (clauseId: string, kind: 'risk' | 'deviation') => void
  /** Called when the user clicks the ✨ AI button in the bubble menu.
   *  B.5.8 stubs this; B.5.9 wires it to the ⌘K command palette. */
  onAiAction?: (selectedText: string) => void
  /** docs/39 C1 — "Set as field value" for the selection; absent for someone
   *  who can't edit fields. View mode has the same action in SelectionMenu. */
  onSetField?: (selection: TextSelection) => void
  /** docs/39 H2 — a draft's variable clicked while reading: the Variables panel shows it. */
  onVariableClick?: (key: string) => void
  /** docs/41 Part 16 — the selection menu's actions while editing (Comment ·
   *  Ask AI · Tag clause · Make variable · Request exception …). When given,
   *  they replace the bubble's own Set-field and Ask-AI buttons. */
  selectionActions?: SelectionActionsProps
  /** docs/41 Part 16 (C4) — edits become suggestions by `suggestionAuthor`
   *  (tracked changes) rather than changing the words outright. */
  suggesting?: boolean
  suggestionAuthor?: SuggestionAuthor | null
  className?: string
}) {
  const html = state.kind === 'ready' ? normalizeHtml(state.html) : ''

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        Underline,
        Typography,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({
          placeholder: editable
            ? 'Start typing, or press ⌘K to ask AI to draft a clause…'
            : '',
          emptyEditorClass: 'is-editor-empty',
        }),
        RiskHighlights, // B.5.5 — renders red/blue decorations per riskClauses
        SourceHighlight, // docs/39 B2 — "show in document" for a field's value
        Variable, // docs/39 H2 — a draft's terms stay marked with their variable
        TrackChanges, // docs/41 C4 — suggestions (<ins>/<del>) and suggestion mode
        // P6.1 — Ghost-text completion. Only fires when editable=true.
        GhostCompletion.configure({
          contractType: 'general commercial',
          enabled:      editable,
          debounceMs:   800,
        }),
        // P6.2 — Background clause classifier. Margin badges computed
        // live per paragraph. docs/41 P0.5 — off unless the build turns it
        // on: its "market" verdicts had no grounding (lib/feature-flags.ts).
        ClauseClassifier.configure({
          contractType: 'general commercial',
          enabled:      MARGIN_CLASSIFIER_ENABLED,
          debounceMs:   1500,
          maxParagraphsPerDoc: 12,
        }),
        // P6.4 — Defined-term guard. Pure client-side lexicon watcher.
        DefinedTermGuard.configure({ enabled: true, debounceMs: 600 }),
      ],
      content: html,
      editable,
      // X47 — only an update that changed the document is an edit (lib/canvas-update).
      onUpdate: (update) => {
        const edited = editedHtml(update)
        if (edited !== null) onChange?.(edited)
      },
    },
    // Re-created when the document changes while it's read, and when editing
    // starts or stops. Not while editing: the editor holds the document then,
    // and every version it saves comes back from the server. Re-creating it
    // for that dropped the caret five seconds after typing stopped, and the
    // words typed next went nowhere.
    [editable ? 'editing' : state.kind === 'ready' ? html : state.kind, editable],
  )

  // Push risk data into the plugin whenever it changes. Uses the meta
  // dispatch path so the editor doesn't remount.
  useEffect(() => {
    if (!editor) return
    updateRiskHighlights(editor, {
      clauses: riskClauses ?? [],
      riskView,
    })
  }, [editor, riskClauses, riskView])

  // Stable ref to the scroll container so risk-click handlers (B.5.5) can
  // scroll a specific clause into view without prop-drilling.
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Sync editable prop changes without remounting. X47 — without emitting
  // TipTap's default `update`, which the page took for an edit and saved.
  useEffect(() => {
    editor?.setEditable(editable, false)
  }, [editable, editor])

  // C4 — suggestion mode follows the prop; only an editor that edits suggests.
  useEffect(() => {
    if (!editor) return
    editor.commands.setSuggesting(suggesting && editable && !!suggestionAuthor, suggestionAuthor)
  }, [editor, suggesting, editable, suggestionAuthor])

  // C4 — the suggestion clicked, shown with Accept / Reject.
  const [openSuggestion, setOpenSuggestion] = useState<OpenSuggestion | null>(null)

  // Expose the editor to the parent once it's ready (for undo/redo etc.)
  useEffect(() => {
    if (editor && onReady) onReady(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Non-ready states render before the editor so we don't flash an empty
  // canvas during analysis.
  if (state.kind === 'loading') {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full bg-paper-50', className)}>
        <Loader2 className="size-6 text-ink-400 animate-spin mb-3" />
        <p className="text-body text-ink-500">Preparing document…</p>
      </div>
    )
  }

  if (state.kind === 'analysis_failed') {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full bg-paper-50', className)}>
        {/* A document that never got extracted is the same event the repository
            row calls Failed, so it wears risk here too rather than amber. */}
        <div className="max-w-md mx-auto text-center bg-card rounded-card border border-risk-200 shadow-e1 p-8">
          <FileWarning className="size-6 text-risk-600 mx-auto mb-3" />
          <p className="text-body font-semibold text-ink-950">Document extraction failed</p>
          {state.reason && (
            <p className="text-dense text-ink-500 mt-2 leading-relaxed">{state.reason}</p>
          )}
          <p className="text-dense text-ink-500 mt-3">
            The contract is still uploaded — you can view the original PDF from <span className="font-medium">Actions</span>,
            or retry analysis.
          </p>
          {state.onReanalyze && (
            <Button onClick={state.onReanalyze} className="mt-4">
              Retry analysis
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (state.kind === 'empty') {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full bg-paper-50', className)}>
        <div className="text-center">
          <AlertTriangle className="size-6 text-ink-400 mx-auto mb-3" />
          <p className="text-body text-ink-500">No content yet.</p>
          <p className="text-dense text-ink-400 mt-1">Upload a PDF or draft from a template.</p>
        </div>
      </div>
    )
  }

  // READY — the TipTap render. The document-canvas wrapper scopes paper CSS.
  // Click handler on the wrapper catches risk-marker clicks (event delegation).
  const onClickDocument = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const marker = onRiskClick ? target.closest('.risk-marker') as HTMLElement | null : null
    if (marker) {
      const clauseId = marker.dataset.clauseId
      const kind = marker.dataset.riskKind as 'risk' | 'deviation' | undefined
      if (clauseId && kind) {
        e.stopPropagation()
        onRiskClick!(clauseId, kind)
      }
      return
    }
    // C4 — a click on a suggestion (not the end of a selection) opens it.
    const sugg = editor && (window.getSelection()?.isCollapsed ?? true) ? target.closest('.suggestion[data-change-id]') as HTMLElement | null : null
    if (sugg) {
      const id = sugg.dataset.changeId!
      const kind = sugg.tagName === 'INS' ? 'insertion' : 'deletion'
      const found = suggestionsIn(editor!.state.doc).find(c => c.id === id && c.kind === kind)
      const r = sugg.getBoundingClientRect()
      if (found) setOpenSuggestion({ id, kind, authorName: found.authorName, at: found.at, text: found.text, rect: { left: r.left, bottom: r.bottom } })
      return
    }
    // docs/39 H2 — a click on a variable, not the end of a selection made across it.
    const variable = !editable && onVariableClick ? target.closest('[data-variable]') as HTMLElement | null : null
    if (variable?.dataset.variable && (window.getSelection()?.isCollapsed ?? true)) onVariableClick!(variable.dataset.variable)
  }

  // B.5.17 a11y — Enter/Space on a focused risk marker fires the same
  // handler as a click. Markers get role="button" + tabindex="0" from
  // the RiskHighlights plugin.
  const onKeyDownDocument = (e: React.KeyboardEvent) => {
    if (!onRiskClick) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    const target = e.target as HTMLElement
    const marker = target.closest('.risk-marker') as HTMLElement | null
    if (!marker) return
    const clauseId = marker.dataset.clauseId
    const kind = marker.dataset.riskKind as 'risk' | 'deviation' | undefined
    if (clauseId && kind) {
      e.preventDefault()
      onRiskClick(clauseId, kind)
    }
  }

  return (
    <div
      ref={scrollRef}
      className={cn('h-full overflow-auto bg-paper-50', className)}
      onClick={onClickDocument}
      onKeyDown={onKeyDownDocument}
    >
      <article
        className={cn(
          'document-canvas',
          riskTone === 'amber' && 'document-canvas--tone-amber',
          !editable && 'document-canvas--reading',
          // The page is the one surface allowed a drop shadow on paper.
          'mx-auto my-8 bg-card',
          'shadow-page',
          'rounded-paper',
          'w-[min(820px,calc(100%-3rem))]',
          'min-h-[1056px]', // 11in @ 96dpi — simulated page
          'px-[2.5cm] py-[2cm]',
          editable ? 'cursor-text' : 'cursor-default',
        )}
      >
        <EditorContent editor={editor} />
      </article>
      {openSuggestion && editor && (
        <SuggestionPopover
          change={openSuggestion}
          canDecide={editable}
          onAccept={id => { editor.commands.acceptSuggestion(id); setOpenSuggestion(null) }}
          onReject={id => { editor.commands.rejectSuggestion(id); setOpenSuggestion(null) }}
          onClose={() => setOpenSuggestion(null)}
        />
      )}

      {/*
        B.5.8 — Floating bubble menu on text selection. Only active when
        editable=true. Six buttons: Bold / Italic / Underline / Link /
        H2 / ✨ AI. The AI button calls onAiAction which B.5.9 wires to
        the ⌘K command palette.
      */}
      {editor && editable && (
        <BubbleMenu
          editor={editor}
          updateDelay={100}
          className="inline-flex items-center gap-0.5 rounded-md border border-paper-200 bg-popover p-1 shadow-e2"
        >
          <MenuButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold (⌘B)"
          >
            <Bold className="size-3.5" strokeWidth={2.5} />
          </MenuButton>
          <MenuButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic (⌘I)"
          >
            <Italic className="size-3.5" />
          </MenuButton>
          <MenuButton
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Underline (⌘U)"
          >
            <UnderlineIcon className="size-3.5" />
          </MenuButton>
          <MenuSeparator />
          <MenuButton
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Heading 2"
          >
            <Heading2 className="size-3.5" />
          </MenuButton>
          {selectionActions ? (
            <BubbleSelectionItems editor={editor} actions={selectionActions} />
          ) : (
            <>
          {onSetField && (
              <>
                <MenuSeparator />
                <MenuButton
                  onClick={() => { const sel = selectionOf(editor); if (sel) onSetField(sel) }}
                  title="Set as field value"
                  aria-label="Set as field value"
                  data-testid="bubble-menu-set-field"
                >
                  <TextCursorInput className="size-3.5" />
                </MenuButton>
              </>
            )}
            <MenuSeparator />
            <MenuButton
              onClick={() => {
                const { from, to } = editor.state.selection
                const selected = editor.state.doc.textBetween(from, to, '\n')
                onAiAction?.(selected)
              }}
              // U.2.2 / decision 14a — icon-only ✨, indigo accent.
              title="Ask about this selection · ⌘K"
              className="text-assist-600 hover:bg-assist-50"
              data-testid="bubble-menu-ai-btn"
              aria-label="Ask AI about this selection"
            >
              <Sparkles className="size-3.5" />
            </MenuButton>
            </>
          )}
        </BubbleMenu>
      )}
    </div>
  )
}

function MenuButton({
  active,
  onClick,
  title,
  className,
  children,
  ...rest
}: {
  active?: boolean
  onClick: () => void
  title: string
  className?: string
  children: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      title={title}
      aria-pressed={active}
      {...rest}
      className={cn(
        'inline-flex items-center justify-center size-7 rounded-chip transition-colors',
        active
          ? 'bg-paper-100 text-ink-950'
          : 'text-ink-700 hover:bg-paper-100 hover:text-ink-950',
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * The selection's actions in the bubble menu, re-read as the selection moves
 * (whether Request exception applies depends on where the words are).
 */
function BubbleSelectionItems({ editor, actions }: { editor: Editor; actions: SelectionActionsProps }) {
  useEditorState({ editor, selector: ({ editor: e }) => `${e.state.selection.from}:${e.state.selection.to}` })
  const sel = selectionOf(editor)
  if (!sel) return null
  return (
    <>
      {selectionItems(sel, actions).map(it => {
        const Icon = selectionIcon(it.id)
        return (
          <span key={it.id} className="inline-flex items-center">
            <MenuSeparator />
            <MenuButton
              onClick={() => { const now = selectionOf(editor); if (now) it.run(now) }}
              title={it.title ?? it.label}
              aria-label={it.label}
              className={it.id === 'ask-ai' ? 'text-assist-600 hover:bg-assist-50' : undefined}
              data-testid={`bubble-menu-${it.id}`}
            >
              <Icon className="size-3.5" />
            </MenuButton>
          </span>
        )
      })}
    </>
  )
}

function MenuSeparator() {
  return <div className="mx-0.5 h-5 w-px bg-paper-200" aria-hidden />
}
