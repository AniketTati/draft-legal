/**
 * docs/41 Part 13 — a contract family: an agreement, its amendments
 * (numbered), renewals, SOWs, order forms and exhibits, with their stages
 * and dates; and the agreement's effective view, its own words with each
 * section a signed amendment replaced marked "Amended by A1 (§5)".
 *
 * The effective view is a reading view assembled from the parent's clauses
 * and its signed amendments' recorded changes (metadata._amendment); it is
 * not a new legal document, and nothing is written.
 */
import type { Prisma } from '@prisma/client'
import {
  familyLabel, familyShortLabel, normaliseRelationshipType, NUMBERED, TERM_CHANGING,
  type AmendmentChangeSpec, type AmendmentSpec, type RelationshipType,
} from '@clm/types'
import { prisma } from './prisma.js'

type Db = Prisma.TransactionClient | typeof prisma

/** The next number for a child of this parent and relationship ("Amendment No. 3"); null when unnumbered. */
export async function nextFamilyNumber(orgId: string, parentId: string, type: string | null, db: Db = prisma): Promise<number | null> {
  const t = normaliseRelationshipType(type)
  if (!t || !NUMBERED.includes(t)) return null
  const top = await db.contract.aggregate({
    where: { orgId, parentContractId: parentId, relationshipType: t, deletedAt: null },
    _max: { amendmentNumber: true },
  })
  return (top._max.amendmentNumber ?? 0) + 1
}

/** A contract stands signed: executed, or past it (expired, ended). */
export const isSigned = (c: { status: string; stage?: string | null }) =>
  c.stage === 'active' || ['EXECUTED', 'EXPIRED', 'TERMINATED'].includes(c.status)

/** An amendment's recorded changes (metadata._amendment), when it was drafted here. */
export function amendmentSpecOf(metadata: unknown): AmendmentSpec | null {
  const a = (metadata as { _amendment?: AmendmentSpec } | null)?._amendment
  return a && Array.isArray(a.changes) ? a : null
}

// ─── Family view ──────────────────────────────────────────────────────────────

export interface FamilyMember {
  id: string
  title: string
  type: string
  status: string
  stage: string
  stageState: string
  relationshipType: RelationshipType | null
  number: number | null
  /** "Amendment No. 2", "SOW #3"; null when unnumbered. */
  label: string | null
  effectiveDate: string | null
  expiryDate: string | null
  executedAt: string | null
  signed: boolean
  /** Its terms reach the agreement once signed (an amendment or a renewal). */
  changesTerms: boolean
  children: FamilyMember[]
}

const MEMBER_SELECT = {
  id: true, title: true, type: true, status: true, stage: true, stageState: true, relationshipType: true,
  amendmentNumber: true, effectiveDate: true, expiryDate: true, executedAt: true, parentContractId: true, createdAt: true,
} as const

type MemberRow = Prisma.ContractGetPayload<{ select: typeof MEMBER_SELECT }>

const day = (d: Date | null) => d ? d.toISOString().slice(0, 10) : null

function memberOf(r: MemberRow): FamilyMember {
  const t = normaliseRelationshipType(r.relationshipType)
  return {
    id: r.id, title: r.title, type: r.type, status: r.status, stage: r.stage, stageState: r.stageState,
    relationshipType: t, number: r.amendmentNumber, label: familyLabel(t, r.amendmentNumber),
    effectiveDate: day(r.effectiveDate), expiryDate: day(r.expiryDate), executedAt: r.executedAt?.toISOString() ?? null,
    signed: isSigned(r), changesTerms: !!t && TERM_CHANGING.includes(t), children: [],
  }
}

/** Order inside a family: by relationship, then number, then when it took effect. */
const ORDER: RelationshipType[] = ['amendment', 'renewal', 'sow', 'order_form', 'exhibit', 'split_part', 'nda', 'other']
function compareMembers(a: FamilyMember, b: FamilyMember): number {
  return ORDER.indexOf(a.relationshipType ?? 'other') - ORDER.indexOf(b.relationshipType ?? 'other')
    || (a.number ?? 1e9) - (b.number ?? 1e9)
    || (a.effectiveDate ?? '').localeCompare(b.effectiveDate ?? '')
}

/**
 * The whole family a contract belongs to, from its top agreement down
 * (three levels at most: an MSA, its SOWs, their change orders).
 * `ownerId`: an own-scope caller sees only the members it owns.
 */
export async function familyTree(orgId: string, contractId: string, opts: { ownerId?: string } = {}): Promise<{ root: FamilyMember; currentId: string } | null> {
  const scope = { orgId, deletedAt: null, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) }
  const start = await prisma.contract.findFirst({ where: { id: contractId, ...scope }, select: MEMBER_SELECT })
  if (!start) return null
  // Up to the top agreement the caller may see.
  let top: MemberRow = start
  for (let i = 0; i < 10 && top.parentContractId; i++) {
    const up = await prisma.contract.findFirst({ where: { id: top.parentContractId, ...scope }, select: MEMBER_SELECT })
    if (!up) break
    top = up
  }
  const root = memberOf(top)
  let frontier = [root]
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const kids = await prisma.contract.findMany({
      where: { ...scope, parentContractId: { in: frontier.map(f => f.id) } },
      select: MEMBER_SELECT, orderBy: { createdAt: 'asc' }, take: 200,
    })
    const next: FamilyMember[] = []
    for (const f of frontier) {
      f.children = kids.filter(k => k.parentContractId === f.id).map(memberOf).sort(compareMembers)
      next.push(...f.children)
    }
    frontier = next
  }
  return { root, currentId: contractId }
}

// ─── Effective view ───────────────────────────────────────────────────────────

export interface EffectiveSection {
  /** The parent's clause. */
  clauseId: string
  clauseType: string
  sectionRef: string | null
  /** The parent's own words. */
  originalText: string
  /** The words in effect now (the original unless an amendment changed it). */
  text: string
  deleted: boolean
  /** The signed amendments that changed it, in order; the last one's words stand. */
  amendedBy: Array<{ contractId: string; label: string; short: string; effectiveDate: string | null; action: 'replace' | 'delete' }>
}

export interface EffectiveAmendment {
  id: string
  title: string
  number: number | null
  relationshipType: string | null
  effectiveDate: string | null
  signed: boolean
  changes: AmendmentChangeSpec[]
}

/**
 * Pure: the parent's clauses with each signed amendment's changes applied,
 * in the order the amendments took effect. A change to a clause the parent
 * no longer has (another version) is matched by its section number, then
 * left out: it is listed with the amendment instead of guessed into place.
 * Unsigned amendments change nothing.
 */
export function assembleEffectiveView(
  clauses: Array<{ id: string; clauseType: string; sectionRef: string | null; content: string }>,
  amendments: EffectiveAmendment[],
): { sections: EffectiveSection[]; unplaced: Array<{ amendmentId: string; change: AmendmentChangeSpec }> } {
  const sections: EffectiveSection[] = clauses.map(c => ({
    clauseId: c.id, clauseType: c.clauseType, sectionRef: c.sectionRef, originalText: c.content, text: c.content, deleted: false, amendedBy: [],
  }))
  const unplaced: Array<{ amendmentId: string; change: AmendmentChangeSpec }> = []
  const signed = amendments
    .filter(a => a.signed)
    .sort((a, b) => (a.effectiveDate ?? '').localeCompare(b.effectiveDate ?? '') || (a.number ?? 0) - (b.number ?? 0))
  const refKey = (r: string | null) => (r ?? '').toLowerCase().replace(/^(?:§+|sections?|clauses?|articles?)\s*/, '').replace(/[\s.:)]+$/g, '').trim()
  for (const a of signed) {
    const label = familyLabel(a.relationshipType, a.number) ?? a.title
    const short = familyShortLabel(a.relationshipType, a.number) ?? label
    for (const ch of a.changes) {
      if (ch.kind !== 'clause') continue
      const s = sections.find(x => x.clauseId === ch.clauseId)
        ?? (ch.sectionRef ? sections.find(x => x.sectionRef && refKey(x.sectionRef) === refKey(ch.sectionRef)) : undefined)
      if (!s) { unplaced.push({ amendmentId: a.id, change: ch }); continue }
      s.deleted = ch.action === 'delete'
      s.text = ch.action === 'delete' ? '' : ch.newText
      s.amendedBy.push({ contractId: a.id, label, short, effectiveDate: a.effectiveDate, action: ch.action })
    }
  }
  return { sections, unplaced }
}

/** The parent's effective view: its current version's clauses, as its signed amendments left them. */
export async function effectiveView(orgId: string, contractId: string, opts: { ownerId?: string } = {}) {
  const scope = { orgId, deletedAt: null, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) }
  const c = await prisma.contract.findFirst({ where: { id: contractId, ...scope }, select: { id: true, title: true, currentVersionId: true } })
  if (!c) return null
  const [clauses, children] = await Promise.all([
    c.currentVersionId
      ? prisma.contractClause.findMany({
        where: { versionId: c.currentVersionId, isSubChunk: false },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, clauseType: true, sectionRef: true, content: true },
      })
      : Promise.resolve([]),
    prisma.contract.findMany({
      where: { ...scope, parentContractId: c.id, relationshipType: { in: [...TERM_CHANGING] } },
      select: { id: true, title: true, amendmentNumber: true, relationshipType: true, effectiveDate: true, status: true, stage: true, metadata: true },
    }),
  ])
  const amendments: EffectiveAmendment[] = children.map(a => ({
    id: a.id, title: a.title, number: a.amendmentNumber, relationshipType: a.relationshipType,
    effectiveDate: day(a.effectiveDate), signed: isSigned(a), changes: amendmentSpecOf(a.metadata)?.changes ?? [],
  }))
  const { sections, unplaced } = assembleEffectiveView(clauses, amendments)
  return {
    contract: { id: c.id, title: c.title },
    sections,
    unplaced,
    amendments: amendments.map(a => ({ ...a, label: familyLabel(a.relationshipType, a.number) ?? a.title })),
  }
}
