/**
 * docs/41 Part 14 — a contract's renewal terms as columns of their own:
 * renewalType, renewalTermMonths, noticeDays, noticeDeadline,
 * optOutWindowStart, priceUpliftCap and renewalConfirmed.
 *
 * They lived only in extracted keyTerms, so every reader worked the notice
 * deadline out again (and a list could not sort or filter by it). The values
 * themselves stay in the field store, read with their words and confirmed by
 * people (docs/39); these columns are worked out from them here, with the
 * contract's signed amendments and renewals applied (renewal-notice.ts), and
 * rewritten whenever a value or an amendment changes:
 *
 *   - field-store commit → syncRenewalTerms (the contract, and its parent
 *     when it is an amendment or renewal);
 *   - an amendment or renewal signed or ended (lifecycle transition);
 *   - scripts/backfill-renewal-terms.ts for contracts that predate them.
 *
 * `renewalConfirmed` is true when every renewal value the contract has was set
 * or checked by a person (isLocked), so screens can say "from the AI, not
 * checked" next to a deadline people will diarise against.
 */
import type { Prisma } from '@prisma/client'
import { subtractDuration, type DurationValue, type RenewalType } from '@clm/types'
import { prisma } from './prisma.js'
import { amendedRenewalNotice, asDuration, TERM_CHANGERS, type TermChanger } from './renewal-notice.js'

type Db = Prisma.TransactionClient | typeof prisma

/** The field-store keys the renewal columns are worked out from. */
export const RENEWAL_FIELD_KEYS = ['renewalType', 'autoRenew', 'renewalTerm', 'nonRenewalNotice', 'noticePeriodDays', 'optOutWindow', 'priceUpliftCap'] as const

export interface RenewalColumns {
  renewalType: RenewalType | null
  renewalTermMonths: number | null
  noticeDays: number | null
  noticeDeadline: Date | null
  optOutWindowStart: Date | null
  priceUpliftCap: number | null
  renewalConfirmed: boolean
}

const termsOf = (keyTerms: unknown): Record<string, unknown> =>
  keyTerms && typeof keyTerms === 'object' && !Array.isArray(keyTerms) ? keyTerms as Record<string, unknown> : {}

/** A duration in whole months ("1 year" → 12, "90 days" → 3). */
export function monthsIn(d: DurationValue | null): number | null {
  if (!d) return null
  const m = d.unit === 'months' ? d.value : d.unit === 'years' ? d.value * 12 : d.unit === 'weeks' ? d.value * 7 / 30 : d.value / 30
  const r = Math.round(m)
  return r > 0 ? r : null
}

const percent = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[%\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The latest signed changer's value for a key, else the contract's own. */
function amendedValue(base: Record<string, unknown>, changers: TermChanger[], key: string): unknown {
  let v = base[key]
  const signed = changers
    .filter(a => a.relationshipType != null && TERM_CHANGERS.includes(a.relationshipType) && a.status === 'EXECUTED')
    .sort((a, b) => (a.effectiveDate ?? a.createdAt).getTime() - (b.effectiveDate ?? b.createdAt).getTime())
  for (const a of signed) {
    const kt = termsOf(a.keyTerms)
    if (kt[key] != null && kt[key] !== '') v = kt[key]
  }
  return v
}

/**
 * The renewal columns for a contract (pure). `locked` lists, per renewal key
 * the contract has a value for, whether a person set or checked it.
 */
export function renewalColumns(
  c: { expiryDate: Date | null; keyTerms: unknown },
  changers: TermChanger[] = [],
  locked: Array<{ key: string; locked: boolean }> = [],
): RenewalColumns {
  const base = termsOf(c.keyTerms)
  // Worked out from the values, never from the stored columns themselves.
  const n = amendedRenewalNotice({ expiryDate: c.expiryDate, keyTerms: c.keyTerms }, changers)
  const optOut = asDuration(amendedValue(base, changers, 'optOutWindow'))
  const renews = n.renewalType === 'auto' || n.renewalType === 'manual'
  const present = locked.filter(l => (RENEWAL_FIELD_KEYS as readonly string[]).includes(l.key))
  return {
    renewalType: n.renewalType,
    renewalTermMonths: monthsIn(asDuration(amendedValue(base, changers, 'renewalTerm'))),
    noticeDays: n.noticeDays,
    noticeDeadline: n.deadline,
    optOutWindowStart: renews && optOut && c.expiryDate ? subtractDuration(c.expiryDate, optOut) : null,
    priceUpliftCap: percent(amendedValue(base, changers, 'priceUpliftCap')),
    renewalConfirmed: present.length > 0 && present.every(l => l.locked),
  }
}

const sameDay = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null)

function changed(now: RenewalColumns, was: RenewalColumns): boolean {
  return now.renewalType !== was.renewalType || now.renewalTermMonths !== was.renewalTermMonths
    || now.noticeDays !== was.noticeDays || !sameDay(now.noticeDeadline, was.noticeDeadline)
    || !sameDay(now.optOutWindowStart, was.optOutWindowStart) || now.priceUpliftCap !== was.priceUpliftCap
    || now.renewalConfirmed !== was.renewalConfirmed
}

const SYNC_SELECT = {
  id: true, orgId: true, parentContractId: true, relationshipType: true, expiryDate: true, keyTerms: true,
  renewalType: true, renewalTermMonths: true, noticeDays: true, noticeDeadline: true,
  optOutWindowStart: true, priceUpliftCap: true, renewalConfirmed: true,
} as const

/**
 * Rewrite one contract's renewal columns from its values and its signed
 * amendments and renewals. Writes only when something moved, and leaves
 * updatedAt alone (a sync changes no term people set). The columns it wrote,
 * or null when the contract isn't in the org.
 */
export async function syncRenewalTerms(orgId: string, contractId: string, db: Db = prisma): Promise<RenewalColumns | null> {
  const c = await db.contract.findFirst({ where: { id: contractId, orgId }, select: { ...SYNC_SELECT, updatedAt: true } })
  if (!c) return null
  const [changers, rows] = await Promise.all([
    db.contract.findMany({
      where: { orgId, parentContractId: c.id, deletedAt: null, relationshipType: { in: TERM_CHANGERS } },
      select: { title: true, relationshipType: true, status: true, keyTerms: true, effectiveDate: true, createdAt: true },
    }),
    db.contractFieldValue.findMany({
      where: { contractId: c.id, fieldKey: { in: [...RENEWAL_FIELD_KEYS] } },
      select: { fieldKey: true, value: true, source: true, verifiedAt: true },
    }),
  ])
  // The store's rule (field-store isLocked): a person's value, or one a person checked.
  const locked = rows.filter(r => r.value !== null).map(r => ({ key: r.fieldKey, locked: (r.source !== 'ai' && r.source !== 'calculated') || r.verifiedAt !== null }))
  const now = renewalColumns(c, changers, locked)
  const was: RenewalColumns = {
    renewalType: (c.renewalType as RenewalType | null) ?? null, renewalTermMonths: c.renewalTermMonths, noticeDays: c.noticeDays,
    noticeDeadline: c.noticeDeadline, optOutWindowStart: c.optOutWindowStart, priceUpliftCap: c.priceUpliftCap, renewalConfirmed: c.renewalConfirmed,
  }
  if (changed(now, was)) {
    await db.contract.update({ where: { id: c.id }, data: { ...now, updatedAt: c.updatedAt } })
  }
  return now
}

/**
 * A contract's values changed: its own columns, and its parent's when it is
 * an amendment or renewal (the parent's deadline follows a signed one).
 */
export async function syncRenewalTermsFor(orgId: string, contractId: string, db: Db = prisma): Promise<void> {
  await syncRenewalTerms(orgId, contractId, db)
  const c = await db.contract.findFirst({ where: { id: contractId, orgId }, select: { parentContractId: true, relationshipType: true } })
  if (c?.parentContractId && c.relationshipType && TERM_CHANGERS.includes(c.relationshipType)) {
    await syncRenewalTerms(orgId, c.parentContractId, db)
  }
}
