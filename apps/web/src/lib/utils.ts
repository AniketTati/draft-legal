import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const RELATIVE_TIME_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

/**
 * Human relative time — "3 days ago", "in 2 hours", "yesterday".
 *
 * Built on Intl.RelativeTimeFormat (no dependency). Picks the largest
 * unit under which the delta still fits, so "just now" reads in seconds
 * and last quarter reads in months. Returns '' for an unparseable date
 * so callers can fall back to an absolute string.
 */
export function formatRelativeTime(input: string | number | Date, now: Date = new Date()): string {
  const then = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(then.getTime())) return ''

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  let delta = (then.getTime() - now.getTime()) / 1000 // seconds, signed (past is negative)

  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(delta) < division.amount) {
      return rtf.format(Math.round(delta), division.unit)
    }
    delta /= division.amount
  }
  return ''
}
