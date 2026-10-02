/**
 * docs/41 Part 18 — the moves dates make, once a day (the renewal scan's job,
 * workers/scan.worker.ts, and POST /cron/renewal-scan):
 *   - Active → Expiring, within EXPIRING_DAYS of its expiry date;
 *   - past its expiry date: Closed · Expired, or Active · Renewed
 *     automatically when it renews on its own (keyTerms.autoRenew);
 *   - Closed · Expired with an expiry date in the future again (renewed,
 *     extended by an amendment) → Active.
 * docs/41 Part 14 — a decision not to renew whose notice went out stops an
 * automatic renewal: at its end date the contract closes as Expired (let it
 * lapse) or Terminated (end it). Without the notice sent, it renews as the
 * contract says. The renewal type column wins over keyTerms.autoRenew.
 * Each move goes through lib/lifecycle.ts, so it is on the record and
 * subscribers hear of it. Amendments and exhibits follow their parent, not
 * dates of their own.
 */
import { prisma } from './prisma.js'
import { transition } from './lifecycle.js'
import { renewExpiry } from './field-store.js'
import { asDuration, isAutoRenew, renewsOnItsOwn } from './renewal-notice.js'
import { monthsIn } from './renewal-terms.js'
import { addDuration, renewalTypeOf } from '@clm/types'

/** How far ahead an expiry makes a contract "expiring". */
export const EXPIRING_DAYS = 30

export type DateMove = 'expiring' | 'expired' | 'terminated' | 'auto_renewed' | 'reactivated'

/**
 * The move a contract's dates call for today, or null. Pure.
 * `termMonths` — fix-up 16: how long a renewal runs. With it, each renewal
 * moves the expiry on, so the renewed term can expire and renew again;
 * without it the contract is marked renewed once and its date stays.
 */
export function dateMove(c: { stage: string; stageState: string; expiryDate: Date | null; autoRenew: boolean; ending?: 'let_lapse' | 'terminate' | null; termMonths?: number | null }, now: Date = new Date()): DateMove | null {
  if (!c.expiryDate) return null
  const ms = c.expiryDate.getTime() - now.getTime()
  if (c.stage === 'active') {
    if (ms <= 0) {
      if (c.ending === 'terminate') return 'terminated'
      if (!c.autoRenew || c.ending === 'let_lapse') return 'expired'
      return c.stageState === 'auto_renewed' && !c.termMonths ? null : 'auto_renewed'
    }
    // A renewed term nears its end like the first one did.
    if (ms <= EXPIRING_DAYS * 86_400_000 && (c.stageState === 'active' || c.stageState === 'auto_renewed')) return 'expiring'
    return null
  }
  if (c.stage === 'closed' && c.stageState === 'expired' && ms > 0) return 'reactivated'
  return null
}

/**
 * Pure: the expiry an automatic renewal moves to — on by `months` from the
 * old one, as many terms as it takes to be past `now` (a scan that missed a
 * term still lands in the current one), and how many terms that was.
 */
export function renewedExpiry(expiry: Date, months: number, now: Date): { to: Date; renewals: number } {
  // Counted from the old date each time, so a 31st stays the 31st where the month has one.
  let renewals = 0
  let to: Date
  do { renewals++; to = addDuration(expiry, { value: months * renewals, unit: 'months' }) } while (to.getTime() <= now.getTime() && renewals < 100)
  return { to, renewals }
}

/** How long a renewal runs, in months: the renewal term column, else the stated renewal term, else the initial term. */
export function renewalTermOf(c: { renewalTermMonths: number | null; keyTerms: unknown }): { months: number; from: string } | null {
  if (c.renewalTermMonths) return { months: c.renewalTermMonths, from: 'renewal term' }
  const kt = (c.keyTerms && typeof c.keyTerms === 'object' ? c.keyTerms : {}) as Record<string, unknown>
  const stated = monthsIn(asDuration(kt.renewalTerm))
  if (stated) return { months: stated, from: 'renewal term' }
  // "Renews for successive periods of the same length": the initial term.
  const initial = monthsIn(asDuration(kt.initialTerm))
  return initial ? { months: initial, from: 'initial term' } : null
}

export async function scanStageDates(opts: { orgId?: string; now?: Date } = {}): Promise<{ scanned: number; moved: Record<DateMove, number>; errors: string[] }> {
  const now = opts.now ?? new Date()
  const moved: Record<DateMove, number> = { expiring: 0, expired: 0, terminated: 0, auto_renewed: 0, reactivated: 0 }
  const errors: string[] = []
  const horizon = new Date(now.getTime() + EXPIRING_DAYS * 86_400_000)
  const rows = await prisma.contract.findMany({
    where: {
      ...(opts.orgId && { orgId: opts.orgId }),
      deletedAt: null,
      ...renewsOnItsOwn,
      expiryDate: { not: null },
      AND: [{
        OR: [
          { stage: 'active', expiryDate: { lte: horizon } },
          { stage: 'closed', stageState: 'expired', expiryDate: { gt: now } },
        ],
      }],
    },
    select: { id: true, orgId: true, stage: true, stageState: true, expiryDate: true, keyTerms: true, renewalType: true, renewalTermMonths: true },
    take: 5000,
  })
  // Decisions not to renew whose notice went out.
  const endings = new Map((await prisma.renewalDecision.findMany({
    where: { contractId: { in: rows.map(r => r.id) }, supersededAt: null, decision: { in: ['let_lapse', 'terminate'] }, noticeSentAt: { not: null } },
    select: { contractId: true, decision: true },
  })).map(d => [d.contractId, d.decision as 'let_lapse' | 'terminate']))
  for (const c of rows) {
    const type = renewalTypeOf(c.renewalType)
    const autoRenew = type ? type === 'auto' : isAutoRenew(c.keyTerms as Record<string, unknown> | null)
    const term = autoRenew ? renewalTermOf(c) : null
    const move = dateMove({ ...c, autoRenew, ending: endings.get(c.id) ?? null, termMonths: term?.months ?? null }, now)
    if (!move) continue
    // Fix-up 16 — the renewal runs to a new expiry date, which the notice deadline follows.
    const renewed = move === 'auto_renewed' && term ? renewedExpiry(c.expiryDate!, term.months, now) : null
    const day = (d: Date) => d.toISOString().slice(0, 10)
    const to = move === 'expired' ? { stage: 'closed' as const, state: 'expired' as const }
      : move === 'terminated' ? { stage: 'closed' as const, state: 'terminated' as const }
      : move === 'reactivated' ? { stage: 'active' as const, state: 'active' as const }
      : { stage: 'active' as const, state: move }
    const r = await transition({
      orgId: c.orgId, contractId: c.id, to, source: 'dates',
      reason: move === 'expiring' ? `it expires on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'expired' ? `it expired on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'terminated' ? `it ended on ${c.expiryDate!.toISOString().slice(0, 10)}, as we gave notice`
        : move === 'auto_renewed' ? (renewed
          ? `it renewed on its own at its expiry date, ${day(c.expiryDate!)}, for ${term!.months} month${term!.months === 1 ? '' : 's'}: it now runs to ${day(renewed.to)}`
          : 'it renewed on its own at its expiry date')
        : `its expiry date is ${c.expiryDate!.toISOString().slice(0, 10)} now`,
    })
    if (!r.ok) { errors.push(`${c.id}: ${r.refusal}`); continue }
    if (renewed) {
      const done = await renewExpiry({ orgId: c.orgId, contractId: c.id, to: day(renewed.to), months: term!.months, renewals: renewed.renewals, termFrom: term!.from })
      if (!done) errors.push(`${c.id}: its expiry date could not be moved on`)
    }
    if (r.changed || renewed) moved[move]++
  }
  return { scanned: rows.length, moved, errors }
}
