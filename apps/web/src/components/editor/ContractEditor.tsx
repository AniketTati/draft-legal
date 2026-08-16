/**
 * Contract Editor — Phase 4.3 (SCR-006)
 *
 * TipTap rich text editor with:
 *  - Formatting toolbar (H1/H2/H3, bold, italic, underline, table, lists)
 *  - Variable fields (highlighted, unfilled shown in amber)
 *  - Section navigation sidebar (from H2/H3 headings)
 *  - Clause library side panel (search + insert at cursor)
 *  - AI Assist context menu (select text → rewrite/simplify/expand/check_compliance)
 *  - Track changes toggle (show/hide added/deleted marks)
 *  - Find and replace
 *  - Export buttons (DOCX via Gotenberg, PDF)
 *  - Word count + version indicator
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DOMSerializer } from '@tiptap/pm/model'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import CharacterCount from '@tiptap/extension-character-count'
import Typography from '@tiptap/extension-typography'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import GhostCompletion from './GhostCompletion'
import {
  Bold, Italic, UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3,
  List, ListOrdered, AlignLeft, AlignCenter, AlignRight,
  Table as TableIcon, Undo, Redo,
  Download, Search, X, ChevronRight,
  Wand2, BookOpen, FileText, Loader2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Eyebrow } from '@/components/ui/primitives'
import { AssistMark } from '@/components/ui/assist'
import { MEANING_CLASS, type Meaning } from '@/lib/status'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContractEditorProps {
  initialContent?: string
  contractType?: string
  onSave?: (html: string) => void
  onChange?: (html: string) => void
  onExport?: (format: 'pdf' | 'docx') => void
  readOnly?: boolean
}

interface ClauseItem {
  id: string
  title: string
  content: string
  category?: { name: string }
  riskRating?: string
}

interface AssistAction {
  label: string
  action: 'rewrite' | 'simplify' | 'expand' | 'check_compliance' | 'suggest_alternative'
}

const ASSIST_ACTIONS: AssistAction[] = [
  { label: '✏️ Rewrite', action: 'rewrite' },
  { label: '🧹 Simplify', action: 'simplify' },
  { label: '🔍 Expand', action: 'expand' },
  { label: '⚖️ Check Compliance', action: 'check_compliance' },
  { label: '🔄 Suggest Alternative', action: 'suggest_alternative' },
]

// ─── Toolbar Button ───────────────────────────────────────────────────────────

function ToolbarBtn({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      title={title}
      // Active is a pressed state, not a status — it stays in ink rather than
      // taking the blue it used to wear.
      className={cn(active && 'bg-paper-100 text-ink-950')}
    >
      {children}
    </Button>
  )
}

// ─── Section Outline ─────────────────────────────────────────────────────────

function SectionOutline({ html }: { html: string }) {
  const headings = html.match(/<h[23][^>]*>(.*?)<\/h[23]>/gi) ?? []
  const parsed = headings.map((h) => {
    const level = h.startsWith('<h2') ? 2 : 3
    const text = h
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    return { level, text }
  })

  if (!parsed.length) return null

  const scrollToHeading = (index: number) => {
    const els = document.querySelectorAll('.ProseMirror h2, .ProseMirror h3')
    els[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="w-52 shrink-0 border-r border-paper-200 bg-paper-50 overflow-y-auto p-3 hidden lg:block">
      <Eyebrow className="mb-2">Sections</Eyebrow>
      <nav className="space-y-0.5">
        {parsed.map((h, i) => (
          <div
            key={i}
            onClick={() => scrollToHeading(i)}
            className={cn(
              'text-dense text-ink-500 cursor-pointer hover:text-ink-950 truncate py-0.5',
              h.level === 3 && 'pl-3 text-[11.5px]',
            )}
          >
            {h.text}
          </div>
        ))}
      </nav>
    </div>
  )
}

// ─── Clause Library Panel ─────────────────────────────────────────────────────

/*
 * A clause's riskRating is a rating, not a lifecycle status, so it is not a key
 * in lib/status's STATUS map — but the color still comes from there, so a
 * "favorable" clause wears the same green as an executed contract, and
 * "standard" stays neutral because a house-standard clause carries no verdict.
 */
const CLAUSE_RISK_MEANING: Record<string, Meaning> = {
  favorable: 'binding',
  unfavorable: 'risk',
  neutral: 'neutral',
  standard: 'neutral',
}

function ClauseLibraryPanel({
  onInsert,
  onClose,
}: {
  onInsert: (html: string) => void
  onClose: () => void
}) {
  const [clauses, setClauses] = useState<ClauseItem[]>([])
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [loading, setLoading] = useState(false)

  // Debounce search — avoid API call on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 350)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    setLoading(true)
    api.get('/clauses', { params: { q: debouncedQ || undefined, limit: 30 } })
      .then(r => setClauses(r.data.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [debouncedQ])

  return (
    <div className="w-72 shrink-0 border-l border-paper-200 bg-card flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-paper-200">
        <div className="flex items-center gap-1.5 text-dense font-medium text-ink-700">
          <BookOpen className="size-3.5" />
          Clause Library
        </div>
        <Button onClick={onClose} variant="ghost" size="icon-xs" className="text-ink-400"><X /></Button>
      </div>
      <div className="px-3 py-2 border-b border-paper-200">
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search clauses..."
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-dense text-ink-400 p-3">Loading...</p>}
        {!loading && !clauses.length && (
          <p className="text-dense text-ink-400 p-3">No clauses found</p>
        )}
        {clauses.map(c => {
          const rating = MEANING_CLASS[CLAUSE_RISK_MEANING[c.riskRating ?? ''] ?? 'neutral']
          return (
            <div
              key={c.id}
              className="px-3 py-2 border-b border-paper-200 hover:bg-paper-100 cursor-pointer group"
              onClick={() => onInsert(c.content)}
            >
              <div className="flex items-start justify-between gap-1">
                <p className="text-dense font-medium text-ink-950 leading-snug">{c.title}</p>
                <ChevronRight className="size-3.5 text-paper-300 group-hover:text-ink-700 shrink-0 mt-0.5" />
              </div>
              {c.category?.name && (
                <p className="text-[11.5px] text-ink-400 mt-0.5">{c.category.name}</p>
              )}
              {c.riskRating && (
                <span className={cn(
                  'inline-block text-[11px] px-1.5 py-0.5 rounded-chip border mt-1',
                  rating.wash, rating.washFg, rating.washBorder,
                )}>
                  {c.riskRating}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Find & Replace Panel ─────────────────────────────────────────────────────

function FindReplacePanel({
  onFind,
  onReplace,
  onClose,
}: {
  onFind: (q: string) => void
  onReplace: (from: string, to: string) => void
  onClose: () => void
}) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')

  return (
    // Find & replace is a tool, not a state — nothing here is blocked on the
    // user, so the amber it used to wear was decoration and it goes neutral.
    <div className="flex items-center gap-2 px-3 py-1.5 bg-paper-50 border-b border-paper-200 text-dense">
      <Search className="size-4 text-ink-400" />
      <Input
        value={find}
        onChange={e => setFind(e.target.value)}
        placeholder="Find..."
        className="w-36"
      />
      <Input
        value={replace}
        onChange={e => setReplace(e.target.value)}
        placeholder="Replace..."
        className="w-36"
      />
      <Button
        onClick={() => onFind(find)}
        variant="outline"
        size="xs"
      >Find</Button>
      <Button
        onClick={() => onReplace(find, replace)}
        variant="outline"
        size="xs"
      >Replace All</Button>
      <Button onClick={onClose} variant="ghost" size="icon-xs" className="text-ink-400"><X /></Button>
    </div>
  )
}

// ─── Main Editor ──────────────────────────────────────────────────────────────

export function ContractEditor({
  initialContent = '',
  contractType = 'general commercial',
  onSave,
  onChange,
  onExport,
  readOnly = false,
}: ContractEditorProps) {
  const [showClausePanel, setShowClausePanel] = useState(false)
  const [showFindReplace, setShowFindReplace] = useState(false)
  const [assistLoading, setAssistLoading] = useState(false)
  const [assistResult, setAssistResult] = useState<{ revisedText: string; explanation: string } | null>(null)
  // L6 #1 — a failed export has to be visible. `if (!resp?.ok) return` is what
  // made six buttons look like they did nothing at all.
  const [exportError, setExportError] = useState<string | null>(null)
  const [assistOriginalText, setAssistOriginalText] = useState<string | null>(null)
  const [assistError, setAssistError] = useState<string | null>(null)
  // Store the exact selection range when the AI call was made so Apply always replaces the right text
  const assistSelectionRef = useRef<{ from: number; to: number } | null>(null)
  const [assistHint, setAssistHint] = useState(false)
  const [showDocAiMenu, setShowDocAiMenu] = useState(false)
  const [docAiLoading, setDocAiLoading] = useState<'fix_layout' | 'rewrite_document' | null>(null)
  const [docAiConfirm, setDocAiConfirm] = useState(false)
  const [docAiDone, setDocAiDone] = useState(false)   // true after Doc AI completes — prompts user to save
  const [wordCount, setWordCount] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      CharacterCount,
      Typography,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TextStyle,
      Color,
      // P6.1 — Ghost-text completion. Only fires in edit mode.
      GhostCompletion.configure({
        contractType: contractType ?? 'general commercial',
        enabled:      !readOnly,
        debounceMs:   800,
      }),
    ],
    content: initialContent,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      setWordCount(editor.storage.characterCount?.words() ?? 0)
      onChange?.(editor.getHTML())
    },
  })

  // Update content when prop changes
  useEffect(() => {
    if (editor && initialContent && editor.getHTML() !== initialContent) {
      editor.commands.setContent(initialContent)
    }
  }, [initialContent, editor])

  const insertClause = useCallback((html: string) => {
    if (!editor) return
    editor.chain().focus().insertContent(html).run()
    setShowClausePanel(false)
  }, [editor])

  const handleAssist = useCallback(async (action: AssistAction['action']) => {
    if (!editor) return
    const { from, to } = editor.state.selection
    if (from === to) {
      setAssistHint(true)
      setTimeout(() => setAssistHint(false), 2500)
      return
    }

    const selectedPlainText = editor.state.doc.textBetween(from, to, ' ')
    if (!selectedPlainText.trim()) return

    // Extract HTML of the selection so formatting (<strong>, <em>, etc.) is preserved
    const slice = editor.state.doc.slice(from, to)
    const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content)
    const tmpDiv = document.createElement('div')
    tmpDiv.appendChild(fragment)
    const selectedHtml = tmpDiv.innerHTML || selectedPlainText

    // Capture selection + original text now — Apply must replace THIS range, not wherever cursor is later
    assistSelectionRef.current = { from, to }
    setAssistOriginalText(selectedPlainText)   // plain text for readable diff display
    setAssistError(null)
    setAssistResult(null)
    setAssistLoading(true)
    try {
      const res = await api.post('/agent/assist', {
        selectedText: selectedHtml,            // HTML so AI preserves bold/italic etc.
        action,
        contractType,
      })
      setAssistResult(res.data)
    } catch {
      setAssistError('AI request failed — please try again.')
      setTimeout(() => setAssistError(null), 4000)
    } finally {
      setAssistLoading(false)
    }
  }, [editor, contractType])

  const handleDocumentAi = useCallback(async (action: 'fix_layout' | 'rewrite_document') => {
    if (!editor) return
    setDocAiLoading(action)
    setShowDocAiMenu(false)
    setDocAiConfirm(false)
    setDocAiDone(false)
    try {
      const res = await api.post('/agent/assist', {
        selectedText: editor.getHTML(),
        action,
        contractType,
      })
      if (res.data?.revisedText) {
        editor.commands.setContent(res.data.revisedText)
        setDocAiDone(true)   // prompt user to save
      }
    } catch {
      setAssistError('Doc AI failed — please try again.')
      setTimeout(() => setAssistError(null), 4000)
    } finally {
      setDocAiLoading(null)
    }
  }, [editor, contractType])

  const applyAssistResult = useCallback(() => {
    if (!editor || !assistResult) return
    // Use the range captured when the AI was called, not the current (potentially moved) cursor
    const range = assistSelectionRef.current ?? editor.state.selection

    editor.chain().focus().deleteRange(range).insertContent(assistResult.revisedText).run()

    // The cursor is now at the end of the inserted content; start is range.from
    const insertedFrom = range.from
    const insertedTo = editor.state.selection.from

    // Flash the inserted range in the assist wash (assist-200) + scroll into
    // view. It was a green highlight, but green means BINDING in this system
    // and machine-authored text is what this range actually is.
    if (insertedFrom < insertedTo) {
      editor.chain()
        .setTextSelection({ from: insertedFrom, to: insertedTo })
        .setHighlight({ color: '#C7D2FE' })
        .scrollIntoView()
        .run()

      // Remove highlight after animation completes
      setTimeout(() => {
        if (!editor.isDestroyed) {
          editor.chain()
            .setTextSelection({ from: insertedFrom, to: insertedTo })
            .unsetHighlight()
            .setTextSelection(insertedTo)
            .scrollIntoView()
            .run()
        }
      }, 1800)
    }

    setAssistResult(null)
    setAssistOriginalText(null)
    assistSelectionRef.current = null
  }, [editor, assistResult])

  // L6 #8 — Replace All over the DOCUMENT, not over its serialization.
  //
  // This used to run `editor.getHTML().replaceAll(find, replace)` and then
  // setContent the result, which is wrong in both directions. Replacing "p"
  // with "q" rewrote every <p> tag in the document, and searching for
  // "Smith & Co" never matched anything because the serialized HTML holds
  // "Smith &amp; Co". It silently corrupted the markup of any document it was
  // used on, and setContent also discarded the undo history.
  //
  // Walking text nodes means tag names and entities are simply not in scope.
  // Positions are collected first and applied back-to-front in ONE chained
  // transaction: replacing forwards shifts every later position by the length
  // delta, and one dispatch per match would make ctrl-Z undo them one at a
  // time.
  const handleFindReplace = useCallback((find: string, replace: string) => {
    if (!editor || !find) return

    const hits: { from: number; to: number }[] = []
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      let idx = node.text.indexOf(find)
      while (idx !== -1) {
        hits.push({ from: pos + idx, to: pos + idx + find.length })
        idx = node.text.indexOf(find, idx + find.length)
      }
    })
    if (hits.length === 0) return

    const chain = editor.chain().focus()
    for (const hit of hits.reverse()) {
      chain.insertContentAt({ from: hit.from, to: hit.to }, replace)
    }
    chain.run()
  }, [editor])

  const handleExport = useCallback(async (format: 'pdf' | 'docx') => {
    if (!editor) return
    if (onExport) {
      onExport(format)
      return
    }
    // L6 #1 — six dead buttons across three pages (Templates, Playbook,
    // Clauses), because `onExport` is optional and no mount site passes it, so
    // every click landed here.
    //
    // The bare `fetch` was the defect: middleware/auth.ts accepts only
    // `Authorization: Bearer`, there is no cookie fallback, and only the axios
    // client attaches the token — so this 401'd every single time. Then
    // `if (!resp?.ok) return` swallowed it, which is why the buttons appeared
    // to do nothing at all rather than to fail. CompareMode.tsx is the correct
    // pattern and its own comment already named this file as the anti-pattern.
    setExportError(null)
    try {
      const res = await api.post(
        '/contracts/export',
        { html: editor.getHTML(), format },
        { responseType: 'blob' },
      )
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `contract.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // Surface it. A silent return is indistinguishable from a broken app.
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err as Error)?.message ??
        'Export failed'
      setExportError(`Could not export as ${format.toUpperCase()}: ${detail}`)
    }
  }, [editor, onExport])

  if (!editor) return null

  const currentHtml = editor.getHTML()

  return (
    <div className="relative flex flex-col h-full bg-card border border-paper-200 rounded-card overflow-hidden">
      {exportError && (
        <div
          role="alert"
          data-testid="editor-export-error"
          className="flex items-start justify-between gap-3 px-3 py-2 text-dense bg-risk-50 border-b border-risk-200 text-risk-700"
        >
          <span className="min-w-0 break-words">{exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="shrink-0 text-risk-700 hover:text-risk-900 font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* ── Toolbar ── */}
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-paper-200 bg-paper-50">
        {/* History */}
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo"><Undo /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo"><Redo /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Headings */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1"><Heading1 /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2"><Heading2 /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3"><Heading3 /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Inline formatting */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold"><Bold /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic"><Italic /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline"><UnderlineIcon /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough"><Strikethrough /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Alignment */}
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Align Left"><AlignLeft /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Align Center"><AlignCenter /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Align Right"><AlignRight /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Lists */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List"><List /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Numbered List"><ListOrdered /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Table */}
        <ToolbarBtn onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert Table"><TableIcon /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Tools */}
        <ToolbarBtn onClick={() => setShowClausePanel(p => !p)} active={showClausePanel} title="Clause Library"><BookOpen /></ToolbarBtn>
        <ToolbarBtn onClick={() => setShowFindReplace(p => !p)} active={showFindReplace} title="Find & Replace"><Search /></ToolbarBtn>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* AI Assist — acts on selected text */}
        <div className="relative flex items-center gap-0.5 border border-assist-200 rounded-md px-1 bg-assist-50">
          {assistLoading
            ? <><Loader2 className="size-3.5 text-assist-600 animate-spin ml-1" /><span className="text-[11.5px] text-assist-700 px-1">Thinking…</span></>
            : <Wand2 className="size-3.5 text-assist-600 mr-0.5" />
          }
          {ASSIST_ACTIONS.map(a => (
            <Button
              key={a.action}
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => handleAssist(a.action)}
              disabled={assistLoading}
              title={`AI: ${a.label} (select text first)`}
              className="px-1.5 text-assist-700 hover:bg-assist-200 hover:text-assist-900 disabled:border-transparent disabled:bg-transparent disabled:text-assist-700 disabled:opacity-50"
            >
              {a.label}
            </Button>
          ))}
          {assistHint && (
            <div className="absolute top-full left-0 mt-1 z-10 px-2 py-1 bg-ink-950 text-white text-[11.5px] rounded-md shadow-e2 whitespace-nowrap">
              Select text first
            </div>
          )}
        </div>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Document AI — whole-document operations */}
        <div className="relative">
          {/* Blue read as "primary action" here, but this asks the machine to
              rewrite the document — that is assist, not ink. */}
          <Button
            type="button"
            variant="assistOutline"
            size="xs"
            onClick={() => setShowDocAiMenu(p => !p)}
            disabled={!!docAiLoading}
            title="Document AI"
            className="disabled:border-assist-200 disabled:bg-card disabled:text-assist-700 disabled:opacity-50"
          >
            {docAiLoading ? (
              <><Loader2 className="animate-spin" />{docAiLoading === 'fix_layout' ? 'Fixing…' : 'Rewriting…'}</>
            ) : (
              <><Wand2 />Doc AI ▾</>
            )}
          </Button>
          {showDocAiMenu && (
            <div className="absolute top-full left-0 mt-1 z-20 w-48 bg-card border border-paper-200 rounded-md shadow-e2 overflow-hidden">
              <button
                onClick={() => handleDocumentAi('fix_layout')}
                className="w-full text-left px-3 py-2.5 text-dense hover:bg-assist-50 text-ink-700"
              >
                ✨ Fix Layout
                <p className="text-[11px] text-ink-400 mt-0.5">Clean up PDF extraction artifacts</p>
              </button>
              <button
                onClick={() => { setShowDocAiMenu(false); setDocAiConfirm(true) }}
                className="w-full text-left px-3 py-2.5 text-dense hover:bg-assist-50 text-ink-700 border-t border-paper-200"
              >
                📝 Rewrite Document
                <p className="text-[11px] text-ink-400 mt-0.5">AI rewrites full document</p>
              </button>
            </div>
          )}
        </div>
        <div className="w-px h-5 bg-paper-300 mx-1" />

        {/* Export */}
        <ToolbarBtn onClick={() => handleExport('pdf')} title="Export PDF"><FileText /></ToolbarBtn>
        <ToolbarBtn onClick={() => handleExport('docx')} title="Export DOCX"><Download /></ToolbarBtn>

        {/* Save */}
        {onSave && !readOnly && (
          <Button
            size="xs"
            disabled={saveState === 'saving'}
            onClick={async () => {
              setSaveState('saving')
              try {
                await onSave(editor.getHTML())
                setSaveState('saved')
                setDocAiDone(false)
                setTimeout(() => setSaveState('idle'), 2500)
              } catch {
                setSaveState('error')
                setTimeout(() => setSaveState('idle'), 3000)
              }
            }}
            // The one ink primary in this view. "Saved!" stays ink — a
            // successful save is not BINDING, and the label already carries the
            // confirmation. Only the failure earns a meaning color.
            className={cn(
              'ml-auto',
              saveState === 'error' &&
                'border-risk-200 bg-risk-50 text-risk-700 hover:border-risk-200 hover:bg-risk-100',
            )}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved!' : saveState === 'error' ? 'Save failed' : 'Save Draft'}
          </Button>
        )}

        {/* Word count */}
        <span className="ml-2 text-[11.5px] text-ink-400 whitespace-nowrap tabular-nums">{wordCount} words</span>
      </div>

      {/* ── Find & Replace Bar ── */}
      {showFindReplace && (
        <FindReplacePanel
          onFind={(q) => { if (q) (window as any).find(q, false, false, true, false, true, false) }}
          onReplace={handleFindReplace}
          onClose={() => setShowFindReplace(false)}
        />
      )}

      {/* ── AI Error Banner ── */}
      {assistError && (
        <div className="px-4 py-2 bg-risk-50 border-b border-risk-200 flex items-center justify-between">
          <p className="text-dense text-risk-700">{assistError}</p>
          <button onClick={() => setAssistError(null)}><X className="size-3.5 text-risk-600 hover:text-risk-700" /></button>
        </div>
      )}

      {/* ── Doc AI Save Reminder ── */}
      {docAiDone && (
        // Attention, not assist: the machine is done and the save is now
        // blocked on the user.
        <div className="px-4 py-2 bg-attention-50 border-b border-attention-200 flex items-center justify-between gap-3">
          <p className="text-dense text-attention-700">Doc AI updated the document — click <strong>Save Draft</strong> to keep the changes.</p>
          <button onClick={() => setDocAiDone(false)}><X className="size-3.5 text-attention-600 hover:text-attention-700" /></button>
        </div>
      )}

      {/* ── AI Assist Result Banner ── */}
      {assistResult && (
        <div className="px-4 py-3 bg-assist-50 border-b border-assist-200">
          {/* Header row */}
          <div className="flex items-center justify-between mb-2">
            <p className="flex items-center gap-[7px] text-eyebrow uppercase text-assist-700"><AssistMark />AI Suggestion</p>
            <div className="flex gap-2 shrink-0">
              <Button
                onClick={applyAssistResult}
                variant="assist"
                size="xs"
              >Apply</Button>
              <Button
                onClick={() => { setAssistResult(null); setAssistOriginalText(null); assistSelectionRef.current = null }}
                variant="outline"
                size="xs"
              >Dismiss</Button>
            </div>
          </div>
          {/* Before / After diff. Not red/green: neither side is legal exposure
              or a binding fact. The struck-out original goes quiet in ink, and
              the proposed replacement takes the assist accent because that is
              exactly what it is — text the machine wrote. */}
          <div className="rounded-md border border-assist-200 bg-card overflow-hidden text-dense">
            {assistOriginalText && (
              <div className="flex gap-2 px-3 py-2 bg-paper-50 border-b border-paper-200">
                <span className="text-ink-400 font-bold shrink-0">−</span>
                <p className="text-ink-500 line-through leading-snug line-clamp-4">{assistOriginalText}</p>
              </div>
            )}
            <div className="flex gap-2 px-3 py-2">
              <span className="text-assist-600 font-bold shrink-0">+</span>
              <p className="text-assist-900 leading-snug line-clamp-5">{assistResult.revisedText}</p>
            </div>
          </div>
          {/* Explanation */}
          <p className="text-[11.5px] text-ink-500 mt-1.5 italic">{assistResult.explanation}</p>
        </div>
      )}

      {/* ── Main Area ── */}
      <div className="flex flex-1 min-h-0">
        {/* Section outline */}
        <SectionOutline html={currentHtml} />

        {/* Editor canvas */}
        <div className="flex-1 overflow-y-auto">
          <EditorContent
            editor={editor}
            // An unfilled variable is attention — the document cannot go out
            // until this user fills it. The clause-library rule is only a
            // provenance mark, so it loses its blue and becomes a paper rule.
            className="prose prose-sm max-w-none p-6 min-h-full focus:outline-none [&_.template-variable-unfilled]:bg-attention-100 [&_.template-variable-unfilled]:border [&_.template-variable-unfilled]:border-attention-200 [&_.template-variable-unfilled]:rounded-chip [&_.template-variable-unfilled]:px-1 [&_.clause-library-ref]:border-l-4 [&_.clause-library-ref]:border-paper-300 [&_.clause-library-ref]:pl-3 [&_.clause-library-ref]:my-2 [&_.contract-section]:mb-6"
          />
        </div>

        {/* Clause library panel */}
        {showClausePanel && (
          <ClauseLibraryPanel
            onInsert={insertClause}
            onClose={() => setShowClausePanel(false)}
          />
        )}
      </div>

      {/* ── Rewrite Document Confirm Dialog ── */}
      {docAiConfirm && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/30">
          <div className="bg-card rounded-card border border-paper-200 shadow-e3 p-6 max-w-sm mx-4">
            <h3 className="text-section text-ink-950 mb-2">Rewrite entire document?</h3>
            <p className="text-body text-ink-500 mb-5">
              The AI will rewrite the full document content. Your current text will be replaced. This cannot be undone unless you have a saved version.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={() => setDocAiConfirm(false)}
                variant="outline"
                size="md"
              >Cancel</Button>
              {/* Confirms a machine rewrite, so it is assist rather than the
                  view's ink primary (Save Draft). */}
              <Button
                onClick={() => handleDocumentAi('rewrite_document')}
                variant="assist"
                size="md"
              >Rewrite</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
