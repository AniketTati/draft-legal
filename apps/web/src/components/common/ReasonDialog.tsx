/**
 * A small dialog that asks for a reason before an action that someone else
 * will read about: declining a request (the requester is told why), asking
 * for a clause exception (the approver decides on it). docs/41 Parts 4, 7.
 *
 * The reason is required. A blank or one-word "no" tells the reader nothing,
 * so the confirm button stays off until there are at least `minLength`
 * characters. The server checks again and its words are shown here.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  open:          boolean
  title:         string
  /** What happens, in a sentence or two, above the box. */
  intro?:        ReactNode
  label:         string
  placeholder?:  string
  confirmLabel:  string
  pendingLabel?: string
  minLength?:    number
  pending?:      boolean
  /** The server's refusal, shown where it happened. */
  error?:        string | null
  onConfirm:     (reason: string) => void
  onClose:       () => void
  testId?:       string
}

export function ReasonDialog({
  open, title, intro, label, placeholder, confirmLabel, pendingLabel,
  minLength = 3, pending = false, error, onConfirm, onClose, testId = 'reason-dialog',
}: Props) {
  const [reason, setReason] = useState('')
  // Each opening starts blank: a reason belongs to one decision.
  useEffect(() => { if (open) setReason('') }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, pending, onClose])

  if (!open) return null
  const trimmed = reason.trim()
  const tooShort = trimmed.length < minLength

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 bg-ink-950/30 flex items-center justify-center p-4"
      onClick={() => { if (!pending) onClose() }}
      data-testid={testId}
    >
      <form
        className="bg-card rounded-card max-w-sm w-full shadow-e3"
        onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); if (!tooShort && !pending) onConfirm(trimmed) }}
      >
        <div className="px-5 py-3.5 border-b border-paper-200 flex items-start justify-between gap-3">
          <h2 className="text-section text-ink-950">{title}</h2>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Close" className="p-1 rounded-chip hover:bg-paper-100 text-ink-400">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-2.5">
          {intro && <div className="text-dense text-ink-500">{intro}</div>}
          <label className="block">
            <span className="block text-dense font-medium text-ink-700 mb-1">{label}</span>
            <textarea
              autoFocus
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder={placeholder}
              className="w-full text-[13px] text-ink-950 bg-card px-2.5 py-1.5 border border-input rounded-md placeholder:text-ink-400 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15 resize-y"
              data-testid={`${testId}-text`}
            />
          </label>
          {reason.length > 0 && tooShort && (
            <p className="text-[11.5px] text-ink-500">Say a little more: at least {minLength} characters.</p>
          )}
          {error && (
            <p role="alert" className="text-dense text-risk-900 bg-risk-50 border border-risk-200 rounded-md px-3 py-2" data-testid={`${testId}-error`}>
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-paper-200 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" disabled={tooShort || pending} data-testid={`${testId}-confirm`}>
            {pending ? <><Loader2 className="animate-spin" /> {pendingLabel ?? confirmLabel}</> : confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  )
}
