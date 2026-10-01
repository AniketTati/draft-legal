/**
 * docs/41 Part 18 — the moves dates make, once a day (the renewal scan's job,
 * workers/scan.worker.ts, and POST /cron/renewal-scan):
 *   - Active → Expiring, within EXPIRING_DAYS of its expiry date;
 *   - past its expiry date: Closed · Expired, or Active · Renewed
 *     automatically when it renews on its own (keyTerms.autoRenew);
 *   - Closed · Expired with an expiry date in the future again (renewed,
 *     extended by an amendment) → Active.
 * Each move goes through lib/lifecycle.ts, so it is on the record and
 * subscribers hear of it. Amendments and exhibits follow their parent, not
 * dates of their own.
 */
import { prisma } from './prisma.js'
import { transition } from './lifecycle.js'
import { isAutoRenew, renewsOnItsOwn } from './renewal-notice.js'

/** How far ahead an expiry makes a contract "expiring". */
export const EXPIRING_DAYS = 30

export type DateMove = 'expiring' | 'expired' | 'auto_renewed' | 'reactivated'

/** The move a contract's dates call for today, or null. Pure. */
export function dateMove(c: { stage: string; stageState: string; expiryDate: Date | null; autoRenew: boolean }, now: Date = new Date()): DateMove | null {
  if (!c.expiryDate) return null
  const ms = c.expiryDate.getTime() - now.getTime()
  if (c.stage === 'active') {
    if (ms <= 0) {
      if (!c.autoRenew) return 'expired'
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
  const moved: Record<DateMove, number> = { expiring: 0, expired: 0, auto_renewed: 0, reactivated: 0 }
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
    select: { id: true, orgId: true, stage: true, stageState: true, expiryDate: true, keyTerms: true },
    take: 5000,
  })
  for (const c of rows) {
    const move = dateMove({ ...c, autoRenew: isAutoRenew(c.keyTerms as Record<string, unknown> | null) }, now)
    if (!move) continue
    const to = move === 'expired' ? { stage: 'closed' as const, state: 'expired' as const }
      : move === 'reactivated' ? { stage: 'active' as const, state: 'active' as const }
      : { stage: 'active' as const, state: move }
    const r = await transition({
      orgId: c.orgId, contractId: c.id, to, source: 'dates',
      reason: move === 'expiring' ? `it expires on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'expired' ? `it expired on ${c.expiryDate!.toISOString().slice(0, 10)}`
        : move === 'auto_renewed' ? 'it renewed on its own at its expiry date'
        : `its expiry date is ${c.expiryDate!.toISOString().slice(0, 10)} now`,
    })
    if (r.ok && r.changed) moved[move]++
    else if (!r.ok) errors.push(`${c.id}: ${r.refusal}`)
  }
  return { scanned: rows.length, moved, errors }
}
