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
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The notice period in whole days, across every spelling the codebase writes
 * (extraction: noticePeriodDays; review-queue corrections: noticePeriod as
 * "90 days"; seeds: renewalNoticeDays / noticeDays) and both shapes (90 or
 * "90 days"). Only a leading integer counts: "30-60 days" would be a guess
 * about which bound binds, and people diarise against this date.
 */
export function noticeDaysOf(kt: Record<string, unknown> | null | undefined): number | null {
  if (!kt) return null
  for (const raw of [kt.noticeDays, kt.noticePeriodDays, kt.renewalNoticeDays, kt.noticePeriod]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
    if (typeof raw === 'string') {
      const m = raw.trim().match(/^(\d+)\s*(?:days?|d)?\s*$/i)
      if (m) {
        const n = Number(m[1])
        if (n > 0) return n
      }
    }
  }
  return null
}

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
  /** Notice-to-terminate period in days; null when not extracted. */
  noticeDays: number | null
  /** expiry − noticeDays; null unless auto-renewing with both known. */
  deadline:   Date | null
}

const termsOf = (keyTerms: unknown): Record<string, unknown> | null =>
  keyTerms && typeof keyTerms === 'object' && !Array.isArray(keyTerms) ? keyTerms as Record<string, unknown> : null

const deadlineOf = (expiryDate: Date | null, autoRenew: boolean, noticeDays: number | null) =>
  autoRenew && noticeDays != null && expiryDate ? new Date(expiryDate.getTime() - noticeDays * DAY_MS) : null

export function renewalNotice(c: { expiryDate: Date | null; keyTerms: unknown }): RenewalNotice {
  const kt = termsOf(c.keyTerms)
  const autoRenew  = isAutoRenew(kt)
  const noticeDays = noticeDaysOf(kt)
  return { autoRenew, noticeDays, deadline: deadlineOf(c.expiryDate, autoRenew, noticeDays) }
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
 * one that states a notice period, or whether the contract auto-renews,
 * wins. From the original period alone the deadline was wrong everywhere it
 * showed once an amendment changed it (Databricks: 30 → 60 days moved it
 * from 14 Nov to 15 Oct). `noticeSetBy` names the amendment that set it.
 */
export function amendedRenewalNotice(
  c: { expiryDate: Date | null; keyTerms: unknown },
  changers: TermChanger[] = [],
): RenewalNotice & { noticeSetBy: string | null } {
  let { autoRenew, noticeDays } = renewalNotice(c)
  let noticeSetBy: string | null = null
  const inOrder = changers
    .filter(a => a.relationshipType != null && TERM_CHANGERS.includes(a.relationshipType) && a.status === 'EXECUTED')
    .sort((a, b) => (a.effectiveDate ?? a.createdAt).getTime() - (b.effectiveDate ?? b.createdAt).getTime())
  for (const a of inOrder) {
    const kt = termsOf(a.keyTerms)
    const days = noticeDaysOf(kt)
    if (days != null) { noticeDays = days; noticeSetBy = a.title }
    // An amendment silent on auto-renewal leaves it as it was.
    if (kt?.autoRenew != null && kt.autoRenew !== '') autoRenew = isAutoRenew(kt)
  }
  return { autoRenew, noticeDays, deadline: deadlineOf(c.expiryDate, autoRenew, noticeDays), noticeSetBy }
}

/**
 * Where-fragment for renewal views: the contracts that renew on their own.
 * An amendment or an exhibit renews with the contract it belongs to, so it
 * is not a renewal of its own (it was listed beside its parent, with the
 * parent's expiry). A SOW, order form or renewal under a parent has its own
 * term and stays, as does a link of no stated kind. (Null is spelled out:
 * `notIn` alone would drop it.)
 */
export const renewsOnItsOwn = {
  OR: [{ relationshipType: null }, { relationshipType: { notIn: ['amendment', 'exhibit_only'] } }],
}
