/**
 * docs/39 G3 — contracts and the agreements they amend.
 *
 * An amendment, SOW or order form was linked to its agreement only if the
 * person uploading it picked the parent then; nothing noticed a document was
 * an amendment, nothing offered its agreement, and a link couldn't be made
 * afterwards. Its terms never reached the parent either: an agreement
 * extended by an amendment still showed, and alerted on, its old end date.
 * Here: what a document looks like (an amendment, a SOW, an order form), the
 * agreements it most likely belongs to and why, and a link made or changed
 * later — never one that would make a contract its own ancestor. The terms
 * themselves roll up through the field store (applyAmendmentValues).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { compactKey } from './company-names.js'
import { renewsOnItsOwn } from './renewal-notice.js'

// docs/41 Part 13 — the fixed set lives in packages/types family.ts.
export { RELATIONSHIP_TYPES, type RelationshipType } from '@clm/types'
import type { RelationshipType } from '@clm/types'

/**
 * Contracts that renew on their own: not an amendment or an exhibit, which
 * follow the agreement they belong to (its dates carry theirs once rolled up).
 * The predicate itself is renewal-notice's renewsOnItsOwn (the renewal views
 * and the daily scan put it in their AND list); this wraps it for spreading
 * into a where with no AND of its own.
 */
export const RENEWS_ON_ITS_OWN: Prisma.ContractWhereInput = { AND: [renewsOnItsOwn] }

/**
 * What a document reads as, from its title and its heading (its first line)
 * — not its body: an MSA's first page talks about the Statements of Work
 * under it.
 */
export function looksLike(title: string, text: string): RelationshipType | null {
  const heading = text.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? ''
  const head = `${title}\n${heading}`.toLowerCase()
  if (/\b(amendment|addendum|amended and restated|variation agreement|change order)\b/.test(head)) return 'amendment'
  if (/\b(statement of work|sow\s*(no\.?|#|\d))/.test(head)) return 'sow'
  if (/\border form\b/.test(head)) return 'order_form'
  if (/\brenewal (agreement|order)\b/.test(head)) return 'renewal'
  return null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The ways a document may write a date: "January 1, 2024", "1 January 2024", "2024-01-01", "01/01/2024". */
export function dateWritings(d: Date): string[] {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  const mm = String(m + 1).padStart(2, '0'), dd = String(day).padStart(2, '0')
  return [
    `${MONTHS[m]} ${day}, ${y}`, `${MONTHS[m]} ${day} ${y}`, `${day} ${MONTHS[m]} ${y}`, `${day}${['st', 'nd', 'rd'][((day + 90) % 100 - 10) % 10 - 1] ?? 'th'} ${MONTHS[m]} ${y}`,
    `${y}-${mm}-${dd}`, `${mm}/${dd}/${y}`, `${dd}/${mm}/${y}`, `${m + 1}/${day}/${y}`, `${day}/${m + 1}/${y}`,
  ].map(s => s.toLowerCase())
}

const fmt = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`

/** How a document refers to an agreement of each type ("the Master Services Agreement"). */
const TYPE_WORDS: Record<string, string[]> = {
  MSA: ['master services agreement', 'master service agreement', 'master agreement'],
  NDA: ['non-disclosure agreement', 'nondisclosure agreement', 'confidentiality agreement'],
  SLA: ['service level agreement'],
  SOW: ['statement of work'],
  VENDOR_AGREEMENT: ['vendor agreement', 'supply agreement', 'purchase agreement'],
  LICENSE: ['license agreement', 'licence agreement', 'subscription agreement'],
  DATA_PROCESSING: ['data processing agreement', 'data processing addendum'],
  PARTNERSHIP: ['partnership agreement', 'reseller agreement'],
  EMPLOYMENT: ['employment agreement'],
  ORDER_FORM: ['order form'],
}

export interface ParentSuggestion {
  id: string
  title: string
  type: string
  status: string
  effectiveDate: string | null
  reasons: string[]
  score: number
}

/**
 * Enough said for a contract to be offered as the parent — and the document
 * must point at it (its title, its kind, its date, its governing-agreement
 * field): a shared counterparty alone is every contract with that company.
 */
const OFFER_FROM = 4

/**
 * The agreements a contract most likely belongs to: same counterparty, named
 * in its text (by title, by kind — "the Master Services Agreement" — or by
 * the date it was made), dated before it. `ownerId`: an own-scope caller's
 * candidates are theirs.
 */
export async function parentSuggestions(orgId: string, contractId: string, opts: { ownerId?: string } = {}): Promise<{ looksLike: RelationshipType | null; suggestions: ParentSuggestion[] } | null> {
  const c = await prisma.contract.findFirst({
    where: { id: contractId, orgId, deletedAt: null, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) },
    select: {
      id: true, title: true, type: true, counterpartyId: true, counterpartyName: true, effectiveDate: true, currentVersionId: true,
      fieldValues: { where: { fieldKey: { in: ['governing_msa', 'governing_agreement'] } }, select: { valueText: true } },
    },
  })
  if (!c) return null
  const version = c.currentVersionId
    ? await prisma.contractVersion.findFirst({ where: { id: c.currentVersionId, contractId: c.id }, select: { plainText: true } })
    : null
  const text = version?.plainText ?? ''
  const kind = looksLike(c.title, text)
  const lower = `${c.title}\n${text.slice(0, 20_000)}`.toLowerCase()
  const governs = c.fieldValues.map(v => v.valueText).filter((t): t is string => !!t)
  const cpKey = compactKey(c.counterpartyName)

  // Its descendants can't be its parent.
  const descendants = new Set<string>([c.id])
  for (let frontier = [c.id], depth = 0; frontier.length && depth < 20; depth++) {
    const kids = await prisma.contract.findMany({ where: { parentContractId: { in: frontier }, orgId }, select: { id: true } })
    frontier = kids.map(k => k.id).filter(id => !descendants.has(id))
    frontier.forEach(id => descendants.add(id))
  }

  const candidates = await prisma.contract.findMany({
    where: {
      orgId, deletedAt: null, diligenceRoomId: null, id: { notIn: [...descendants] },
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      // An amendment or exhibit is itself a part of something: not a parent to offer.
      ...RENEWS_ON_ITS_OWN,
      ...(c.counterpartyId || c.counterpartyName ? {
        OR: [
          ...(c.counterpartyId ? [{ counterpartyId: c.counterpartyId }] : []),
          ...(c.counterpartyName ? [{ counterpartyName: { contains: c.counterpartyName.split(/[\s,]+/)[0], mode: 'insensitive' as const } }] : []),
        ],
      } : {}),
    },
    select: { id: true, title: true, type: true, status: true, effectiveDate: true, counterpartyId: true, counterpartyName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 60,
  })

  // A document that reads as nothing in particular refers to its own kind
  // ("this Master Services Agreement") and its own date: only an agreement it
  // names by its exact title, or its governing-agreement field, points away.
  const loose = !kind && !governs.length
  const suggestions = candidates.map(p => {
    const reasons: string[] = []
    let score = 0
    if ((c.counterpartyId && p.counterpartyId === c.counterpartyId) || (cpKey && compactKey(p.counterpartyName) === cpKey)) {
      score += 3; reasons.push('Same counterparty')
    }
    const title = p.title.toLowerCase().replace(/\s+/g, ' ').trim()
    const named = title.length >= 8 && lower.includes(title)
    if (named) { score += 4; reasons.push(`Names it: “${p.title}”`) }
    const kindWords = TYPE_WORDS[p.type] ?? []
    const byKind = !named && !loose && kindWords.find(w => lower.includes(w))
    if (byKind) { score += 2; reasons.push(`Refers to a ${byKind}`) }
    const dated = !loose && !!p.effectiveDate && dateWritings(p.effectiveDate).some(w => lower.includes(w))
    if (dated) { score += 3; reasons.push(`Mentions its date, ${fmt(p.effectiveDate!)}`) }
    const governed = governs.some(g => g.toLowerCase().includes(title) || title.includes(g.toLowerCase()))
    if (governed) { score += 3; reasons.push('Its governing agreement field names it') }
    if (p.effectiveDate && c.effectiveDate && p.effectiveDate < c.effectiveDate) score += 1
    return {
      id: p.id, title: p.title, type: p.type, status: p.status,
      effectiveDate: p.effectiveDate ? p.effectiveDate.toISOString().slice(0, 10) : null, reasons, score,
      pointed: named || !!byKind || dated || governed,
    }
  })
    .filter(s => s.pointed && s.score >= OFFER_FROM)
    .map(({ pointed: _pointed, ...s }) => s)
    .sort((a, b) => b.score - a.score || (b.effectiveDate ?? '').localeCompare(a.effectiveDate ?? ''))
    .slice(0, 3)
  return { looksLike: kind, suggestions }
}

/** Would `parentId` as the parent of `contractId` make a contract its own ancestor? */
export async function wouldLoop(orgId: string, contractId: string, parentId: string): Promise<boolean> {
  let at: string | null = parentId
  for (let depth = 0; at && depth < 50; depth++) {
    if (at === contractId) return true
    const row: { parentContractId: string | null } | null = await prisma.contract.findFirst({ where: { id: at, orgId }, select: { parentContractId: true } })
    at = row?.parentContractId ?? null
  }
  return false
}
