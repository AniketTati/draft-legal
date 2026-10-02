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
import { formatFieldValue, parseDuration, subtractDuration, renewalTypeOf, FOLLOWS_PARENT, type DurationUnit, type DurationValue, type RenewalType } from '@clm/types'

const UNITS = new Set<DurationUnit>(['days', 'weeks', 'months', 'years'])

/**
 * A notice period as stored in any shape the codebase has written: a number
 * of days, "90 days", "3 months", or { value, unit }. Only a single number
 * counts: "30-60 days" would be a guess about which bound binds, and people
 * diarise against this date.
 */
export function asDuration(raw: unknown): DurationValue | null {
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

/**
 * docs/41 Part 14 — how the contract renews, from its terms: the renewal
 * type when it says one, otherwise "auto" when it auto-renews; null when it
 * says neither (a "no" to auto-renewal doesn't say whether it renews by
 * agreement or not at all).
 */
export function renewalTypeOfTerms(kt: Record<string, unknown> | null | undefined): RenewalType | null {
  const t = renewalTypeOf(kt?.renewalType)
  if (t) return t
  return autoRenewFlag(kt) ? 'auto' : null
}

/** keyTerms.autoRenew as a real boolean — a corrected "no" is not auto-renewing. A stated renewal type wins. */
export function isAutoRenew(kt: Record<string, unknown> | null | undefined): boolean {
  const t = renewalTypeOf(kt?.renewalType)
  if (t) return t === 'auto'
  return autoRenewFlag(kt)
}

function autoRenewFlag(kt: Record<string, unknown> | null | undefined): boolean {
  const v = kt?.autoRenew
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['yes', 'true', 'y', '1', 'auto', 'automatic'].includes(v.trim().toLowerCase())
  if (typeof v === 'number') return v === 1
  return false
}

export interface RenewalNotice {
  autoRenew:  boolean
  /** docs/41 Part 14 — auto, manual, evergreen or none; null when the contract doesn't say. */
  renewalType: RenewalType | null
  /** Notice-to-stop-renewal period in whole days; null when not extracted. */
  noticeDays: number | null
  /** The notice as the contract states it: "90 days", "3 months". */
  noticeLabel: string | null
  /**
   * False when the period is one found before notices were told apart:
   * it may be the notice to end early instead. Ask before relying on it.
   */
  noticeConfirmed: boolean
  /**
   * expiry − notice (by the calendar); null unless it renews (automatically,
   * or by agreement: the last day to tell them) with both known.
   */
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
  renewalType: RenewalType | null,
  period: { notice: DurationValue; confirmed: boolean } | null,
): RenewalNotice {
  const renews = renewalType === 'auto' || renewalType === 'manual'
  const deadline = renews && period && expiryDate ? subtractDuration(expiryDate, period.notice) : null
  const noticeDays = period
    ? (expiryDate && deadline ? Math.round((expiryDate.getTime() - deadline.getTime()) / 86_400_000) : daysIn(period.notice))
    : null
  return {
    autoRenew: renewalType === 'auto',
    renewalType,
    noticeDays,
    noticeLabel: period ? formatFieldValue('duration', period.notice) : null,
    noticeConfirmed: period?.confirmed ?? false,
    deadline,
  }
}

export function renewalNotice(c: { expiryDate: Date | null; keyTerms: unknown }): RenewalNotice {
  const kt = termsOf(c.keyTerms)
  return noticeFrom(c.expiryDate, renewalTypeOfTerms(kt), renewalNoticePeriod(kt))
}

/** The linked contracts that change a contract's terms (Contract.amendments of these types). */
export const TERM_CHANGERS = ['amendment', 'renewal']

/**
 * docs/41 Part 14 — the stored renewal columns (lib/renewal-terms.ts keeps
 * them), for a select that feeds amendedRenewalNotice: it reads them first.
 */
export const RENEWAL_COLUMNS = {
  renewalType: true, renewalTermMonths: true, noticeDays: true, noticeDeadline: true,
  optOutWindowStart: true, priceUpliftCap: true, renewalConfirmed: true,
} as const

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
  c: { expiryDate: Date | null; keyTerms: unknown; noticeDeadline?: Date | null; noticeDays?: number | null; renewalType?: string | null },
  changers: TermChanger[] = [],
): RenewalNotice & { noticeSetBy: string | null } {
  const base = termsOf(c.keyTerms)
  let type = renewalTypeOfTerms(base)
  let period = renewalNoticePeriod(base)
  let noticeSetBy: string | null = null
  const inOrder = changers
    .filter(a => a.relationshipType != null && TERM_CHANGERS.includes(a.relationshipType) && a.status === 'EXECUTED')
    .sort((a, b) => (a.effectiveDate ?? a.createdAt).getTime() - (b.effectiveDate ?? b.createdAt).getTime())
  for (const a of inOrder) {
    const kt = termsOf(a.keyTerms)
    const p = renewalNoticePeriod(kt)
    if (p) { period = p; noticeSetBy = a.title }
    // An amendment silent on how it renews leaves it as it was.
    const t = renewalTypeOf(kt?.renewalType)
    if (t) type = t
    else if (kt?.autoRenew != null && kt.autoRenew !== '') type = isAutoRenew(kt) ? 'auto' : (type === 'auto' ? null : type)
  }
  const n = { ...noticeFrom(c.expiryDate, type, period), noticeSetBy }
  // docs/41 Part 14 — the stored columns win (lib/renewal-terms.ts keeps them
  // from the same values, amendments applied); a contract not yet synced is
  // worked out here.
  if (c.noticeDeadline !== undefined && (c.noticeDeadline || c.renewalType)) {
    const ct = renewalTypeOf(c.renewalType)
    return {
      ...n,
      ...(ct ? { renewalType: ct, autoRenew: ct === 'auto' } : {}),
      deadline: c.noticeDeadline ?? null,
      noticeDays: c.noticeDays ?? n.noticeDays,
    }
  }
  return n
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
  OR: [{ relationshipType: null }, { relationshipType: { notIn: [...FOLLOWS_PARENT] } }],
}
