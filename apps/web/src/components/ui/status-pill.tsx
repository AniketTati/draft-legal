import * as React from 'react'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, statusMeta, type Meaning } from '@/lib/status'

/**
 * StatusPill — the one way this product renders a status.
 *
 * Default treatment is a neutral pill with a colored meaning dot. That gives
 * one colored element per row, which stays scannable down a column of two
 * hundred. `tone="wash"` fills the pill with the meaning color and is reserved
 * for a single row-level exception per screen — an escalated contract, a failed
 * import — never for a whole column.
 *
 * Pass a raw API status (`PENDING_REVIEW`) and it resolves its own label and
 * meaning from lib/status. Pass `meaning` + `children` to label something that
 * isn't in an enum.
 */
export function StatusPill({
  status,
  meaning,
  children,
  tone = 'dot',
  className,
}: {
  /** Raw upper-snake status from the API. Resolves label + meaning. */
  status?: string | null
  /** Override the meaning, or supply one for non-enum labels. */
  meaning?: Meaning
  /** Override the label. Falls back to the status map. */
  children?: React.ReactNode
  tone?: 'dot' | 'wash'
  className?: string
}) {
  const meta = statusMeta(status)
  const key = meaning ?? meta.meaning
  const m = MEANING_CLASS[key]
  const wash = tone === 'wash'

  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-[7px] rounded-full border py-0.5 pl-2 pr-2.5',
        'text-[11.5px] font-medium',
        wash ? [m.wash, m.washFg, m.washBorder] : ['bg-paper-100 border-paper-200', m.fg],
        className
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', m.dot)} />
      {children ?? meta.label}
    </span>
  )
}

/**
 * MeaningDot — the pill's dot on its own, for rows too dense for a pill.
 * Carries the label as an accessible name so the color isn't the only signal.
 */
export function MeaningDot({
  status,
  meaning,
  label,
  className,
}: {
  status?: string | null
  meaning?: Meaning
  label?: string
  className?: string
}) {
  const meta = statusMeta(status)
  const key = meaning ?? meta.meaning
  return (
    <span
      role="img"
      aria-label={label ?? meta.label}
      title={label ?? meta.label}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', MEANING_CLASS[key].dot, className)}
    />
  )
}
