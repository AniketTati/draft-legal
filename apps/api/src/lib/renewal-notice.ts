/**
 * Auto-renewal notice deadline — the last day notice to terminate can be
 * served before an auto-renewing contract renews itself (C6).
 *
 * This is the one irreversible date on a renewal, and it runs on a different
 * clock from expiry: a contract expiring in 140 days with a 120-day notice
 * period must be acted on within 20. It used to be computed only in the
 * browser (RenewalsPage), while the daily scan alerted on expiry within 90
 * days — so any notice period longer than 90 days was flagged after its
 * opt-out date had passed. The scan and GET /renewals both derive it here.
 *
 * docs/39 F1 — which notice. The extraction used to return one undefined
 * "notice period", which could be the notice to end early rather than the
 * notice to stop a renewal: a 30-day termination notice put the deadline two
 * months late on a contract with a 90-day non-renewal notice. It now returns
 * each by purpose; the deadline uses only the non-renewal notice, and a value
 * found before the split still counts but is reported `confirmed: false` so
 * the screens can ask which notice it is. Months count by the calendar:
 * "3 months" before 31 December is 30 September, not 90 days back.
 */
import { formatFieldValue, parseDuration, subtractDuration, type DurationUnit, type DurationValue } from '@clm/types'

const UNITS = new Set<DurationUnit>(['days', 'weeks', 'months', 'years'])

/**
 * A notice period as stored in any shape the codebase has written: a number
 * of days, "90 days", "3 months", or { value, unit }. Only a single number
 * counts: "30-60 days" would be a guess about which bound binds, and people
 * diarise against this date.
 */
function asDuration(raw: unknown): DurationValue | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? { value: Math.round(raw), unit: 'days' } : null
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const d = raw as { value?: unknown; unit?: unknown }
    const n = Number(d.value)
    return Number.isFinite(n) && n > 0 && UNITS.has(d.unit as DurationUnit) ? { value: n, unit: d.unit as DurationUnit } : null
  }
  const text = String(raw).trim()
  if (/\d\s*(?:-|–|to)\s*\d/i.test(text)) return null
  if (!/^\(?\s*\d/.test(text.replace(/^[a-z-]+\s*\(/i, '('))) return null
  const d = parseDuration(text)
  return d && d.value > 0 ? d : null
}

/** Keys holding the non-renewal notice, and the notice periods found before the split (type unconfirmed). */
const NON_RENEWAL_KEYS = ['nonRenewalNotice', 'nonRenewalNoticeDays', 'renewalNoticeDays'] as const
const UNCONFIRMED_KEYS = ['noticePeriodDays', 'noticePeriod', 'noticeDays'] as const

/** The notice that stops a renewal, and whether the contract says it is that notice. */
export function renewalNoticePeriod(kt: Record<string, unknown> | null | undefined): { notice: DurationValue; confirmed: boolean } | null {
  if (!kt) return null
  for (const k of NON_RENEWAL_KEYS) { const d = asDuration(kt[k]); if (d) return { notice: d, confirmed: true } }
  for (const k of UNCONFIRMED_KEYS) { const d = asDuration(kt[k]); if (d) return { notice: d, confirmed: false } }
  return null
}

/**
 * The notice period in whole days (months at 30 days where no date anchors
 * them) — for callers that only show a number; the deadline itself counts
 * by the calendar.
 */
export function noticeDaysOf(kt: Record<string, unknown> | null | undefined): number | null {
  const p = renewalNoticePeriod(kt)
  return p ? daysIn(p.notice) : null
}

const daysIn = ({ value, unit }: DurationValue) =>
  Math.round(unit === 'days' ? value : unit === 'weeks' ? value * 7 : unit === 'months' ? value * 30 : value * 365)

/** keyTerms.autoRenew as a real boolean — a corrected "no" is not auto-renewing. */
export function isAutoRenew(kt: Record<string, unknown> | null | undefined): boolean {
  const v = kt?.autoRenew
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['yes', 'true', 'y', '1', 'auto', 'automatic'].includes(v.trim().toLowerCase())
  if (typeof v === 'number') return v === 1
  return false
}

export interface RenewalNotice {
  autoRenew:  boolean
  /** Notice-to-stop-renewal period in whole days; null when not extracted. */
  noticeDays: number | null
  /** The notice as the contract states it: "90 days", "3 months". */
  noticeLabel: string | null
  /**
   * False when the period is one found before notices were told apart:
   * it may be the notice to end early instead. Ask before relying on it.
   */
  noticeConfirmed: boolean
  /** expiry − notice (by the calendar); null unless auto-renewing with both known. */
  deadline:   Date | null
}

const termsOf = (keyTerms: unknown): Record<string, unknown> | null =>
  keyTerms && typeof keyTerms === 'object' && !Array.isArray(keyTerms) ? keyTerms as Record<string, unknown> : null

/**
 * The deadline and the day count for a notice period: expiry − notice by the
 * calendar ("3 months" before 31 December is 30 September), and the days that
 * makes; with no deadline to anchor it, months count as 30 days.
 */
function noticeFrom(
  expiryDate: Date | null,
  autoRenew: boolean,
  period: { notice: DurationValue; confirmed: boolean } | null,
): RenewalNotice {
  const deadline = autoRenew && period && expiryDate ? subtractDuration(expiryDate, period.notice) : null
  const noticeDays = period
    ? (expiryDate && deadline ? Math.round((expiryDate.getTime() - deadline.getTime()) / 86_400_000) : daysIn(period.notice))
    : null
  return {
    autoRenew,
    noticeDays,
    noticeLabel: period ? formatFieldValue('duration', period.notice) : null,
    noticeConfirmed: period?.confirmed ?? false,
    deadline,
  }
}

export function renewalNotice(c: { expiryDate: Date | null; keyTerms: unknown }): RenewalNotice {
  const kt = termsOf(c.keyTerms)
  return noticeFrom(c.expiryDate, isAutoRenew(kt), renewalNoticePeriod(kt))
}

/** The linked contracts that change a contract's terms (Contract.amendments of these types). */
export const TERM_CHANGERS = ['amendment', 'renewal']

/** A child of the contract, as renewal views load it. */
export interface TermChanger {
  title: string
  relationshipType: string | null
  // Only a signed amendment changes the terms: a draft or one still in
  // negotiation moved the deadline before anyone had agreed to it.
  status: string
  keyTerms: unknown
  effectiveDate: Date | null
  createdAt: Date
}

/**
 * renewalNotice after the contract's amendments and renewals: the latest
 * signed one that states a notice period, or whether the contract
 * auto-renews, wins. From the original period alone the deadline was wrong
 * everywhere it showed once an amendment changed it (Databricks: 30 → 60
 * days moved it from 14 Nov to 15 Oct). `noticeSetBy` names the amendment
 * that set it. (An amendment's values rolled up onto the agreement by
 * docs/39 G3 are read the same either way: the agreement's own terms, then
 * the amendment's.)
 */
export function amendedRenewalNotice(
  c: { expiryDate: Date | null; keyTerms: unknown },
  changers: TermChanger[] = [],
): RenewalNotice & { noticeSetBy: string | null } {
  const base = termsOf(c.keyTerms)
  let autoRenew = isAutoRenew(base)
  let period = renewalNoticePeriod(base)
  let noticeSetBy: string | null = null
  const inOrder = changers
    .filter(a => a.relationshipType != null && TERM_CHANGERS.includes(a.relationshipType) && a.status === 'EXECUTED')
    .sort((a, b) => (a.effectiveDate ?? a.createdAt).getTime() - (b.effectiveDate ?? b.createdAt).getTime())
  for (const a of inOrder) {
    const kt = termsOf(a.keyTerms)
    const p = renewalNoticePeriod(kt)
    if (p) { period = p; noticeSetBy = a.title }
    // An amendment silent on auto-renewal leaves it as it was.
    if (kt?.autoRenew != null && kt.autoRenew !== '') autoRenew = isAutoRenew(kt)
  }
  return { ...noticeFrom(c.expiryDate, autoRenew, period), noticeSetBy }
}

/**
 * Where-fragment for renewal views: the contracts that renew on their own.
 * An amendment or an exhibit renews with the contract it belongs to, so it
 * is not a renewal of its own (it was listed beside its parent, with the
 * parent's expiry). A SOW, order form or renewal under a parent has its own
 * term and stays, as does a link of no stated kind. (Null is spelled out:
 * `notIn` alone would drop it.) Use it inside an AND list — contract-family's
 * RENEWS_ON_ITS_OWN wraps it so for spreading.
 */
export const renewsOnItsOwn = {
  OR: [{ relationshipType: null }, { relationshipType: { notIn: ['amendment', 'exhibit_only'] } }],
}
