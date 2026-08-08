/**
 * StatusPill — the inline status indicator that replaces the horizontal
 * StatusStepper row on the contract detail page (B.1.5a).
 *
 * Renders as: [● <status>] plus a caret, sitting on the header line.
 * Clicking opens a popover with a vertical timeline of all lifecycle states.
 *
 * Per docs/25-CONTRACT-FLOW-FIX-PLAN.md §F5, the horizontal stepper was
 * borrowed from wizard/checkout UX and wrong for a document detail page.
 * Gold-standard CLM / document apps (Linear, Notion, Stripe, Ironclad,
 * Juro, Harvey) all use an inline pill with an on-demand history, not a
 * permanent step track.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, statusMeaning } from '@/lib/status'
import { Eyebrow } from '@/components/ui/primitives'

// Happy-path lifecycle — kept parallel to StatusStepper's STEPS so the
// popover shows the same sequence.
const STEPS: Array<{ key: string; label: string; groupWith?: string[] }> = [
  { key: 'DRAFT', label: 'Draft' },
  { key: 'PENDING_REVIEW', label: 'In Review', groupWith: ['UNDER_NEGOTIATION'] },
  { key: 'PENDING_APPROVAL', label: 'Approval' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PENDING_SIGNATURE', label: 'Signing' },
  { key: 'EXECUTED', label: 'Executed' },
]

// Off-path terminal states. These only carry a LABEL now — the color comes
// from lib/status like every other status, so "Expired" reads as risk here and
// in the queue rather than amber in one place and red in the other.
const OFF_PATH: Record<string, { label: string }> = {
  EXPIRED:    { label: 'Expired'    },
  TERMINATED: { label: 'Terminated' },
  ARCHIVED:   { label: 'Archived'   },
  REJECTED:   { label: 'Rejected'   },
}

function resolveIndex(status: string): number {
  for (let i = 0; i < STEPS.length; i++) {
    if (STEPS[i].key === status) return i
    if (STEPS[i].groupWith?.includes(status)) return i
  }
  return -1
}

function currentLabel(status: string): string {
  const off = OFF_PATH[status]
  if (off) return off.label
  const idx = resolveIndex(status)
  if (idx >= 0) return STEPS[idx].label
  // Fallback: show the raw status with underscores humanized
  return status.replace(/_/g, ' ').toLowerCase().replace(/\b./g, c => c.toUpperCase())
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // Click-outside to close. Keyboard Escape too.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const tone = MEANING_CLASS[statusMeaning(status)]
  const label = currentLabel(status)
  const currentIdx = resolveIndex(status)
  const isOffPath = status in OFF_PATH

  return (
    <span className={cn('relative inline-block', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Contract status: ${label}. Click to see lifecycle.`}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-[7px] rounded-full border border-paper-200 bg-paper-100 py-0.5 pl-2 pr-2.5',
          'text-[11.5px] font-medium transition-colors',
          'hover:border-paper-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-1',
          tone.fg,
        )}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden />
        <span>{label}</span>
        <ChevronDown className={cn('size-3 text-ink-400 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Contract lifecycle"
          className="absolute z-50 left-0 top-full mt-2 w-64 rounded-card border border-paper-200 bg-popover p-3 shadow-e2"
        >
          <Eyebrow className="mb-2.5">Lifecycle</Eyebrow>

          {isOffPath ? (
            // Off-path: just show the current state and a note.
            <div className="space-y-1">
              <div className={cn('flex items-center gap-2 text-dense font-medium', tone.fg)}>
                <span className={cn('size-2 rounded-full', tone.dot)} aria-hidden />
                {label}
              </div>
              <p className="text-dense text-ink-500 pl-4">
                This contract is off the active lifecycle. No further automatic transitions.
              </p>
            </div>
          ) : (
            <ol className="space-y-2.5">
              {STEPS.map((step, i) => {
                const done    = currentIdx > i
                const current = currentIdx === i
                return (
                  <li key={step.key} className="flex items-start gap-2.5">
                    <div className="relative flex flex-col items-center">
                      <div
                        className={cn(
                          'flex size-4 items-center justify-center rounded-full border',
                          // A passed stage is settled, so it reads binding. The
                          // current node borrows the status's own meaning —
                          // in flight while signing, binding once executed —
                          // rather than painting every "here" the same color.
                          done    && 'bg-brand-700 border-brand-700 text-white',
                          current && ['bg-card border-current', tone.fg],
                          !done && !current && 'bg-card border-paper-300 text-paper-300',
                        )}
                      >
                        {done ? (
                          <Check className="size-2.5" strokeWidth={3.5} />
                        ) : (
                          <Circle className={cn('size-1.5', current && 'fill-current')} strokeWidth={0} />
                        )}
                      </div>
                      {i < STEPS.length - 1 && (
                        <span className={cn('w-px flex-1 min-h-[14px] mt-1', done ? 'bg-brand-200' : 'bg-paper-200')} aria-hidden />
                      )}
                    </div>
                    <span className={cn(
                      'text-dense leading-4 pt-[1px]',
                      current ? 'text-ink-950 font-medium' : done ? 'text-ink-700' : 'text-ink-400',
                    )}>
                      {step.label}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </span>
  )
}
