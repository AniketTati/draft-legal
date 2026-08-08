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
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center w-8 h-8 rounded text-sm transition-colors',
        active
          ? 'bg-blue-100 text-blue-700'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
      )}
    >
      {children}
    </button>
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
    <div className="w-52 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto p-3 hidden lg:block">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sections</p>
      <nav className="space-y-0.5">
        {parsed.map((h, i) => (
          <div
            key={i}
            onClick={() => scrollToHeading(i)}
            className={cn(
              'text-sm text-gray-600 cursor-pointer hover:text-gray-900 truncate py-0.5',
              h.level === 3 && 'pl-3 text-xs',
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
    <div className="w-72 shrink-0 border-l border-gray-200 bg-white flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
        <div className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
          <BookOpen className="w-4 h-4" />
          Clause Library
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-3 py-2 border-b border-gray-100">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search clauses..."
          className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-blue-400"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <p className="text-xs text-gray-400 p-3">Loading...</p>}
        {!loading && !clauses.length && (
          <p className="text-xs text-gray-400 p-3">No clauses found</p>
        )}
        {clauses.map(c => (
          <div
            key={c.id}
            className="px-3 py-2 border-b border-gray-100 hover:bg-blue-50 cursor-pointer group"
            onClick={() => onInsert(c.content)}
          >
            <div className="flex items-start justify-between gap-1">
              <p className="text-sm font-medium text-gray-800 leading-snug">{c.title}</p>
              <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-blue-500 shrink-0 mt-0.5" />
            </div>
            {c.category?.name && (
              <p className="text-xs text-gray-400 mt-0.5">{c.category.name}</p>
            )}
            {c.riskRating && (
              <span className={cn(
                'inline-block text-xs px-1.5 py-0.5 rounded mt-1',
                c.riskRating === 'favorable' && 'bg-green-100 text-green-700',
                c.riskRating === 'unfavorable' && 'bg-red-100 text-red-700',
                c.riskRating === 'neutral' && 'bg-gray-100 text-gray-600',
                c.riskRating === 'standard' && 'bg-blue-100 text-blue-700',
              )}>
                {c.riskRating}
              </span>
            )}
          </div>
        ))}
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
    <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-50 border-b border-yellow-200 text-sm">
      <Search className="w-4 h-4 text-yellow-600" />
      <input
        value={find}
        onChange={e => setFind(e.target.value)}
        placeholder="Find..."
        className="border border-yellow-300 rounded px-2 py-1 text-sm w-36 outline-none"
      />
      <input
        value={replace}
        onChange={e => setReplace(e.target.value)}
        placeholder="Replace..."
        className="border border-yellow-300 rounded px-2 py-1 text-sm w-36 outline-none"
      />
      <button
        onClick={() => onFind(find)}
        className="text-xs px-2 py-1 bg-yellow-100 rounded hover:bg-yellow-200"
      >Find</button>
      <button
        onClick={() => onReplace(find, replace)}
        className="text-xs px-2 py-1 bg-yellow-100 rounded hover:bg-yellow-200"
      >Replace All</button>
      <button onClick={onClose}><X className="w-4 h-4 text-gray-400 hover:text-gray-600" /></button>
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

    // Highlight the inserted text green + scroll into view
    if (insertedFrom < insertedTo) {
      editor.chain()
        .setTextSelection({ from: insertedFrom, to: insertedTo })
        .setHighlight({ color: '#bbf7d0' })
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
    <div className="relative flex flex-col h-full bg-white border border-gray-200 rounded-lg overflow-hidden">
      {exportError && (
        <div
          role="alert"
          data-testid="editor-export-error"
          className="flex items-start justify-between gap-3 px-3 py-2 text-sm bg-red-50 border-b border-red-200 text-red-800"
        >
          <span className="min-w-0 break-words">{exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="shrink-0 text-red-700 hover:text-red-900 font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* ── Toolbar ── */}
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-gray-200 bg-gray-50">
        {/* History */}
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo"><Undo className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo"><Redo className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Headings */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1"><Heading1 className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2"><Heading2 className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3"><Heading3 className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Inline formatting */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold"><Bold className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic"><Italic className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline"><UnderlineIcon className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough"><Strikethrough className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Alignment */}
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Align Left"><AlignLeft className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Align Center"><AlignCenter className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Align Right"><AlignRight className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Lists */}
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List"><List className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Numbered List"><ListOrdered className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Table */}
        <ToolbarBtn onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert Table"><TableIcon className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Tools */}
        <ToolbarBtn onClick={() => setShowClausePanel(p => !p)} active={showClausePanel} title="Clause Library"><BookOpen className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => setShowFindReplace(p => !p)} active={showFindReplace} title="Find & Replace"><Search className="w-4 h-4" /></ToolbarBtn>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* AI Assist — acts on selected text */}
        <div className="relative flex items-center gap-0.5 border border-purple-200 rounded px-1 bg-purple-50">
          {assistLoading
            ? <><Loader2 className="w-3.5 h-3.5 text-purple-500 animate-spin ml-1" /><span className="text-xs text-purple-600 px-1">Thinking…</span></>
            : <Wand2 className="w-3.5 h-3.5 text-purple-500 mr-0.5" />
          }
          {ASSIST_ACTIONS.map(a => (
            <button
              key={a.action}
              type="button"
              onClick={() => handleAssist(a.action)}
              disabled={assistLoading}
              title={`AI: ${a.label} (select text first)`}
              className="text-xs px-1.5 py-1 rounded hover:bg-purple-100 text-purple-700 disabled:opacity-50 transition-colors"
            >
              {a.label}
            </button>
          ))}
          {assistHint && (
            <div className="absolute top-full left-0 mt-1 z-10 px-2 py-1 bg-gray-800 text-white text-xs rounded shadow whitespace-nowrap">
              Select text first
            </div>
          )}
        </div>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Document AI — whole-document operations */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowDocAiMenu(p => !p)}
            disabled={!!docAiLoading}
            title="Document AI"
            className="flex items-center gap-1 text-xs px-2 py-1.5 border border-blue-200 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
          >
            {docAiLoading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" />{docAiLoading === 'fix_layout' ? 'Fixing…' : 'Rewriting…'}</>
            ) : (
              <><Wand2 className="w-3.5 h-3.5" />Doc AI ▾</>
            )}
          </button>
          {showDocAiMenu && (
            <div className="absolute top-full left-0 mt-1 z-20 w-48 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              <button
                onClick={() => handleDocumentAi('fix_layout')}
                className="w-full text-left px-3 py-2.5 text-sm hover:bg-blue-50 text-gray-700"
              >
                ✨ Fix Layout
                <p className="text-xs text-gray-400 mt-0.5">Clean up PDF extraction artifacts</p>
              </button>
              <button
                onClick={() => { setShowDocAiMenu(false); setDocAiConfirm(true) }}
                className="w-full text-left px-3 py-2.5 text-sm hover:bg-blue-50 text-gray-700 border-t border-gray-100"
              >
                📝 Rewrite Document
                <p className="text-xs text-gray-400 mt-0.5">AI rewrites full document</p>
              </button>
            </div>
          )}
        </div>
        <div className="w-px h-5 bg-gray-300 mx-1" />

        {/* Export */}
        <ToolbarBtn onClick={() => handleExport('pdf')} title="Export PDF"><FileText className="w-4 h-4" /></ToolbarBtn>
        <ToolbarBtn onClick={() => handleExport('docx')} title="Export DOCX"><Download className="w-4 h-4" /></ToolbarBtn>

        {/* Save */}
        {onSave && !readOnly && (
          <button
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
            className={`ml-auto text-xs px-3 py-1.5 rounded transition-colors ${
              saveState === 'saved'  ? 'bg-emerald-600 text-white' :
              saveState === 'error'  ? 'bg-red-600 text-white' :
              saveState === 'saving' ? 'bg-blue-400 text-white cursor-not-allowed' :
              'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved!' : saveState === 'error' ? 'Save failed' : 'Save Draft'}
          </button>
        )}

        {/* Word count */}
        <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">{wordCount} words</span>
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
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 flex items-center justify-between">
          <p className="text-xs text-red-700">{assistError}</p>
          <button onClick={() => setAssistError(null)}><X className="w-3.5 h-3.5 text-red-400 hover:text-red-600" /></button>
        </div>
      )}

      {/* ── Doc AI Save Reminder ── */}
      {docAiDone && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-3">
          <p className="text-xs text-amber-800">Doc AI updated the document — click <strong>Save Draft</strong> to keep the changes.</p>
          <button onClick={() => setDocAiDone(false)}><X className="w-3.5 h-3.5 text-amber-500 hover:text-amber-700" /></button>
        </div>
      )}

      {/* ── AI Assist Result Banner ── */}
      {assistResult && (
        <div className="px-4 py-3 bg-purple-50 border-b border-purple-200">
          {/* Header row */}
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-purple-700">AI Suggestion</p>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={applyAssistResult}
                className="text-xs px-3 py-1 bg-purple-600 text-white rounded hover:bg-purple-700"
              >Apply</button>
              <button
                onClick={() => { setAssistResult(null); setAssistOriginalText(null); assistSelectionRef.current = null }}
                className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
              >Dismiss</button>
            </div>
          </div>
          {/* Before / After diff */}
          <div className="rounded border border-gray-200 overflow-hidden text-sm">
            {assistOriginalText && (
              <div className="flex gap-2 px-3 py-2 bg-red-50 border-b border-gray-200">
                <span className="text-red-400 font-bold shrink-0">−</span>
                <p className="text-red-700 line-through leading-snug line-clamp-4">{assistOriginalText}</p>
              </div>
            )}
            <div className="flex gap-2 px-3 py-2 bg-green-50">
              <span className="text-green-500 font-bold shrink-0">+</span>
              <p className="text-green-800 leading-snug line-clamp-5">{assistResult.revisedText}</p>
            </div>
          </div>
          {/* Explanation */}
          <p className="text-xs text-gray-500 mt-1.5 italic">{assistResult.explanation}</p>
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
            className="prose prose-sm max-w-none p-6 min-h-full focus:outline-none [&_.template-variable-unfilled]:bg-amber-100 [&_.template-variable-unfilled]:border [&_.template-variable-unfilled]:border-amber-300 [&_.template-variable-unfilled]:rounded [&_.template-variable-unfilled]:px-1 [&_.clause-library-ref]:border-l-4 [&_.clause-library-ref]:border-blue-300 [&_.clause-library-ref]:pl-3 [&_.clause-library-ref]:my-2 [&_.contract-section]:mb-6"
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
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Rewrite entire document?</h3>
            <p className="text-sm text-gray-500 mb-5">
              The AI will rewrite the full document content. Your current text will be replaced. This cannot be undone unless you have a saved version.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDocAiConfirm(false)}
                className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >Cancel</button>
              <button
                onClick={() => handleDocumentAi('rewrite_document')}
                className="text-sm px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >Rewrite</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
