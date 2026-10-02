/**
 * docs/39 E1 — clauses people tag and correct.
 *
 * A clause the AI missed could not be added, one it filed under the wrong
 * type could not be moved, and one that wasn't a clause at all could not be
 * dismissed: the Clauses tab was read-only, and every re-analysis rebuilt it.
 * Now, on the version the contract stands on:
 *
 *  - tag: words selected in the document become a clause of a type, placed
 *    in the version's text. Words that overlap a clause of the same type
 *    redraw that clause instead — how a clause the AI cut short gets its
 *    full text;
 *  - retype: a clause of the wrong type is set right;
 *  - dismiss: "not a clause" — the row goes, and its words are remembered on
 *    the version, so a re-analysis doesn't bring it back.
 *
 * Each is a person's decision (source 'user'), which a re-analysis keeps
 * (E2, lib/embeddings.ts storeClauseSegments), and is on the record.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { createAuditEvent } from './audit.js'
import { normalizeForSearch } from './text-span.js'
import { locateQuote } from './field-store.js'
import { clauseKey, coversClause, embedClauseQuietly } from './embeddings.js'
import { clauseVersionId } from './clause-version.js'

export interface DismissedClause { clauseType: string; text: string; at: string; by: string }

type Scope = { orgId: string; userId: string; ownOnly?: boolean; ipAddress?: string }

type Result<T> = { ok: true } & T | { ok: false; status: 400 | 404; detail: string }

async function contractFor(scope: Scope, contractId: string) {
  return prisma.contract.findFirst({
    where: { id: contractId, orgId: scope.orgId, deletedAt: null, ...(scope.ownOnly ? { ownerId: scope.userId } : {}) },
    select: { id: true, currentVersionId: true },
  })
}

/** A clause of a contract the caller may change, with the version it's on. */
async function clauseFor(scope: Scope, clauseId: string) {
  const clause = await prisma.contractClause.findUnique({
    where: { id: clauseId },
    select: {
      id: true, versionId: true, clauseType: true, content: true, isSubChunk: true,
      version: { select: { metadata: true, contract: { select: { id: true, orgId: true, ownerId: true } } } },
    },
  })
  if (!clause || clause.isSubChunk || clause.version.contract.orgId !== scope.orgId) return null
  if (scope.ownOnly && clause.version.contract.ownerId !== scope.userId) return null
  return clause
}

function audit(scope: Scope, contractId: string, action: string, clauseType: string) {
  return createAuditEvent({
    orgId: scope.orgId, userId: scope.userId, action: AuditAction.CONTRACT_UPDATED,
    resourceType: 'contract', resourceId: contractId,
    metadata: { source: 'clause_tag', action, clauseType },
    ipAddress: scope.ipAddress,
  }).catch(() => {})
}

/**
 * Clause search reads each clause's embedding: the changed one is embedded
 * again, quietly. Not the upload pipeline's chunk-and-index, which re-runs
 * the contract's analysis steps and marks it FAILED if embedding fails.
 */
function refreshSearch(clauseId: string) {
  void embedClauseQuietly(clauseId)
}

export async function tagClause(scope: Scope, input: { contractId: string; clauseType: string; text: string; occurrence?: number }): Promise<Result<{ clause: { id: string; clauseType: string; content: string }; action: 'tagged' | 'redrawn' | 'covered' }>> {
  const contract = await contractFor(scope, input.contractId)
  if (!contract) return { ok: false, status: 404, detail: 'Contract not found' }
  // The version whose clauses the contract's list shows (lib/clause-version.ts):
  // after an edit that isn't analysed yet, the last one that was — a clause
  // tagged on the new one would leave the list showing only it.
  const listed = await clauseVersionId(contract.id, contract.currentVersionId)
  const version = listed
    ? await prisma.contractVersion.findUnique({ where: { id: listed }, select: { id: true, plainText: true } })
    : await prisma.contractVersion.findFirst({ where: { contractId: contract.id }, orderBy: { versionNumber: 'desc' }, select: { id: true, plainText: true } })
  if (!version) return { ok: false, status: 400, detail: 'The contract has no text to tag' }

  const plain = version.plainText ?? ''
  const span = plain.trim() ? locateQuote(normalizeForSearch(plain), input.text, input.occurrence ?? 0) : null
  const content = span ? plain.slice(span.start, span.end) : input.text.trim()
  const existing = await prisma.contractClause.findMany({
    where: { versionId: version.id, isSubChunk: false },
    select: { id: true, clauseType: true, content: true, docStart: true, docEnd: true },
  })
  // The same kind of clause, on the same words: redraw it rather than add a second.
  const overlaps = (c: (typeof existing)[number]) => c.clauseType === input.clauseType && (
    span && c.docStart !== null && c.docEnd !== null
      ? c.docStart < span.end && span.start < c.docEnd
      : coversClause(c.content, content) || coversClause(content, c.content)
  )
  const same = existing.find(overlaps)
  // Words already inside a clause of that kind: it covers them. Tagging never
  // shrinks a clause to the part someone selected.
  const inside = same && (span && same.docStart !== null && same.docEnd !== null
    ? span.start >= same.docStart && span.end <= same.docEnd
    // The clause's words contain all of the selection's.
    : clauseKey(same.content).includes(clauseKey(content)))
  if (same && inside) {
    return { ok: true, clause: { id: same.id, clauseType: same.clauseType, content: same.content }, action: 'covered' }
  }
  if (same) {
    const clause = await prisma.contractClause.update({
      where: { id: same.id },
      data: { content, docStart: span?.start ?? null, docEnd: span?.end ?? null, source: 'user' },
      select: { id: true, clauseType: true, content: true },
    })
    await audit(scope, contract.id, 'redrawn', input.clauseType)
    refreshSearch(clause.id)
    return { ok: true, clause, action: 'redrawn' }
  }
  const before = span ? existing.filter(c => c.docStart !== null && c.docStart < span.start).length : existing.length
  const clause = await prisma.contractClause.create({
    data: {
      versionId: version.id, clauseType: input.clauseType, content, sortOrder: before,
      source: 'user', docStart: span?.start ?? null, docEnd: span?.end ?? null,
    },
    select: { id: true, clauseType: true, content: true },
  })
  await audit(scope, contract.id, 'tagged', input.clauseType)
  refreshSearch(clause.id)
  return { ok: true, clause, action: 'tagged' }
}

export async function retypeClause(scope: Scope, input: { clauseId: string; clauseType: string }): Promise<Result<{ clause: { id: string; clauseType: string } }>> {
  const found = await clauseFor(scope, input.clauseId)
  if (!found) return { ok: false, status: 404, detail: 'Clause not found' }
  const clause = await prisma.contractClause.update({
    where: { id: found.id },
    // The type was the finding; the review of the old one doesn't carry over.
    data: { clauseType: input.clauseType, source: 'user', riskRating: null, interpretation: null, reviewState: 'unreviewed', reviewedAt: null, reviewedById: null },
    select: { id: true, clauseType: true },
  })
  await audit(scope, found.version.contract.id, 'retyped', input.clauseType)
  refreshSearch(clause.id)
  return { ok: true, clause }
}

export async function dismissClause(scope: Scope, input: { clauseId: string }): Promise<Result<{ dismissed: DismissedClause }>> {
  const found = await clauseFor(scope, input.clauseId)
  if (!found) return { ok: false, status: 404, detail: 'Clause not found' }
  const dismissed: DismissedClause = { clauseType: found.clauseType, text: found.content.slice(0, 600), at: new Date().toISOString(), by: scope.userId }
  const md = (found.version.metadata ?? {}) as Record<string, unknown>
  const list = Array.isArray(md._dismissedClauses) ? md._dismissedClauses as DismissedClause[] : []
  // Its search windows go with it: sub-chunks carry no parent, but each is a stretch of its words.
  const windows = (await prisma.contractClause.findMany({ where: { versionId: found.versionId, isSubChunk: true }, select: { id: true, content: true } }))
    .filter(w => w.content.trim() && found.content.includes(w.content.trim()))
    .map(w => w.id)
  await prisma.$transaction([
    prisma.contractVersion.update({ where: { id: found.versionId }, data: { metadata: { ...md, _dismissedClauses: [...list, dismissed].slice(-200) } as object } }),
    prisma.contractClause.deleteMany({ where: { id: { in: [found.id, ...windows] } } }),
  ])
  await audit(scope, found.version.contract.id, 'dismissed', found.clauseType)
  return { ok: true, dismissed }
}

