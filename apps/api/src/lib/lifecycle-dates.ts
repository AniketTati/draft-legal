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
import { isAutoRenew, renewsOnItsOwn } from './renewal-notice.js'
import { renewalTypeOf } from '@clm/types'

/** How far ahead an expiry makes a contract "expiring". */
export const EXPIRING_DAYS = 30

export type DateMove = 'expiring' | 'expired' | 'terminated' | 'auto_renewed' | 'reactivated'

/** The move a contract's dates call for today, or null. Pure. */
export function dateMove(c: { stage: string; stageState: string; expiryDate: Date | null; autoRenew: boolean; ending?: 'let_lapse' | 'terminate' | null }, now: Date = new Date()): DateMove | null {
  if (!c.expiryDate) return null
  const ms = c.expiryDate.getTime() - now.getTime()
  if (c.stage === 'active') {
    if (ms <= 0) {
      if (c.ending === 'terminate') return 'terminated'
      if (!c.autoRenew || c.ending === 'let_lapse') return 'expired'
      return c.stageState === 'auto_renewed' ? null : 'auto_renewed'
    }
    if (ms <= EXPIRING_DAYS * 86_400_000 && c.stageState === 'active') return 'expiring'
    return null
  }
  if (c.stage === 'closed' && c.stageState === 'expired' && ms > 0) return 'reactivated'
  return null
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
    select: { id: true, orgId: true, stage: true, stageState: true, expiryDate: true, keyTerms: true, renewalType: true },
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
    const move = dateMove({ ...c, autoRenew, ending: endings.get(c.id) ?? null }, now)
    if (!move) continue
    const to = move === 'expired' ? { stage: 'closed' as const, state: 'expired' as const }
      : move === 'terminated' ? { stage: 'closed' as const, state: 'terminated' as const }
      : move === 'reactivated' ? { stage: 'active' as const, state: 'active' as const }
      : { stage: 'active' as const, state: move }
    const r = await transition({
      orgId: c.orgId, contractId: c.id, to, source: 'dates',
      reason: move === 'expiring' ? `it expires on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'expired' ? `it expired on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'terminated' ? `it ended on ${c.expiryDate!.toISOString().slice(0, 10)}, as we gave notice`
        : move === 'auto_renewed' ? 'it renewed on its own at its expiry date'
        : `its expiry date is ${c.expiryDate!.toISOString().slice(0, 10)} now`,
    })
    if (r.ok && r.changed) moved[move]++
    else if (!r.ok) errors.push(`${c.id}: ${r.refusal}`)
  }
  return { scanned: rows.length, moved, errors }
}
