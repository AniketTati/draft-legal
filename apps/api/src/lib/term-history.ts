/**
 * docs/41 Part 13 — a contract's term values over time (ContractTermValue).
 *
 * The roll-up (field-store applyAmendmentValues, docs/39 G3) sets the
 * amendment's value on the parent and keeps the old one only for its undo.
 * Lawyers need the original one click away for as long as the contract
 * lives ("Show amended values"): here each roll-up records the value it
 * replaced (the contract's own, the first time) and the new one, the old
 * marked superseded by the new. An undo takes the amendment's rows out and
 * makes the value before it current again.
 */
import type { Prisma } from '@prisma/client'
import { familyLabel } from '@clm/types'
import { prisma } from './prisma.js'

type Db = Prisma.TransactionClient | typeof prisma

export interface RolledUpValue {
  key: string
  label: string
  before: { value: unknown; display: string; quote?: string | null } | null
  after: { value: unknown; display: string; quote?: string | null }
}

const json = (v: unknown) => (v === undefined ? null : v) as Prisma.InputJsonValue

/** Record what a roll-up from `amendmentId` changed on `contractId`. */
export async function recordRollUp(input: {
  orgId: string; contractId: string; amendmentId: string; values: RolledUpValue[]
  effectiveFrom: Date | null; originalFrom: Date | null; userId: string | null
}, db: Db = prisma): Promise<number> {
  let n = 0
  const now = new Date()
  for (const v of input.values) {
    const current = await db.contractTermValue.findFirst({
      where: { orgId: input.orgId, contractId: input.contractId, key: v.key, supersededById: null },
      orderBy: { createdAt: 'desc' },
    })
    // The first roll-up of a term keeps the contract's own value as the original.
    const prior = current ?? (v.before ? await db.contractTermValue.create({
      data: {
        orgId: input.orgId, contractId: input.contractId, key: v.key, label: v.label,
        value: json(v.before.value), display: v.before.display, quote: v.before.quote ?? null,
        sourceContractId: null, effectiveFrom: input.originalFrom, createdById: input.userId,
      },
    }) : null)
    const next = await db.contractTermValue.create({
      data: {
        orgId: input.orgId, contractId: input.contractId, key: v.key, label: v.label,
        value: json(v.after.value), display: v.after.display, quote: v.after.quote ?? null,
        sourceContractId: input.amendmentId, effectiveFrom: input.effectiveFrom, createdById: input.userId,
      },
    })
    if (prior) await db.contractTermValue.update({ where: { id: prior.id }, data: { supersededById: next.id, supersededAt: now } })
    n++
  }
  return n
}

/** An undone roll-up: its values come out, and what they replaced is current again. */
export async function undoRollUp(orgId: string, contractId: string, amendmentId: string, keys: string[], db: Db = prisma): Promise<number> {
  const rows = await db.contractTermValue.findMany({ where: { orgId, contractId, sourceContractId: amendmentId, key: { in: keys } }, select: { id: true } })
  if (!rows.length) return 0
  const ids = rows.map(r => r.id)
  await db.contractTermValue.updateMany({ where: { orgId, contractId, supersededById: { in: ids } }, data: { supersededById: null, supersededAt: null } })
  await db.contractTermValue.deleteMany({ where: { id: { in: ids } } })
  // An original left alone, with nothing after it, is just the field's own value again.
  await db.contractTermValue.deleteMany({ where: { orgId, contractId, key: { in: keys }, sourceContractId: null, supersededById: null } })
  return ids.length
}

export interface TermHistoryEntry {
  id: string
  value: unknown
  display: string
  quote: string | null
  source: { contractId: string; title: string; label: string | null } | null
  effectiveFrom: string | null
  current: boolean
}

/** Each amended term's values, oldest first; the current one last. */
export async function termHistory(orgId: string, contractId: string): Promise<Record<string, { label: string | null; values: TermHistoryEntry[] }>> {
  const rows = await prisma.contractTermValue.findMany({ where: { orgId, contractId }, orderBy: { createdAt: 'asc' } })
  const sources = [...new Set(rows.map(r => r.sourceContractId).filter((x): x is string => !!x))]
  const named = sources.length
    ? await prisma.contract.findMany({ where: { orgId, id: { in: sources } }, select: { id: true, title: true, relationshipType: true, amendmentNumber: true } })
    : []
  const out: Record<string, { label: string | null; values: TermHistoryEntry[] }> = {}
  for (const r of rows) {
    const s = r.sourceContractId ? named.find(n => n.id === r.sourceContractId) : null
    const entry: TermHistoryEntry = {
      id: r.id, value: r.value, display: r.display, quote: r.quote,
      source: s ? { contractId: s.id, title: s.title, label: familyLabel(s.relationshipType, s.amendmentNumber) } : null,
      effectiveFrom: r.effectiveFrom?.toISOString().slice(0, 10) ?? null,
      current: !r.supersededById,
    }
    ;(out[r.key] ??= { label: r.label, values: [] }).values.push(entry)
  }
  return out
}
