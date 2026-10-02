/**
 * docs/39 A14 — a contract's counterparty linked to the directory entry for
 * that company, by any name the company goes by; A8 — the org's own
 * companies, which are never the counterparty.
 *
 * A contract carried a counterparty name and, only when someone picked it
 * from the directory, a link; the directory then found a company's contracts
 * by the link or by the identical name. "Acme Corp." on one contract and
 * "ACME CORPORATION, INC." on the next never reached Acme's page. Now:
 *
 *   - whenever a contract's counterparty name is written (extraction, a
 *     person, a template, an undo) the field store links it here to the entry
 *     that has that name among its names (company-names.ts decides "same");
 *   - an entry created, renamed or given another name links the contracts
 *     that name it and were linked to nothing;
 *   - a name close to an entry's but not the same ("Acme Holdings") is only
 *     offered to a person, who can link it (the name becomes an alias, so the
 *     next contract links itself) or add the company;
 *   - the org's own names (its name and Settings › Our entities) tell the
 *     extraction which party is us, and flag a counterparty that is one of them.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { compactKey, companySimilarity, isPlaceholderName, isOurs, SIMILAR } from './company-names.js'

type Db = PrismaClient | Prisma.TransactionClient

export interface DirectoryEntry {
  id: string
  name: string
  legalName: string | null
  aliases: string[]
}

const ENTRY_SELECT = { id: true, name: true, legalName: true, aliases: true } as const

/** The org's live directory entries, with every name each goes by. */
export async function loadDirectory(db: Db, orgId: string): Promise<DirectoryEntry[]> {
  return db.counterparty.findMany({ where: { orgId, deletedAt: null }, select: ENTRY_SELECT })
}

/** Every name an entry goes by. */
export function namesOf(e: Pick<DirectoryEntry, 'name' | 'legalName' | 'aliases'>): string[] {
  return [e.name, e.legalName ?? '', ...(e.aliases ?? [])].filter(n => n.trim())
}

/** The entry that has this name among its names. */
export function exactEntry(name: string | null | undefined, entries: DirectoryEntry[]): DirectoryEntry | null {
  const k = compactKey(name)
  if (!k || isPlaceholderName(name)) return null
  return entries.find(e => namesOf(e).some(n => compactKey(n) === k)) ?? null
}

export interface SimilarEntry { id: string; name: string; score: number }

/** Entries close to this name but not the same company, most alike first. */
export function similarEntries(name: string | null | undefined, entries: DirectoryEntry[], limit = 3): SimilarEntry[] {
  if (!name || isPlaceholderName(name)) return []
  return entries
    .map(e => ({ id: e.id, name: e.name, score: Math.max(...namesOf(e).map(n => companySimilarity(name, n))) }))
    .filter(s => s.score >= SIMILAR && s.score < 1)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * The entry a contract naming `name` links to: the one with that name; else
 * the one it is linked to now, when the name is still close to it (a person
 * linked "Acme Holdings" to Acme; the AI now reads "Acme Holdings UK"); else
 * none.
 */
export async function counterpartyIdFor(db: Db, orgId: string, name: string | null | undefined, currentId: string | null): Promise<string | null> {
  if (!name || isPlaceholderName(name)) return null
  const entries = await loadDirectory(db, orgId)
  const exact = exactEntry(name, entries)
  if (exact) return exact.id
  const current = currentId ? entries.find(e => e.id === currentId) : undefined
  if (current && namesOf(current).some(n => companySimilarity(name, n) >= SIMILAR)) return current.id
  return null
}

/**
 * Link every contract that names this entry and is linked to nothing (or to
 * a deleted entry). Leaves `updatedAt` alone: nothing about the contract
 * changed. Returns how many it linked.
 */
export async function linkContractsTo(db: Db, orgId: string, entry: DirectoryEntry): Promise<number> {
  const keys = new Set(namesOf(entry).map(n => compactKey(n)).filter(Boolean))
  if (!keys.size) return 0
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    SELECT DISTINCT c."counterpartyName" AS name FROM contracts c
     WHERE c."orgId" = ${orgId} AND c."deletedAt" IS NULL AND c."counterpartyName" IS NOT NULL
       AND (c."counterpartyId" IS NULL
            OR NOT EXISTS (SELECT 1 FROM counterparties p WHERE p.id = c."counterpartyId" AND p."deletedAt" IS NULL))`
  const names = rows.map(r => r.name).filter(n => !isPlaceholderName(n) && keys.has(compactKey(n)))
  if (!names.length) return 0
  return db.$executeRaw`
    UPDATE contracts c SET "counterpartyId" = ${entry.id}
     WHERE c."orgId" = ${orgId} AND c."deletedAt" IS NULL AND c."counterpartyName" = ANY(${names}::text[])
       AND (c."counterpartyId" IS NULL
            OR NOT EXISTS (SELECT 1 FROM counterparties p WHERE p.id = c."counterpartyId" AND p."deletedAt" IS NULL))`
}

/**
 * Contracts linked to this entry by a name it no longer has (an alias a
 * person took off: "that's a different company"): linked to the entry that
 * has the name now, or to none. Returns how many moved.
 */
export async function relinkDropped(db: Db, orgId: string, entry: DirectoryEntry, removedKeys: ReadonlySet<string>): Promise<number> {
  const keep = new Set(namesOf(entry).map(n => compactKey(n)))
  const rows = await db.contract.findMany({
    where: { orgId, deletedAt: null, counterpartyId: entry.id, counterpartyName: { not: null } },
    select: { counterpartyName: true },
    distinct: ['counterpartyName'],
  })
  // Only names it had and lost: a contract linked by a close name (or by a person's pick) stays.
  const dropped = rows.map(r => r.counterpartyName!).filter(n => removedKeys.has(compactKey(n)) && !keep.has(compactKey(n)))
  if (!dropped.length) return 0
  const others = (await loadDirectory(db, orgId)).filter(e => e.id !== entry.id)
  let moved = 0
  for (const name of dropped) {
    const to = exactEntry(name, others)?.id ?? null
    moved += await db.$executeRaw`
      UPDATE contracts SET "counterpartyId" = ${to}
       WHERE "orgId" = ${orgId} AND "deletedAt" IS NULL AND "counterpartyId" = ${entry.id} AND "counterpartyName" = ${name}`
  }
  return moved
}

/**
 * Names to add to an entry's aliases: those not already among its names
 * (by company, not by spelling), each once.
 */
export function newAliases(entry: Pick<DirectoryEntry, 'name' | 'legalName' | 'aliases'>, names: string[]): string[] {
  const have = new Set(namesOf(entry).map(n => compactKey(n)))
  const out: string[] = []
  for (const raw of names) {
    const n = raw.trim()
    const k = compactKey(n)
    if (!n || !k || isPlaceholderName(n) || have.has(k)) continue
    have.add(k)
    out.push(n)
  }
  return out
}

// ─── Our entities (A8) ────────────────────────────────────────────────────────

/** At most this many names of our own. */
export const MAX_OUR_ENTITIES = 50

/** The names the org signs as: its own name, then Settings › Our entities. */
export async function ourNames(orgId: string, db: Db = prisma): Promise<{ orgName: string; entities: string[]; all: string[] }> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true, settings: true } })
  const raw = (org?.settings as Record<string, unknown> | null)?.ourEntities
  const entities = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string' && !!n.trim()) : []
  const orgName = org?.name ?? ''
  return { orgName, entities, all: [orgName, ...entities].filter(Boolean) }
}

export { isOurs }

// ─── Names on contracts that aren't in the directory ──────────────────────────

/** Of two spellings as common, the one written as a name ("GSK" over "gsk"), then the fuller one. */
function byCase(a: string, b: string): number {
  const lower = (s: string) => (s === s.toLowerCase() ? 1 : 0)
  return lower(a) - lower(b) || b.length - a.length || a.localeCompare(b)
}

export interface UnlinkedGroup {
  /** The company, as compared (compactKey). */
  key: string
  /** How the contracts spell it, most used first. */
  names: string[]
  count: number
  /** An entry with this name (score 1: link them), or the most alike. */
  suggestion: SimilarEntry | null
  /** One of our own names: these contracts have the wrong counterparty. */
  ours: boolean
}

/**
 * Counterparty names on contracts linked to nothing, one group per company,
 * most contracts first: what the Counterparties page offers to add or link.
 * `where` scopes the contracts (own-scope, no diligence rooms).
 */
export async function unlinkedGroups(orgId: string, where: Prisma.ContractWhereInput): Promise<{ groups: UnlinkedGroup[]; contracts: number }> {
  const [entries, ours] = await Promise.all([loadDirectory(prisma, orgId), ourNames(orgId)])
  const live = new Set(entries.map(e => e.id))
  const rows = await prisma.contract.groupBy({
    by: ['counterpartyName', 'counterpartyId'],
    where: { ...where, orgId, deletedAt: null, counterpartyName: { not: null } },
    _count: { _all: true },
  })
  const byKey = new Map<string, { names: Map<string, number>; count: number }>()
  for (const r of rows) {
    const name = r.counterpartyName?.trim()
    if (!name || isPlaceholderName(name) || (r.counterpartyId && live.has(r.counterpartyId))) continue
    const key = compactKey(name)
    if (!key) continue
    const g = byKey.get(key) ?? { names: new Map<string, number>(), count: 0 }
    g.names.set(name, (g.names.get(name) ?? 0) + r._count._all)
    g.count += r._count._all
    byKey.set(key, g)
  }
  const groups: UnlinkedGroup[] = [...byKey.entries()].map(([key, g]) => {
    const names = [...g.names.entries()].sort((a, b) => b[1] - a[1] || byCase(a[0], b[0])).map(([n]) => n)
    const exact = exactEntry(names[0], entries)
    const suggestion = exact ? { id: exact.id, name: exact.name, score: 1 } : similarEntries(names[0], entries, 1)[0] ?? null
    return { key, names, count: g.count, suggestion, ours: isOurs(names[0], ours.all) }
  })
  groups.sort((a, b) => b.count - a.count || a.names[0].localeCompare(b.names[0]))
  return { groups, contracts: groups.reduce((n, g) => n + g.count, 0) }
}
