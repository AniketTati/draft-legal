/**
 * docs/41 Part 14 — a contract's renewal as GET /contracts/:id/renewal sends
 * it: its terms, the notice deadline, the window, the standing decision and
 * what each choice does.
 */
export type RenewalDecisionKind = 'renew' | 'renegotiate' | 'let_lapse' | 'terminate'

export interface RenewalState {
  contractId: string
  stage: string
  expiryDate: string | null
  terms: {
    renewalType: 'auto' | 'manual' | 'evergreen' | 'none' | null
    renewalTermMonths: number | null
    noticeDays: number | null
    noticeDeadline: string | null
    optOutWindowStart: string | null
    priceUpliftCap: number | null
    confirmed: boolean
  }
  daysToDeadline: number | null
  inWindow: boolean
  canDecide: boolean
  decision: {
    id: string
    decision: RenewalDecisionKind | string
    label: string
    reason: string | null
    decidedBy: string | null
    decidedAt: string
    decidedInTime: boolean | null
    noticeSentAt: string | null
    noticeSentInTime: boolean | null
    actionContract: { id: string; title: string; status: string; stage: string } | null
  } | null
  choices: Array<{ decision: RenewalDecisionKind; label: string; effect: string }>
  history: Array<{ decision: string; decidedBy: string | null; decidedAt: string; reason: string | null }>
}

export const renewalKey = (contractId: string) => ['contract-renewal', contractId] as const

export const RENEWAL_TYPE_WORDS: Record<string, string> = {
  auto: 'Renews automatically',
  manual: 'Renews only if both agree',
  evergreen: 'Runs until ended',
  none: 'Doesn’t renew',
}

/** "12 Mar 2027". */
export const dayWords = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null

/** "Last day to give notice: 2 Oct 2026 (in 12 days)". */
export function deadlineWords(s: Pick<RenewalState, 'terms' | 'daysToDeadline'>): string | null {
  if (!s.terms.noticeDeadline) return null
  const d = s.daysToDeadline
  const when = d == null ? '' : d < 0 ? ` (${-d} days ago)` : d === 0 ? ' (today)' : ` (in ${d} days)`
  return `Last day to give notice: ${dayWords(s.terms.noticeDeadline)}${when}`
}

/** A decision not to renew, whose notice is still to be marked sent. */
export const noticeOutstanding = (s: RenewalState) =>
  !!s.decision && (s.decision.decision === 'let_lapse' || s.decision.decision === 'terminate') && !s.decision.noticeSentAt

/** "Notice sent 1 Oct 2026, before the deadline" — or late, after it. */
export function noticeSentWords(d: Pick<NonNullable<RenewalState['decision']>, 'noticeSentAt' | 'noticeSentInTime'>): string | null {
  if (!d.noticeSentAt) return null
  const when = d.noticeSentInTime === false ? ', after the deadline (late)' : d.noticeSentInTime ? ', before the deadline' : ''
  return `Notice sent ${dayWords(d.noticeSentAt)}${when}`
}
