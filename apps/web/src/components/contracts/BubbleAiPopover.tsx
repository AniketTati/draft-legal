/**
 * BubbleAiPopover — P6.3 / docs/30 Wave G.3
 *
 * Streaming inline AI popover anchored to the current selection in
 * the document canvas. Triggered from the bubble-menu's ✨ AI button.
 *
 * Flow:
 *   1. User selects text, clicks ✨ in the bubble menu → onOpen called
 *   2. Popover opens with 4 quick-action chips: Rewrite / Tighten /
 *      Make formal / Check compliance
 *   3. Click a chip → POST /api/v1/agent/assist-stream (NDJSON stream)
 *   4. Tokens appear character-by-character in the output area
 *   5. On done: [Replace] inserts over the selection,
 *               [Insert below] adds a new paragraph,
 *               [Copy] copies to clipboard,
 *               [Dismiss] closes without touching the doc
 *
 * Differs from AiCommandPalette:
 *   • Palette is modal + full query input (free-form)
 *   • This popover is anchored to the selection + action chips only
 *   • This popover STREAMS; the palette renders fully-formed results
 */
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Sparkles, Copy, Check, Replace, ArrowDown, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/auth'

export interface BubbleAiPopoverProps {
  editor: Editor | null
  open:   boolean
  onClose: () => void
  /** Captured at open-time — the current selection has usually
   *  collapsed by the time the popover mounts. */
  selectedText?: string
  selectionRange?: { from: number; to: number } | null
}

interface Action { id: string; label: string; helper: string }

const ACTIONS: Action[] = [
  { id: 'rewrite',          label: 'Rewrite',         helper: 'Clarity + flow, same meaning' },
  { id: 'simplify',         label: 'Tighten',         helper: 'Shorter, plain English' },
  { id: 'suggest_alternative', label: 'Lean our way', helper: 'Slightly shift in our favour' },
  { id: 'check_compliance', label: 'Check compliance', helper: 'List any regulatory gaps' },
]

export function BubbleAiPopover({ editor, open, onClose, selectedText: incomingText, selectionRange }: BubbleAiPopoverProps) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const [selected, setSelected] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Compute anchor position. Prefer the prop-passed selection range
  // (captured at click-time); fall back to the editor's current
  // selection if the caller didn't snapshot it.
  useEffect(() => {
    if (!open || !editor) { setPosition(null); return }
    try {
      const range = selectionRange ?? (
        editor.state.selection.from !== editor.state.selection.to
          ? { from: editor.state.selection.from, to: editor.state.selection.to }
          : null
      )
      if (!range) { onClose(); return }
      const start = editor.view.coordsAtPos(range.from)
      const end   = editor.view.coordsAtPos(range.to)
      const top   = Math.max(end.bottom, start.bottom) + window.scrollY + 8
      const left  = start.left + window.scrollX
      const width = Math.min(520, Math.max(360, end.right - start.left))
      setPosition({ top, left, width })
      const text = incomingText?.trim()
        ? incomingText
        : editor.state.doc.textBetween(range.from, range.to, '\n')
      setSelected(text)
    } catch { onClose() }
    // reset per open
    setResult(''); setError(null); setStreaming(false); setCopied(false)
    return () => { abortRef.current?.abort() }
  }, [open, editor, onClose, incomingText, selectionRange])

  const runAction = async (actionId: string) => {
    if (!selected) return
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setStreaming(true); setResult(''); setError(null)
    try {
      const token = useAuthStore.getState().accessToken ?? ''
      const res = await fetch('/api/v1/agent/assist-stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          selectedText: selected,
          action:       actionId,
          contractType: 'general commercial',
        }),
        signal: abortRef.current.signal,
      })
      if (!res.ok || !res.body) {
        setError(`Stream failed (${res.status})`)
        setStreaming(false)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const ln of lines) {
          if (!ln.trim()) continue
          try {
            const evt = JSON.parse(ln) as { type: string; text?: string; message?: string }
            if (evt.type === 'delta' && evt.text) {
              setResult(r => r + evt.text!)
            } else if (evt.type === 'error') {
              setError(evt.message ?? 'Stream error')
            }
          } catch { /* ignore parse error */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message ?? 'Stream failed')
      }
    } finally {
      setStreaming(false)
    }
  }

  const replaceSelection = () => {
    if (!editor || !result) return
    if (selectionRange) {
      editor.chain()
        .focus()
        .setTextSelection({ from: selectionRange.from, to: selectionRange.to })
        .deleteSelection()
        .insertContent(result)
        .run()
    } else {
      editor.chain().focus().deleteSelection().insertContent(result).run()
    }
    onClose()
  }

  const insertBelow = () => {
    if (!editor || !result) return
    const to = selectionRange?.to ?? editor.state.selection.to
    editor.chain().focus().insertContentAt(to, `\n${result}`).run()
    onClose()
  }

  const copy = async () => {
    if (!result) return
    await navigator.clipboard.writeText(result).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!open || !position) return null

  return (
    <div
      ref={popRef}
      className="fixed z-[60] rounded-card border border-paper-200 bg-popover shadow-e2"
      style={{ top: position.top, left: position.left, width: position.width }}
      data-testid="bubble-ai-popover"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-paper-200">
        {/* U.2.2 / decision 14a — drop "AI" from primary label; indigo accent. */}
        <div className="flex items-center gap-1.5 text-dense font-medium text-ink-950">
          <Sparkles className="size-3.5 text-assist-600" />
          Selection
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded-chip hover:bg-paper-100"
          aria-label="Close"
        >
          <X className="size-3.5 text-ink-500" />
        </button>
      </div>

      {!streaming && !result && !error && (
        <div className="p-2 grid grid-cols-2 gap-1.5" data-testid="bubble-ai-actions">
          {ACTIONS.map(a => (
            <button
              key={a.id}
              onClick={() => runAction(a.id)}
              data-testid={`bubble-ai-action-${a.id}`}
              className="text-left px-2 py-1.5 rounded-md border border-paper-200 hover:border-assist-200 hover:bg-assist-50 transition-colors"
            >
              <div className="text-[11.5px] font-medium text-ink-950">{a.label}</div>
              <div className="text-[10px] text-ink-500">{a.helper}</div>
            </button>
          ))}
        </div>
      )}

      {(streaming || result) && (
        <div className="p-3">
          <div
            className={cn(
              'text-[12.5px] leading-relaxed text-ink-950 min-h-[40px] whitespace-pre-wrap',
              streaming && 'after:inline-block after:w-1.5 after:h-3.5 after:ml-0.5 after:bg-assist-600 after:animate-pulse after:align-middle',
            )}
            data-testid="bubble-ai-result"
          >
            {result || (streaming ? (
              <span className="inline-flex items-center gap-1 text-ink-500">
                <Loader2 className="size-3 animate-spin" /> Streaming…
              </span>
            ) : null)}
          </div>
          {!streaming && result && (
            <div className="mt-2 flex gap-1 flex-wrap">
              <Button
                variant="assist"
                size="xs"
                onClick={replaceSelection}
                data-testid="bubble-ai-replace"
              >
                <Replace className="size-3" /> Replace
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={insertBelow}
                data-testid="bubble-ai-insert-below"
              >
                <ArrowDown className="size-3" /> Insert below
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={copy}
                data-testid="bubble-ai-copy"
              >
                {/* The tick only confirms the clipboard write — a neutral fact,
                    so it stays neutral rather than borrowing the binding green. */}
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { setResult(''); setError(null) }}
                data-testid="bubble-ai-retry"
                className="ml-auto font-normal text-ink-500"
              >
                Try another action
              </Button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 text-[11.5px] text-risk-700">
          {error}
          <button
            onClick={() => { setResult(''); setError(null) }}
            className="ml-2 underline"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
