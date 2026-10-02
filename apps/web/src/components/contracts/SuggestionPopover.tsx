/**
 * docs/41 Part 16 (C4) — a suggestion clicked in the document: who made it,
 * when, what it does, and Accept / Reject. Placed under the clicked words.
 */
import { useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SuggestionKind } from '../editor/TrackChanges'

export interface OpenSuggestion {
  id: string
  kind: SuggestionKind
  authorName: string | null
  at: string | null
  text: string
  /** Where the clicked words are on screen (viewport coordinates). */
  rect: { left: number; bottom: number }
}

/** "2 Oct, 14:05", or nothing when the time is missing or unreadable. */
export function whenOf(at: string | null): string {
  const d = at ? new Date(at) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function SuggestionPopover({ change, canDecide, onAccept, onReject, onClose }: {
  change: OpenSuggestion
  canDecide: boolean
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Closes on Escape, and on a click anywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [onClose])

  const what = change.kind === 'insertion' ? 'Suggested adding' : 'Suggested removing'
  const when = whenOf(change.at)
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Suggestion"
      className="fixed z-50 w-[280px] rounded-md border border-paper-200 bg-popover p-3 shadow-e2"
      style={{ left: Math.max(8, change.rect.left), top: change.rect.bottom + 6 }}
      data-testid="suggestion-popover"
      data-change-id={change.id}
    >
      <p className="text-dense font-medium text-ink-950">{change.authorName || 'Someone'}</p>
      {when && <p className="text-[11.5px] text-ink-500">{when}</p>}
      <p className="mt-2 text-dense text-ink-700">
        {what}: <span className={change.kind === 'insertion' ? 'underline' : 'line-through'}>“{change.text.slice(0, 160)}{change.text.length > 160 ? '…' : ''}”</span>
      </p>
      {canDecide && (
        <div className="mt-3 flex gap-1.5">
          <Button size="sm" onClick={() => onAccept(change.id)} data-testid="suggestion-accept"><Check />Accept</Button>
          <Button size="sm" variant="outline" onClick={() => onReject(change.id)} data-testid="suggestion-reject"><X />Reject</Button>
        </div>
      )}
    </div>
  )
}
