/**
 * docs/39 A8 — the companies the org signs as (Settings › Our entities), and
 * the contracts that name one of them as the counterparty.
 *
 * The counterparty picker knew only the org's own name, so a contract signed
 * through a subsidiary ("Acme UK Ltd" for Acme, Inc.) came back with our own
 * subsidiary as the other party — and its address as theirs. The org now
 * lists the names it signs as; the extraction is told them (extraction-job),
 * the contract's page flags a counterparty that is one of them, and the
 * contracts analysed before the list can be put right in one go: the other
 * party becomes the counterparty wherever there is exactly one, as one run a
 * person can undo (field-runs).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { mergeOrgSettings } from './org-settings.js'
import { compactKey, isPlaceholderName } from './company-names.js'
import { ourNames, isOurs, MAX_OUR_ENTITIES } from './counterparty-directory.js'
import { applyExtraction } from './field-store.js'
import { recordRun, type RunChange } from './field-runs.js'
import { reindexContract } from './elasticsearch.js'

/** The list as saved: tidied, one name per company, never the org's own name, at most MAX. */
export function cleanEntities(orgName: string, names: readonly string[]): string[] {
  const seen = new Set([compactKey(orgName)])
  const out: string[] = []
  for (const raw of names) {
    const n = String(raw ?? '').replace(/\s+/g, ' ').trim()
    const k = compactKey(n)
    if (!n || !k || seen.has(k) || isPlaceholderName(n)) continue
    seen.add(k)
    out.push(n)
  }
  return out.slice(0, MAX_OUR_ENTITIES)
}

/** Save the list; returns it as saved. */
export async function saveEntities(orgId: string, names: readonly string[]): Promise<string[]> {
  const { orgName } = await ourNames(orgId)
  const clean = cleanEntities(orgName, names)
  await mergeOrgSettings(orgId, { ourEntities: clean })
  return clean
}

/** The parties a contract names that aren't us, once each. */
export function otherParties(keyTerms: unknown, ours: readonly string[]): string[] {
  const kt = keyTerms && typeof keyTerms === 'object' && !Array.isArray(keyTerms) ? keyTerms as Record<string, unknown> : {}
  const parties = Array.isArray(kt.parties) ? kt.parties : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parties) {
    const name = typeof p === 'string' ? p : p && typeof p === 'object' ? String((p as { name?: unknown }).name ?? '') : ''
    const n = name.trim()
    const k = compactKey(n)
    if (!n || !k || seen.has(k) || isPlaceholderName(n) || isOurs(n, [...ours])) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

export interface NamingUs {
  id: string
  title: string
  counterpartyName: string
  /** The other parties it names: exactly one can be put right without a person. */
  others: string[]
}

interface NamingUsRow extends NamingUs { partiesEvidence: Record<string, unknown> }

async function namingUs(orgId: string, where: Prisma.ContractWhereInput, limit: number): Promise<{ rows: NamingUsRow[]; total: number }> {
  const { all } = await ourNames(orgId)
  const grouped = await prisma.contract.groupBy({
    by: ['counterpartyName'],
    where: { ...where, orgId, deletedAt: null, counterpartyName: { not: null } },
    _count: { _all: true },
  })
  const hits = grouped.filter(g => isOurs(g.counterpartyName, all))
  if (!hits.length) return { rows: [], total: 0 }
  const contracts = await prisma.contract.findMany({
    where: { ...where, orgId, deletedAt: null, counterpartyName: { in: hits.map(h => h.counterpartyName!) } },
    select: { id: true, title: true, counterpartyName: true, keyTerms: true, fieldConfidence: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return {
    total: hits.reduce((n, h) => n + h._count._all, 0),
    rows: contracts.map(c => {
      const fc = c.fieldConfidence && typeof c.fieldConfidence === 'object' ? c.fieldConfidence as Record<string, unknown> : {}
      const ev = fc.parties && typeof fc.parties === 'object' ? fc.parties as Record<string, unknown> : {}
      return { id: c.id, title: c.title, counterpartyName: c.counterpartyName!, others: otherParties(c.keyTerms, all), partiesEvidence: ev }
    }),
  }
}

/** Contracts (in scope) whose counterparty is one of ours: how many, and the first of them. */
export async function contractsNamingUs(orgId: string, where: Prisma.ContractWhereInput, limit = 500): Promise<{ contracts: NamingUs[]; total: number; fixable: number }> {
  const { rows, total } = await namingUs(orgId, where, limit)
  return {
    total,
    fixable: rows.filter(r => r.others.length === 1).length,
    contracts: rows.map(({ partiesEvidence: _ev, ...c }) => c),
  }
}

/** At most this many contracts put right per press. */
export const PICK_MAX = 500

/**
 * The other party as the counterparty on each contract (in scope) that names
 * one of ours and exactly one other party, where the AI set it (a person's
 * value stays theirs to change); the address the AI read for our company is
 * cleared, saying why. One run, undoable for 30 days.
 */
export async function pickOtherParty(input: { orgId: string; userId: string; where: Prisma.ContractWhereInput }): Promise<{ fixed: number; left: NamingUs[]; runId: string | null }> {
  const { rows } = await namingUs(input.orgId, input.where, PICK_MAX)
  const changes: RunChange[] = []
  const left: NamingUs[] = []
  let fixed = 0
  for (const { partiesEvidence: ev, ...c } of rows) {
    if (c.others.length !== 1) { left.push(c); continue }
    const named = await applyExtraction(c.id, [{
      key: 'counterpartyName', kind: 'core', value: c.others[0],
      confidence: typeof ev.confidence === 'number' ? ev.confidence : null,
      quote: typeof ev.quote === 'string' ? ev.quote : null,
      section: typeof ev.section === 'string' ? ev.section : null,
    }], { mode: 'replace_ai' })
    if (!named?.written.includes('counterpartyName')) { left.push(c); continue }
    // Read with our company as the counterparty, the address is ours: cleared,
    // saying why (only when there is one — an empty field needs no note).
    const had = await prisma.contractFieldValue.findFirst({
      where: { orgId: input.orgId, contractId: c.id, fieldKey: 'counterpartyAddress' },
      select: { value: true },
    })
    const address = had?.value != null ? await applyExtraction(c.id, [{
      key: 'counterpartyAddress', kind: 'core', value: null, confidence: 1,
      issue: `This was the address of ${c.counterpartyName}, one of your companies, read when it was taken for the counterparty. Enter ${c.others[0]}'s address.`,
    }], { mode: 'replace_ai' }) : null
    reindexContract(c.id).catch(err => console.warn('[our-entities] re-index failed contractId=%s: %s', c.id, (err as Error).message))
    fixed++
    changes.push(...[...named.changes, ...(address?.changes ?? [])].map(ch => ({ ...ch, contractId: c.id })))
  }
  const runId = changes.length ? await recordRun({ orgId: input.orgId, kind: 'counterparty', changes, createdById: input.userId }) : null
  return { fixed, left, runId }
}
