/**
 * docs/41 Part 16, step 6 — Ask AI on selected words: say what you want, get
 * three drafts paged "1 of 3", each with a one-line reason, then Insert as
 * tracked change, Replace, or Copy.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Check, Copy, Loader2, Replace, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { serverMessage } from '@/lib/approval-keys'

export interface AskAiDraft { id: string; text: string; rationale: string }
export interface AskAiResult { suggestionId: string; drafts: AskAiDraft[] }
export type AskAiOutcome = 'shown' | 'accepted' | 'edited' | 'dismissed'

/** Which draft a page shows, kept inside the list. */
export const pageOf = (page: number, count: number) => (count ? ((page % count) + count) % count : 0)

export function AskAiDrafts({ contractId, selectedText, onInsertTracked, onReplace, onOutcome, initial }: {
  contractId: string
  selectedText: string
  /** The draft's words, and the suggestion they came from (for the edited outcome). */
  onInsertTracked: (text: string, suggestionId?: string) => void
  onReplace: (text: string) => void
  /** What became of the drafts (docs/41: every AI insertion is logged). */
  onOutcome?: (outcome: AskAiOutcome, suggestionId: string) => void
  /** Drafts already made (tests, or a reopened popover). */
  initial?: AskAiResult
}) {
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<AskAiResult | null>(initial ?? null)
  const [page, setPage] = useState(0)
  const [copied, setCopied] = useState(false)
  // Drafts shown and closed without one being used: dismissed.
  const open = useRef<{ id: string | null; settled: boolean }>({ id: null, settled: false })
  const ask = useMutation({
    meta: { errorHandled: true },
    mutationFn: () => api.post<AskAiResult>(`/contracts/${contractId}/ask-ai`, { selectedText, instruction }).then(r => r.data),
    onSuccess: r => {
      // Asking again passes over the drafts before.
      if (open.current.id && !open.current.settled) onOutcome?.('dismissed', open.current.id)
      setResult(r); setPage(0); onOutcome?.('shown', r.suggestionId)
    },
  })

  useEffect(() => { open.current = { id: result?.suggestionId ?? null, settled: false } }, [result?.suggestionId])
  const outcome = useRef(onOutcome)
  outcome.current = onOutcome
  useEffect(() => () => {
    const o = open.current
    if (o.id && !o.settled) outcome.current?.('dismissed', o.id)
  }, [])

  const drafts = result?.drafts ?? []
  const at = pageOf(page, drafts.length)
  const d = drafts[at]
  const done = (o: AskAiOutcome, run: () => void) => {
    if (result) { open.current.settled = true; onOutcome?.(o, result.suggestionId) }
    run()
  }

  return (
    <div className="p-2.5 space-y-2" data-testid="ask-ai-drafts">
      <div className="flex gap-1.5">
        <input
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && instruction.trim() && !ask.isPending) ask.mutate() }}
          placeholder="What should change? e.g. make it mutual"
          className="flex-1 h-8 rounded-md border border-input bg-card px-2 text-dense focus-visible:outline-none focus-visible:border-brand-700"
          data-testid="ask-ai-instruction"
          autoFocus
        />
        <Button size="sm" variant="assist" disabled={!instruction.trim() || ask.isPending} onClick={() => ask.mutate()} data-testid="ask-ai-go">
          {ask.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}Draft
        </Button>
      </div>
      {ask.isError && <p className="text-[11.5px] text-risk-700">{serverMessage(ask.error, 'No drafts. Try again.')}</p>}

      {d && (
        <div className="rounded-md border border-paper-200 p-2 space-y-1.5" data-testid="ask-ai-draft">
          <div className="flex items-center gap-1 text-[11px] text-ink-500">
            <button type="button" aria-label="Previous draft" disabled={drafts.length < 2} onClick={() => setPage(p => p - 1)} className="p-0.5 rounded hover:bg-paper-100 disabled:opacity-40" data-testid="ask-ai-prev"><ChevronLeft className="size-3.5" /></button>
            <span className="tabular-nums" data-testid="ask-ai-page">{at + 1} of {drafts.length}</span>
            <button type="button" aria-label="Next draft" disabled={drafts.length < 2} onClick={() => setPage(p => p + 1)} className="p-0.5 rounded hover:bg-paper-100 disabled:opacity-40" data-testid="ask-ai-next"><ChevronRight className="size-3.5" /></button>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-950 whitespace-pre-wrap" data-testid="ask-ai-text">{d.text}</p>
          {d.rationale && <p className="text-[11.5px] text-ink-500" data-testid="ask-ai-rationale">Why: {d.rationale}</p>}
          <div className="flex flex-wrap gap-1">
            <Button size="xs" variant="assist" onClick={() => done('accepted', () => onInsertTracked(d.text, result?.suggestionId))} data-testid="ask-ai-insert-tracked">Insert as tracked change</Button>
            <Button size="xs" variant="outline" onClick={() => done('accepted', () => onReplace(d.text))} data-testid="ask-ai-replace"><Replace className="size-3" />Replace</Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => { void navigator.clipboard?.writeText(d.text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              data-testid="ask-ai-copy"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
