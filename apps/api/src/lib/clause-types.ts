/**
 * docs/39 E3 — clause types an organization teaches the AI.
 *
 * The extraction tagged clauses from a fixed list (@clm/types
 * CLAUSE_TYPE_LABELS). A clause a team cares about that isn't on it — data
 * residency, use of AI, most-favoured-customer pricing — was never found, so
 * never counted, searched or reviewed. Now an organization adds its own: a
 * name, what it is, and passages that are one (at most 20). The extraction
 * looks for it in every contract it reads (the review prompt lists it), a
 * person can tag one (E1), "Try it on a contract" shows what the AI finds
 * before anything is saved, and a run finds it in the contracts read before
 * the type existed.
 */
import { Prisma } from '@prisma/client'
import { CLAUSE_TYPE_LABELS } from '@clm/types'
import { prisma } from './prisma.js'
import { placeClauses, coversClause } from './embeddings.js'
import { CostCapExceededError } from './costCap.js'
import { queueEmbedContract } from './queue.js'

export const CUSTOM_CLAUSE_TYPES_MAX = 25
export const CLAUSE_EXAMPLES_MAX = 20
export const CLAUSE_EXAMPLE_MAX_CHARS = 2000

/** What a run finding a type in the contracts read before it has done. */
export interface DetectState {
  status:    'QUEUED' | 'RUNNING' | 'DONE' | 'PAUSED' | 'FAILED'
  total:     number
  processed: number
  /** Contracts it found the clause in. */
  found:     number
  failed:    number
  cursor:    string | null
  error:     string | null
  startedAt: string
  updatedAt: string
}

export interface ClauseTypeView {
  key:         string
  label:       string
  description: string | null
  examples:    string[]
  custom:      boolean
  id?:         string
  detect?:     DetectState | null
}

/** A custom type's key, from its name: never one of the built-in ones. */
export function customKeyOf(label: string): string {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return `custom_${slug || 'clause'}`
}

export const examplesOf = (raw: unknown): string[] => Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : []

type DefRow = { id: string; key: string; label: string; description: string; examples: unknown; detect: unknown }
const viewOf = (d: DefRow): ClauseTypeView => ({
  id: d.id, key: d.key, label: d.label, description: d.description || null, examples: examplesOf(d.examples), custom: true,
  detect: (d.detect ?? null) as DetectState | null,
})

/** Every clause type the org's contracts can hold: the built-in ones, then its own. */
export async function orgClauseTypes(orgId: string): Promise<ClauseTypeView[]> {
  const custom = await prisma.clauseTypeDefinition.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
  return [
    ...Object.entries(CLAUSE_TYPE_LABELS).map(([key, label]) => ({ key, label, description: null, examples: [], custom: false })),
    ...custom.map(viewOf),
  ]
}

export async function isClauseType(orgId: string, key: string): Promise<boolean> {
  if (Object.hasOwn(CLAUSE_TYPE_LABELS, key)) return true
  return !!await prisma.clauseTypeDefinition.findFirst({ where: { orgId, key, deletedAt: null }, select: { id: true } })
}

/** The org's own types, as the extraction is told of them (review.py CustomClauseType). */
export async function customClauseTypesFor(orgId: string): Promise<Array<{ key: string; label: string; description: string; examples: string[] }>> {
  const rows = await prisma.clauseTypeDefinition.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' }, take: CUSTOM_CLAUSE_TYPES_MAX })
  return rows.map(r => ({ key: r.key, label: r.label, description: r.description, examples: examplesOf(r.examples).slice(0, 5) }))
}

// ─── Finding one in a contract ────────────────────────────────────────────────

export interface FoundClause {
  content:         string
  startsWith?:     string | null
  endsWith?:       string | null
  sectionRef?:     string | null
  interpretation?: string | null
}

/** The agents service's /find-clause for one contract (the worker's callAgents, in production). */
export type FindClauseCall = (args: {
  orgId: string
  contractId: string
  body: { plainText: string; clauseType: { key: string; label: string; description: string; examples: string[] }; orgId: string }
}) => Promise<FoundClause[] | null>

/** Where a type is in a contract's standing version: the passages found, placed in its text. Nothing saved. */
export async function findInContract(
  def: { key: string; label: string; description: string; examples: unknown; orgId: string },
  contractId: string,
  call: FindClauseCall,
): Promise<{ versionId: string; clauses: Array<FoundClause & { docStart?: number; docEnd?: number }> } | null> {
  const c = await prisma.contract.findFirst({ where: { id: contractId, orgId: def.orgId, deletedAt: null }, select: { currentVersionId: true } })
  const version = c?.currentVersionId
    ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId }, select: { id: true, plainText: true } })
    : null
  if (!version?.plainText?.trim()) return null
  const found = await call({
    orgId: def.orgId, contractId,
    body: { plainText: version.plainText, clauseType: { key: def.key, label: def.label, description: def.description, examples: examplesOf(def.examples) }, orgId: def.orgId },
  })
  if (!found) return null
  const placed = placeClauses(found.map((f, i) => ({
    clauseType: def.key, content: f.content, sortOrder: i,
    startsWith: f.startsWith ?? undefined, endsWith: f.endsWith ?? undefined,
    sectionRef: f.sectionRef ?? undefined, interpretation: f.interpretation ?? undefined,
  })), version.plainText)
  return { versionId: version.id, clauses: placed.map(p => ({ content: p.content, sectionRef: p.sectionRef ?? null, interpretation: p.interpretation ?? null, docStart: p.docStart, docEnd: p.docEnd })) }
}

/**
 * The type's clauses in a version, as found now: the AI's earlier rows of it
 * replaced (a person's tag and a clause a person dismissed stay as they are).
 */
export async function storeFound(versionId: string, key: string, clauses: Array<FoundClause & { docStart?: number; docEnd?: number }>): Promise<number> {
  return prisma.$transaction(async tx => {
    const tagged = await tx.contractClause.findMany({ where: { versionId, clauseType: key, source: { not: 'ai' } }, select: { content: true } })
    await tx.contractClause.deleteMany({ where: { versionId, clauseType: key, source: 'ai' } })
    // A passage a person tagged as it, the AI doesn't add again (one holds the other).
    const kept = clauses.filter(c => !tagged.some(t => coversClause(t.content, c.content) || coversClause(c.content, t.content)))
    if (!kept.length) return 0
    const last = await tx.contractClause.aggregate({ where: { versionId }, _max: { sortOrder: true } })
    const base = (last._max.sortOrder ?? -1) + 1
    await tx.contractClause.createMany({ data: kept.map((c, i) => ({
      versionId, clauseType: key, content: c.content, sortOrder: base + i, source: 'ai',
      sectionRef: c.sectionRef ?? null, interpretation: c.interpretation ?? null,
      docStart: c.docStart ?? null, docEnd: c.docEnd ?? null,
    })) })
    return kept.length
  })
}

// ─── The run over the contracts read before it ────────────────────────────────

const PAGE = 20

/**
 * Find a type in the org's analysed contracts (not a diligence room's), a page
 * at a time, keeping where it got to: a run that pauses (the day's AI budget
 * spent) resumes where it stopped.
 */
export async function runDetect(job: { orgId: string; definitionId: string }, call: FindClauseCall): Promise<DetectState | null> {
  const def = await prisma.clauseTypeDefinition.findFirst({ where: { id: job.definitionId, orgId: job.orgId, deletedAt: null } })
  if (!def) return null
  const where: Prisma.ContractWhereInput = { orgId: def.orgId, deletedAt: null, diligenceRoomId: null, analysisStatus: 'DONE', currentVersionId: { not: null } }
  const prior = (def.detect ?? null) as DetectState | null
  // A run that paused (queued again to go on) resumes where it stopped.
  const resume = prior && (prior.status === 'PAUSED' || prior.status === 'QUEUED') && prior.cursor ? prior : null
  const now = new Date().toISOString()
  const state: DetectState = {
    status: 'RUNNING', total: await prisma.contract.count({ where }),
    processed: resume?.processed ?? 0, found: resume?.found ?? 0, failed: resume?.failed ?? 0,
    cursor: resume?.cursor ?? null, error: null, startedAt: resume?.startedAt ?? now, updatedAt: now,
  }
  const save = async (patch: Partial<DetectState> = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() })
    await prisma.clauseTypeDefinition.update({ where: { id: def.id }, data: { detect: state as unknown as Prisma.InputJsonValue } })
  }
  await save()
  try {
    for (;;) {
      const page = await prisma.contract.findMany({
        where: { ...where, ...(state.cursor ? { id: { gt: state.cursor } } : {}) },
        orderBy: { id: 'asc' }, take: PAGE, select: { id: true },
      })
      if (!page.length) break
      for (const c of page) {
        // Deleted meanwhile: stop.
        if (!await prisma.clauseTypeDefinition.count({ where: { id: def.id, deletedAt: null } })) return state
        try {
          const found = await findInContract(def, c.id, call)
          if (found && await storeFound(found.versionId, def.key, found.clauses) > 0) {
            state.found++
            // Clause search finds them as it finds the others.
            queueEmbedContract(found.versionId)
          }
        } catch (err) {
          if (err instanceof CostCapExceededError) {
            await save({ status: 'PAUSED', error: err.message })
            return state
          }
          console.warn('[clause-types] %s on %s failed: %s', def.key, c.id, (err as Error).message)
          state.failed++
        }
        state.processed++
        state.cursor = c.id
        await save()
      }
    }
    await save({ status: 'DONE' })
    return state
  } catch (err) {
    await save({ status: 'FAILED', error: (err as Error).message.slice(0, 500) }).catch(() => {})
    throw err
  }
}
