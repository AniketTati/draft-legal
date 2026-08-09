/**
 * Calendar-day arithmetic for contract deadlines.
 *
 * Every "expires in Nd" / "due in Nd" string in the workspace used to be
 * `Math.floor((then - Date.now()) / 86_400_000)`. That is elapsed-time
 * arithmetic, and it is the wrong model for a legal deadline:
 *
 *   • A contract expiring on 8 Sep read "expires in 29d" in the record header
 *     and "Expires in 30d" in the Renewal rail — on the same screen, at the
 *     same moment — because the rail already normalised to midnight and the
 *     header did not. Two answers to "when does this lapse" is exactly the
 *     kind of thing that stops counsel trusting the system.
 *   • An obligation due tomorrow at 09:00, read at 15:00 today, floors to 0
 *     and renders "due today".
 *   • An obligation that fell due six hours ago floors to -1 and renders
 *     "1d overdue" when nobody has yet missed a day.
 *
 * A deadline is a date, not an instant. Normalise both ends to local midnight
 * and count calendar days, which is what a human counting on a wall calendar
 * would say — and what the notice-period clause means.
 */

/** Whole calendar days from today to `iso`. Negative = in the past. */
export function calendarDaysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const target = new Date(iso)
  if (Number.isNaN(target.getTime())) return null
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

/**
 * How a deadline should read, and how loudly.
 *
 * Meaning follows the design system's five: an expiry is `risk` once it has
 * lapsed or is inside the 30-day notice window (real exposure), `turn` while
 * it sits in the 90-day renewal window (someone has to decide), and plain
 * `neutral` once it's far enough out to be a fact rather than news.
 */
export type DeadlineTone = 'risk' | 'turn' | 'neutral'

export function expiryLabel(iso: string | null | undefined): {
  days: number
  label: string
  tone: DeadlineTone
} | null {
  const days = calendarDaysUntil(iso)
  if (days === null) return null
  if (days < 0) {
    return { days, label: `Expired ${-days}d ago`, tone: 'risk' }
  }
  if (days === 0) return { days, label: 'Expires today', tone: 'risk' }
  if (days <= 30) return { days, label: `Expires in ${days}d`, tone: 'risk' }
  if (days <= 90) return { days, label: `Expires in ${days}d`, tone: 'turn' }
  return {
    days,
    label: `Expires ${new Date(iso!).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`,
    tone: 'neutral',
  }
}

/** Elapsed-time phrasing, for "edited"/"last activity" — not for deadlines. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return '—'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  const days = calendarDaysUntil(iso)
  if (days === null) return '—'
  if (days === -1) return 'yesterday'
  if (days > -7) return `${-days}d ago`
  if (days > -30) return `${Math.floor(-days / 7)}w ago`
  if (days > -365) return `${Math.floor(-days / 30)}mo ago`
  return new Date(iso).toLocaleDateString()
}
