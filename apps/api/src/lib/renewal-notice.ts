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

export function renewalNotice(c: { expiryDate: Date | null; keyTerms: unknown }): RenewalNotice {
  const kt = (c.keyTerms && typeof c.keyTerms === 'object' && !Array.isArray(c.keyTerms))
    ? c.keyTerms as Record<string, unknown>
    : null
  const autoRenew  = isAutoRenew(kt)
  const noticeDays = noticeDaysOf(kt)
  const deadline   = autoRenew && noticeDays != null && c.expiryDate
    ? new Date(c.expiryDate.getTime() - noticeDays * DAY_MS)
    : null
  return { autoRenew, noticeDays, deadline }
}
