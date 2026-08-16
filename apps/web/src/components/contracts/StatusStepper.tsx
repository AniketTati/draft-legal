/**
 * StatusStepper — visual state-machine indicator for a contract.
 *
 * Shows the contract's position in the main lifecycle (DRAFT → … → EXECUTED).
 * Reused in three contexts:
 *   - full    : top of the detail page, horizontal
 *   - compact : inline on list rows
 *   - mini    : inside agent chat cards (Phase D)
 *
 * Off-path terminal states (EXPIRED, TERMINATED, ARCHIVED, REJECTED) are
 * rendered as an overlay badge rather than forcing all steps to show —
 * they don't belong on the happy-path line.
 *
 * Part of docs/25-CONTRACT-FLOW-FIX-PLAN.md Phase A.8.
 */
import { Check, Circle, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, statusMeaning } from '@/lib/status'

type Status =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'UNDER_NEGOTIATION'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PENDING_SIGNATURE'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'TERMINATED'
  | 'ARCHIVED'
  | 'REJECTED'

type Size = 'full' | 'compact' | 'mini'

interface StepDef {
  key: Status
  label: string
  /** Shorter label used in compact/mini variants */
  short?: string
  /** Some statuses share a column — e.g. PENDING_REVIEW and UNDER_NEGOTIATION
   *  both read as the same "negotiation" step for display purposes. */
  groupWith?: Status[]
}

// Happy-path steps, in order. Off-path statuses are overlaid, not inserted.
const STEPS: StepDef[] = [
  { key: 'DRAFT', label: 'Draft' },
  { key: 'PENDING_REVIEW', label: 'In Review', short: 'Review', groupWith: ['UNDER_NEGOTIATION'] },
  { key: 'PENDING_APPROVAL', label: 'Approval', short: 'Approval' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PENDING_SIGNATURE', label: 'Signature', short: 'Sign' },
  { key: 'EXECUTED', label: 'Executed' },
]

// Terminal / off-path states and the words they get. The color is not stored
// here — it comes from the status's meaning in lib/status, so "Expired" is the
// same red on this stepper as it is in the queue.
const OFF_PATH: Record<string, { label: string }> = {
  EXPIRED:    { label: 'Expired'    },
  TERMINATED: { label: 'Terminated' },
  ARCHIVED:   { label: 'Archived'   },
  REJECTED:   { label: 'Rejected — back to Draft' },
}

function resolveIndex(status: Status): number {
  // Returns the index of the step that represents `status` on the happy path.
  // Statuses grouped into a step share that step's index.
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i]
    if (s.key === status) return i
    if (s.groupWith?.includes(status)) return i
  }
  return -1
}

export function StatusStepper({
  status,
  size = 'full',
  className,
}: {
  status: string
  size?: Size
  className?: string
}) {
  const s = status as Status
  const offPath = OFF_PATH[s]
  const currentIdx = resolveIndex(s)
  const tone = MEANING_CLASS[statusMeaning(s)]

  // Off-path view: compact banner instead of the stepper, since the happy-
  // path steps aren't meaningful once the contract has derailed.
  if (offPath && size === 'full') {
    return (
      <div className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-1.5 text-body',
        tone.wash, tone.washFg, tone.washBorder,
        className,
      )}>
        <AlertCircle className="size-4" />
        <span className="font-medium">{offPath.label}</span>
      </div>
    )
  }
  if (offPath) {
    // compact / mini: just a tinted pill
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        tone.wash, tone.washFg,
        className,
      )}>
        <AlertCircle className="size-3" />
        {offPath.label.split(' — ')[0]}
      </span>
    )
  }

  // Happy-path view
  if (size === 'mini') {
    // Just a labelled dot + step label — used in narrow contexts.
    const step = currentIdx >= 0 ? STEPS[currentIdx] : null
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-700', className)}>
        <span className="relative flex size-2">
          {/* The halo pings forever — there is no end state to animate towards,
              so it is decoration, and decoration that never stops is the exact
              thing prefers-reduced-motion exists to switch off. Under `reduce`
              the class drops and the halo stays as a soft static ring. */}
          <span className={cn('absolute inset-0 motion-safe:animate-ping rounded-full opacity-40', tone.dot)} />
          <span className={cn('relative size-2 rounded-full', tone.dot)} />
        </span>
        {step?.short ?? step?.label ?? status}
      </span>
    )
  }

  const dotSize   = size === 'compact' ? 'h-5 w-5' : 'h-7 w-7'
  const lineThick = size === 'compact' ? 'h-0.5' : 'h-0.5'
  const labelSize = size === 'compact' ? 'text-[10px]' : 'text-[11.5px]'

  return (
    <div className={cn('flex items-center w-full', className)}>
      {STEPS.map((step, i) => {
        const done    = currentIdx > i
        const current = currentIdx === i
        const future  = currentIdx < i || currentIdx < 0
        return (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
            {/* Dot */}
            <div className="flex flex-col items-center min-w-0">
              <div
                className={cn(
                  'rounded-full flex items-center justify-center transition-colors border-2',
                  dotSize,
                  // A passed step is settled, so it reads binding; the step the
                  // contract is ON borrows that status's own meaning. The halo
                  // stays neutral so only one element in the row is colored.
                  done    && 'bg-brand-700 border-brand-700 text-white',
                  current && ['bg-card border-current ring-4 ring-paper-100', tone.fg],
                  future  && 'bg-card border-paper-300 text-ink-400',
                )}
              >
                {done ? (
                  <Check className={size === 'compact' ? 'h-3 w-3' : 'h-4 w-4'} strokeWidth={3} />
                ) : current ? (
                  <Circle className={size === 'compact' ? 'h-2 w-2 fill-current' : 'h-3 w-3 fill-current'} strokeWidth={0} />
                ) : (
                  <Circle className={size === 'compact' ? 'h-2 w-2' : 'h-3 w-3'} strokeWidth={2} />
                )}
              </div>
              <span
                className={cn(
                  'mt-1 font-medium whitespace-nowrap',
                  labelSize,
                  done    && 'text-ink-500',
                  current && 'text-ink-950',
                  future  && 'text-ink-400',
                )}
              >
                {size === 'compact' ? (step.short ?? step.label) : step.label}
              </span>
            </div>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  'flex-1 mx-2 -mt-5',
                  lineThick,
                  done ? 'bg-brand-700' : 'bg-paper-200',
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
