/**
 * docs/41 P1 (Parts 7, 8) — one review of a contract, and what can be done
 * about each thing it found.
 *
 *   GET  /contracts/:id/review?versionId=                  the review: playbook, run, recommendation, findings, clause statuses
 *   POST /contracts/:id/findings/:findingId/accept         accept as is (edit:playbook; audited)
 *   POST /contracts/:id/findings/:findingId/resolve        mark resolved
 *   POST /contracts/:id/findings/:findingId/reopen         undo either
 *   POST /contracts/:id/findings/:findingId/tag            "it's here": tag the clause a required one was not detected as
 *   POST /contracts/:id/findings/:findingId/insert-standard  your preferred position's words, as a new version
 *   POST /contracts/:id/findings/:findingId/redline        a rewrite to your position, staged for review
 *   POST /contracts/:id/findings/:findingId/redline/apply  the staged rewrite, as a new version
 *   POST /contracts/:id/review/fix-all                     rewrites for every fixable finding, staged together
 *
 * Two playbook panels used to judge the same positions with two engines
 * (the automatic review and the on-demand redline) and could disagree. This
 * is the one surface: findings from lib/review-findings.ts, the
 * recommendation from its policy, and the fixes attached to the finding
 * they fix. Exception requests come with the approvals milestone; the
 * finding statuses for them exist already.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AuditAction, CLAUSE_TYPE_LABELS, REVIEW_STATUS_TEXT, RECOMMENDATION_TEXT, reviewText, clauseTypeLabel, analysisState, type ReviewStatus } from '@clm/types'
import type { ReviewFinding } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { createAuditEvent } from '../lib/audit.js'
import { recordAiSuggestion } from '../lib/ai-suggestion-events.js'
import { findingsFor, computeAndStoreFindings, reviewStampOf, baselineWords, type BaselineReason, type PositionVerdict } from '../lib/review-findings.js'
import { recommendationGuard } from '../lib/recommendation-guard.js'
import { computeDraftingFindings, draftingChecked } from '../lib/drafting-findings.js'
import { latestRun } from '../lib/analysis-runs.js'
import { contractPlaybook } from '../lib/playbooks.js'
import { matchCategory } from '../lib/clause-category.js'
import { tagClause } from '../lib/clause-tags.js'
import { isClauseType } from '../lib/clause-types.js'
import { applyClauseBatch } from '../lib/clause-apply.js'
import { proposeClauseAlternatives } from '../lib/clause-propose.js'
import { htmlToText } from '../lib/html-text.js'
import { requestException, exceptionApproverFor, EXCEPTION_KINDS } from '../lib/approval-flow.js'

type Action = 'accept' | 'resolve' | 'reopen' | 'tag_clause' | 'insert_standard' | 'redline' | 'request_exception'

const OPEN = new Set(['open', 'exception_requested', 'exception_declined'])
const DONE = new Set(['accepted', 'resolved', 'exception_approved'])
/** Findings a rewrite of their clause can fix. */
const REDLINEABLE = new Set(['position_not_met', 'needs_approval_position', 'position_fallback', 'modified', 'material_cut', 'added'])
/** Findings your preferred position's words can fix. */
const INSERTABLE = new Set(['missing_required', 'deleted', 'position_not_met', 'needs_approval_position', 'material_cut'])

const STATUS_OF_KIND: Record<string, ReviewStatus> = {
  missing_required: 'not_detected', deleted: 'deleted', not_allowed_present: 'not_allowed', modified: 'changed', material_cut: 'changed',
  added: 'added', position_not_met: 'not_met', position_fallback: 'fallback', needs_approval_position: 'needs_approval', unreadable_text: 'unreadable',
  drafting: 'drafting', compliance: 'compliance_gap',
}
const STATUS_OF_VERDICT: Record<string, ReviewStatus> = {
  meets_preferred: 'matches_preferred', meets_fallback: 'fallback', needs_approval: 'needs_approval', not_met: 'not_met', not_covered: 'not_covered',
}

const errorText = (reply: { status: number; detail: string; code?: string }) => ({ detail: reply.detail, ...(reply.code && { code: reply.code }) })

/** The headers a request on the user's behalf carries (the html-version path checks them as its own). */
const authHeaders = (req: FastifyRequest) => Object.fromEntries(
  ['authorization', 'x-api-key', 'cookie'].map(h => [h, req.headers[h]]).filter(([, v]) => typeof v === 'string'),
) as Record<string, string>

export async function reviewRoutes(app: FastifyInstance) {
  // X7 — own scope may only act on contracts it owns.
  guardOwnScopeContractRoutes(app)

  async function contractOf(orgId: string, id: string) {
    return prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, orgId: true, type: true, playbookId: true, currentVersionId: true, analysisStatus: true, analysisError: true, metadata: true, riskScore: true },
    })
  }

  /** The preferred (else acceptable) position for a category, of the contract's playbook. */
  async function standardPosition(orgId: string, contract: { id: string; type: string; playbookId: string | null }, categoryId: string | null) {
    if (!categoryId) return null
    const { where } = await contractPlaybook(orgId, contract)
    if (!where) return null
    const rows = await prisma.playbookPosition.findMany({
      where: { AND: [where, { clauseCategoryId: categoryId, positionType: { in: ['preferred', 'acceptable'] } }] },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, positionType: true, content: true, clauseCategory: { select: { name: true } } },
    })
    const p = rows.find(r => r.positionType === 'preferred' && r.content.trim()) ?? rows.find(r => r.content.trim())
    return p ?? null
  }

  // ── GET /:id/review ─────────────────────────────────────────────────────
  app.get('/:id/review', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const { versionId: asked } = z.object({ versionId: z.string().min(1).max(64).optional() }).parse(req.query)
    const contract = await contractOf(orgId, id)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const versionId = asked ?? contract.currentVersionId
    const version = versionId ? await prisma.contractVersion.findFirst({ where: { id: versionId, contractId: id }, select: { id: true, versionNumber: true, metadata: true } }) : null
    if (asked && !version) return reply.status(404).send({ detail: 'Version not found' })
    const isCurrent = !!version && version.id === contract.currentVersionId

    const analysis = analysisState(contract)
    const [playbook, run, currentRun] = await Promise.all([
      contractPlaybook(orgId, contract),
      version ? latestRun(id, version.id) : Promise.resolve(null),
      contract.currentVersionId && contract.currentVersionId !== version?.id ? latestRun(id, contract.currentVersionId) : Promise.resolve(null),
    ])
    // A version analysed before its defined terms were checked (docs/41 Part 10): checked now, it is quick.
    if (version && analysis.kind !== 'not_analysed' && !draftingChecked(version.metadata)) await computeDraftingFindings(id, version.id)
    // Nothing read yet: no findings to make up.
    const rows: ReviewFinding[] = version && analysis.kind !== 'not_analysed' ? await findingsFor(id, version.id) : []
    const guard = isCurrent ? await recommendationGuard(id, orgId) : null
    const stamp = version ? reviewStampOf((await prisma.contractVersion.findUnique({ where: { id: version.id }, select: { metadata: true } }))?.metadata) : null
    const v = stamp?.baselineVersionNumber != null ? `v${stamp.baselineVersionNumber}` : null

    const clauses = version ? await prisma.contractClause.findMany({
      where: { versionId: version.id, isSubChunk: false },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, clauseType: true, content: true, sectionRef: true, provenance: true, sourceRef: true, positionVerdict: true },
    }) : []
    // Where standard text came from, by name: "NDA template v3".
    const templateIds = [...new Set(clauses.map(c => c.sourceRef?.startsWith('template:') ? c.sourceRef.split(':')[1] : null).filter((x): x is string => !!x))]
    const templates = templateIds.length ? await prisma.template.findMany({ where: { id: { in: templateIds }, orgId }, select: { id: true, name: true } }) : []
    const sourceName = (ref: string | null) => {
      if (!ref) return null
      const [kind, tid, n] = ref.split(':')
      if (kind === 'library') return `your clause library (v${n})`
      const t = templates.find(x => x.id === tid)
      return t ? `template ${t.name} v${n}` : `your template (v${n})`
    }

    // Which categories the playbook has positions for: a clause outside them is "not covered".
    const [categories, positions] = await Promise.all([
      prisma.clauseCategory.findMany({ where: { orgId }, select: { id: true, name: true } }),
      playbook.where ? prisma.playbookPosition.findMany({ where: playbook.where, select: { id: true, clauseCategoryId: true, positionType: true, counterpartyNote: true } }) : Promise.resolve([]),
    ])
    const covered = new Set(positions.map(p => p.clauseCategoryId))
    // docs/41 Part 16 — the note to the counterparty: the finding's own
    // position's, else the preferred position's of its clause type.
    const noteById = new Map(positions.filter(p => p.counterpartyNote?.trim()).map(p => [p.id, p.counterpartyNote!.trim()]))
    const noteByCategory = new Map(positions.filter(p => p.positionType === 'preferred' && p.counterpartyNote?.trim()).map(p => [p.clauseCategoryId, p.counterpartyNote!.trim()]))
    const counterpartyNoteOf = (f: ReviewFinding) => (f.positionId && noteById.get(f.positionId)) || (f.categoryId && noteByCategory.get(f.categoryId)) || null
    const canInsert = new Set(positions.filter(p => p.positionType === 'preferred' || p.positionType === 'acceptable').map(p => p.clauseCategoryId))

    const statusText = (s: ReviewStatus, source?: string | null) => ({
      reviewStatus: s,
      label: reviewText(REVIEW_STATUS_TEXT[s].label, { v, source }),
      definition: reviewText(REVIEW_STATUS_TEXT[s].definition, { v, source }),
    })

    const actionsOf = (f: ReviewFinding): Action[] => {
      if (!isCurrent) return []
      if (!OPEN.has(f.status)) return ['reopen']
      const out: Action[] = []
      if (f.kind === 'missing_required') out.push('tag_clause')
      if (INSERTABLE.has(f.kind) && f.categoryId && canInsert.has(f.categoryId)) out.push('insert_standard')
      if (REDLINEABLE.has(f.kind) && f.clauseId && f.categoryId && covered.has(f.categoryId)) out.push('redline')
      // Confirming a required clause is missing is an exception (approvals), not "accept".
      if (f.kind !== 'missing_required') out.push('accept')
      // docs/41 Part 7 — an exception to the playbook, for the clause approver to decide.
      if ((f.status === 'open' || f.status === 'exception_declined') && EXCEPTION_KINDS.has(f.kind)) out.push('request_exception')
      out.push('resolve')
      return out
    }
    const viewFinding = (f: ReviewFinding) => ({
      id: f.id, kind: f.kind, severity: f.severity, status: f.status, source: f.source,
      title: f.title, explanation: f.explanation, evidence: f.evidence,
      clauseId: f.clauseId, clauseType: f.clauseType, categoryId: f.categoryId, positionId: f.positionId,
      ...statusText(DONE.has(f.status) ? (f.status === 'accepted' ? 'accepted' : 'resolved') : STATUS_OF_KIND[f.kind] ?? 'not_met'),
      resolvedById: f.resolvedById, resolvedAt: f.resolvedAt, resolutionNote: f.resolutionNote,
      // docs/41 Part 15 — the model's advice on a counterparty's change (lib/change-advice.ts).
      advice: f.advice ?? null,
      counterpartyNote: counterpartyNoteOf(f),
      actions: actionsOf(f),
    })

    const open = rows.filter(f => OPEN.has(f.status))
    const severity: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
    const bySeverity = (a: ReviewFinding, b: ReviewFinding) => (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4)
    // docs/41 Parts 9, 10 — drafting and compliance findings in groups of their own.
    const own = (f: ReviewFinding) => f.kind === 'drafting' || f.kind === 'compliance'
    const needsAttention = open.filter(f => f.kind !== 'missing_required' && !own(f)).sort(bySeverity).map(viewFinding)
    const notDetected = open.filter(f => f.kind === 'missing_required').map(viewFinding)
    const compliance = open.filter(f => f.kind === 'compliance').sort(bySeverity).map(viewFinding)
    const drafting = open.filter(f => f.kind === 'drafting').sort(bySeverity).map(viewFinding)
    const accepted = rows.filter(f => !OPEN.has(f.status)).map(viewFinding)

    // Each clause's status: what the findings say of it, else where it came
    // from or the model's verdict, else unchanged or not covered.
    const findingOn = new Map<string, ReviewFinding>()
    for (const f of [...open].sort(bySeverity)) if (f.clauseId && !findingOn.has(f.clauseId)) findingOn.set(f.clauseId, f)
    const clauseViews = clauses.map(c => {
      const f = findingOn.get(c.id)
      const verdict = c.positionVerdict as PositionVerdict | null
      const category = matchCategory(categories, c.clauseType)
      const status: ReviewStatus = f ? STATUS_OF_KIND[f.kind] ?? 'not_met'
        : c.provenance === 'template' || c.provenance === 'library' ? 'standard'
        : verdict ? STATUS_OF_VERDICT[verdict.verdict] ?? 'not_covered'
        : !category || !covered.has(category.id) ? 'not_covered'
        : 'unchanged'
      return {
        id: c.id, clauseType: c.clauseType, clauseLabel: CLAUSE_TYPE_LABELS[c.clauseType] ?? clauseTypeLabel(c.clauseType), sectionRef: c.sectionRef,
        excerpt: c.content.slice(0, 240), provenance: c.provenance, sourceRef: c.sourceRef, findingId: f?.id ?? null,
        ...(verdict && { verdict: { verdict: verdict.verdict, quote: verdict.quote, explanation: verdict.explanation } }),
        ...statusText(status, sourceName(c.sourceRef)),
      }
    })
    const standard = clauseViews.filter(c => ['standard', 'matches_preferred', 'fallback', 'unchanged'].includes(c.reviewStatus))

    const recommendation = guard?.recommendation ?? null
    return reply.send({
      contractId: id,
      versionId: version?.id ?? null,
      versionNumber: version?.versionNumber ?? null,
      isCurrent,
      analysis,
      run,
      // docs/41 Part 5 — "Analysis is for v4 — v5 has changes. Re-analysing…"
      stale: analysis.kind === 'stale' ? { analysedVersionNumber: analysis.analysedVersionNumber, run: currentRun ?? (isCurrent ? run : null) } : null,
      playbook: {
        id: playbook.resolution.playbook?.id || null, name: playbook.resolution.playbook?.name ?? null,
        version: playbook.resolution.playbook?.version ?? null,
        why: playbook.resolution.why, explanation: playbook.resolution.explanation,
        candidates: playbook.resolution.candidates.map(c => ({ id: c.id, name: c.name })),
      },
      baseline: stamp?.baselineVersionId ? {
        versionId: stamp.baselineVersionId, versionNumber: stamp.baselineVersionNumber, reason: stamp.baselineReason,
        words: stamp.baselineReason ? baselineWords(stamp.baselineReason as BaselineReason) : null,
      } : null,
      recommendation: recommendation ? {
        label: recommendation.label,
        text: RECOMMENDATION_TEXT[recommendation.label].label,
        definition: RECOMMENDATION_TEXT[recommendation.label].definition,
        reasons: recommendation.reasons,
      } : null,
      groups: { needsAttention, notDetected, compliance, drafting, accepted },
      clauses: clauseViews,
      counts: {
        needsAttention: needsAttention.length, notDetected: notDetected.length, accepted: accepted.length,
        compliance: compliance.length, drafting: drafting.length,
        standard: standard.length, clauses: clauseViews.length,
        // What "Fix all fixable" rewrites in one batch: the findings about a clause.
        fixable: [...needsAttention, ...notDetected].filter(f => f.actions.includes('redline')).length,
      },
    })
  })

  /** A finding of this contract's current version, and the contract. */
  async function findingOf(orgId: string, contractId: string, findingId: string) {
    const contract = await contractOf(orgId, contractId)
    if (!contract) return null
    const finding = await prisma.reviewFinding.findFirst({ where: { id: findingId, orgId, contractId } })
    if (!finding) return null
    return { contract, finding }
  }

  async function decide(req: FastifyRequest, status: 'accepted' | 'resolved' | 'open', note: string | null) {
    const { orgId, sub: userId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const found = await findingOf(orgId, id, findingId)
    if (!found) return { status: 404, body: { detail: 'Finding not found' } }
    const { finding, contract } = found
    if (finding.versionId !== contract.currentVersionId) {
      return { status: 409, body: { code: 'NOT_CURRENT', detail: 'This finding is about an older version. Decide on the version the contract stands on.' } }
    }
    if (status !== 'open' && !OPEN.has(finding.status)) return { status: 409, body: { code: 'ALREADY_DECIDED', detail: 'This finding was already dealt with.' } }
    if (status === 'open' && OPEN.has(finding.status)) return { status: 409, body: { code: 'ALREADY_OPEN', detail: 'This finding is open.' } }
    if (status === 'accepted' && finding.kind === 'missing_required') {
      return { status: 409, body: { code: 'NEEDS_EXCEPTION', detail: 'A required clause can’t be accepted as missing: tag it if it is there, or ask for an exception.' } }
    }
    const updated = await prisma.reviewFinding.update({
      where: { id: finding.id },
      data: status === 'open'
        ? { status: 'open', resolvedById: null, resolvedAt: null, resolutionNote: null }
        : { status, resolvedById: userId, resolvedAt: new Date(), resolutionNote: note },
    })
    await createAuditEvent({
      orgId, userId, action: AuditAction.REVIEW_FINDING_DECIDED, resourceType: 'contract', resourceId: id,
      metadata: { findingId: finding.id, kind: finding.kind, title: finding.title, decision: status === 'open' ? 'reopened' : status, note, versionId: finding.versionId, severity: finding.severity },
      ipAddress: req.ip,
    })
    return { status: 200, body: { id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt, resolutionNote: updated.resolutionNote } }
  }

  const NoteBody = z.object({ note: z.string().trim().max(2000).optional() }).default({})

  // Accepting a clause as it stands, against the playbook, is the legal
  // team's call: it needs the right to change the playbook.
  app.post('/:id/findings/:findingId/accept', { preHandler: requirePermission('edit', 'playbook') }, async (req, reply) => {
    const r = await decide(req, 'accepted', NoteBody.parse(req.body ?? {}).note ?? null)
    return reply.status(r.status).send(r.body)
  })
  app.post('/:id/findings/:findingId/resolve', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const r = await decide(req, 'resolved', NoteBody.parse(req.body ?? {}).note ?? null)
    return reply.status(r.status).send(r.body)
  })
  app.post('/:id/findings/:findingId/reopen', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const r = await decide(req, 'open', null)
    return reply.status(r.status).send(r.body)
  })

  // ── Request an exception (docs/41 Part 7) ────────────────────────────────
  // An approval step of kind clause_exception, for the category's clause
  // approver; the finding's status follows it, and the recommendation with it.
  app.post('/:id/findings/:findingId/exception', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const body = z.object({ reason: z.string().trim().min(3).max(2000) }).safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Say why an exception is needed (at least 3 characters).' })
    const contract = await contractOf(orgId, id)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const r = await requestException({ orgId, contractId: id, findingId, userId, reason: body.data.reason })
    if (!r.ok) return reply.status(r.status).send({ detail: r.error, ...(r.code && { code: r.code }) })
    return reply.status(201).send({ stepId: r.stepId, approverIds: r.approverIds })
  })
  // Who would decide, for the dialog before asking: a person's name or a
  // role's, or the same NO_CLAUSE_APPROVER refusal the request would give.
  app.get('/:id/findings/:findingId/exception-approver', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    if (!await contractOf(orgId, id)) return reply.status(404).send({ detail: 'Contract not found' })
    const r = await exceptionApproverFor({ orgId, contractId: id, findingId })
    if (!r.ok) return reply.status(r.status).send({ detail: r.error, ...(r.code && { code: r.code }) })
    return reply.send({ kind: r.kind, name: r.name, category: r.category })
  })

  // ── Tag: the required clause is there, under another heading ────────────
  app.post('/:id/findings/:findingId/tag', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const body = z.object({
      text: z.string().trim().min(2).max(20_000),
      occurrence: z.number().int().min(0).max(10_000).optional(),
      clauseType: z.string().min(1).max(80).optional(),
    }).parse(req.body)
    const found = await findingOf(orgId, id, findingId)
    if (!found) return reply.status(404).send({ detail: 'Finding not found' })
    const { finding, contract } = found
    if (finding.kind !== 'missing_required' || !OPEN.has(finding.status)) return reply.status(409).send({ code: 'NOT_TAGGABLE', detail: 'Only a required clause that was not detected is found by tagging it.' })
    // The clause type the category is: the first built-in type that names it.
    const category = finding.categoryId ? await prisma.clauseCategory.findFirst({ where: { id: finding.categoryId, orgId }, select: { id: true, name: true } }) : null
    const clauseType = body.clauseType
      ?? (category ? Object.keys(CLAUSE_TYPE_LABELS).find(t => matchCategory([category], t)?.id === category.id) : undefined)
    if (!clauseType || !await isClauseType(orgId, clauseType)) return reply.status(422).send({ detail: 'Choose the kind of clause this is.' })
    const tagged = await tagClause({ orgId, userId, ownOnly: req.permissionScope === 'own', ipAddress: req.ip }, { contractId: id, clauseType, text: body.text, occurrence: body.occurrence })
    if (!tagged.ok) return reply.status(tagged.status).send({ detail: tagged.detail })
    // The findings again: the clause is there now.
    if (contract.currentVersionId) await computeAndStoreFindings(id, contract.currentVersionId)
    return reply.send({ clause: tagged.clause, action: tagged.action })
  })

  // ── Insert your standard language ────────────────────────────────────────
  app.post('/:id/findings/:findingId/insert-standard', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const found = await findingOf(orgId, id, findingId)
    if (!found) return reply.status(404).send({ detail: 'Finding not found' })
    const { finding, contract } = found
    if (finding.versionId !== contract.currentVersionId || !OPEN.has(finding.status)) return reply.status(409).send({ code: 'NOT_CURRENT', detail: 'This finding is not open on the version the contract stands on.' })
    const position = await standardPosition(orgId, contract, finding.categoryId)
    if (!position) return reply.status(409).send({ code: 'NO_STANDARD_LANGUAGE', detail: 'Your playbook has no preferred wording for this clause to insert.' })
    const name = position.clauseCategory?.name ?? clauseTypeLabel(finding.clauseType ?? 'clause')
    const clauseOnVersion = finding.clauseId
      ? await prisma.contractClause.findFirst({ where: { id: finding.clauseId, versionId: contract.currentVersionId! }, select: { id: true } })
      : null

    let versionId: string | null = null
    let versionNumber: number | null = null
    if (clauseOnVersion) {
      // The clause's words become the position's, as one new version.
      const r = await applyClauseBatch({ orgId, userId, contractId: id, changes: [{ clauseId: clauseOnVersion.id, proposedText: htmlToText(position.content).trim(), rationale: `Your standard ${name} language` }], rationale: `inserted your standard ${name} language` })
      if (!r.ok) return reply.status(r.status).send(errorText(r))
      versionId = r.data.newVersionId
      versionNumber = r.data.newVersionNumber
    } else {
      // Not in the document: added at its end, through the editor's own save.
      const current = await prisma.contractVersion.findUnique({ where: { id: contract.currentVersionId! }, select: { htmlContent: true } })
      const res = await app.inject({
        method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: authHeaders(req),
        payload: { htmlContent: `${current?.htmlContent ?? ''}\n<h2>${name}</h2>\n${position.content}`, changeNote: `Added your standard ${name} language` },
      })
      if (res.statusCode >= 300) return reply.status(res.statusCode).send(res.json())
      const v = res.json() as { id: string; versionNumber: number }
      versionId = v.id
      versionNumber = v.versionNumber
    }
    await prisma.reviewFinding.update({ where: { id: finding.id }, data: { status: 'resolved', resolvedById: userId, resolvedAt: new Date(), resolutionNote: `Your standard ${name} language inserted in v${versionNumber}.` } })
    await createAuditEvent({
      orgId, userId, action: AuditAction.REVIEW_FINDING_DECIDED, resourceType: 'contract', resourceId: id,
      metadata: { findingId: finding.id, kind: finding.kind, title: finding.title, decision: 'standard_inserted', positionId: position.id, versionId },
      ipAddress: req.ip,
    })
    // docs/41 Part 16 — the playbook's wording, put in: an accepted suggestion.
    recordAiSuggestion({ orgId, userId, contractId: id, versionId, feature: 'insert_standard', outcome: 'accepted', suggestionId: finding.id })
    return reply.status(201).send({ versionId, versionNumber, positionId: position.id })
  })

  // ── Redline to your position: staged, then applied ───────────────────────
  type Staged = { versionId: string; clauseId: string; originalText: string; proposedText: string; rationale: string; changes: Array<{ before: string; after: string; reason?: string }>; stagedAt: string }
  const stagedOf = (metadata: unknown): Record<string, Staged> => ((metadata as { _findingRedlines?: Record<string, Staged> } | null)?._findingRedlines ?? {})

  app.post('/:id/findings/:findingId/redline', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const found = await findingOf(orgId, id, findingId)
    if (!found) return reply.status(404).send({ detail: 'Finding not found' })
    const { finding, contract } = found
    if (finding.versionId !== contract.currentVersionId || !OPEN.has(finding.status) || !finding.clauseId) {
      return reply.status(409).send({ code: 'NOT_REDLINEABLE', detail: 'Only an open finding about a clause of the current version can be redlined.' })
    }
    const proposed = await proposeClauseAlternatives({
      contractId: id, orgId, clauseId: finding.clauseId,
      instructions: `Bring this clause to our playbook position. What the review found: ${finding.title}. ${finding.explanation}`,
    })
    if (!proposed.ok) return reply.status(proposed.status).send({ detail: proposed.detail })
    const variant = proposed.data.variants.find(v => v.aggression === 'moderate') ?? proposed.data.variants[0]
    if (!variant?.proposedText) return reply.status(502).send({ detail: proposed.data.error ?? 'No rewrite could be drafted. Try again.' })
    const staged: Staged = {
      versionId: contract.currentVersionId!, clauseId: finding.clauseId,
      originalText: proposed.data.clause.originalText, proposedText: variant.proposedText,
      rationale: variant.rationale, changes: variant.changes, stagedAt: new Date().toISOString(),
    }
    // Staged with the contract: apply takes only what was shown, never text sent back by the page.
    await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('_findingRedlines', COALESCE(metadata->'_findingRedlines', '{}'::jsonb)), ${['_findingRedlines', finding.id]}::text[], ${JSON.stringify(staged)}::jsonb) WHERE id = ${id}`
    recordAiSuggestion({ orgId, userId: req.user.sub, contractId: id, versionId: contract.currentVersionId, feature: 'redline_to_position', outcome: 'shown', suggestionId: finding.id })
    return reply.send({ findingId: finding.id, ...staged })
  })

  app.post('/:id/findings/:findingId/redline/apply', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id, findingId } = req.params as { id: string; findingId: string }
    const found = await findingOf(orgId, id, findingId)
    if (!found) return reply.status(404).send({ detail: 'Finding not found' })
    const { finding, contract } = found
    const staged = stagedOf(contract.metadata)[finding.id]
    if (!staged) return reply.status(409).send({ code: 'NOT_STAGED', detail: 'There is no rewrite for this finding to apply. Ask for one first.' })
    if (staged.versionId !== contract.currentVersionId) return reply.status(409).send({ code: 'STALE_REDLINE', detail: 'The document changed after this rewrite was drafted. Ask for a new one.' })
    const r = await applyClauseBatch({ orgId, userId, contractId: id, changes: [{ clauseId: staged.clauseId, proposedText: staged.proposedText, rationale: staged.rationale, changes: staged.changes }], rationale: `redlined to your position: ${finding.title}` })
    if (!r.ok) return reply.status(r.status).send(errorText(r))
    await prisma.reviewFinding.update({ where: { id: finding.id }, data: { status: 'resolved', resolvedById: userId, resolvedAt: new Date(), resolutionNote: `Redlined to your position in v${r.data.newVersionNumber}.` } })
    await prisma.$executeRaw`UPDATE contracts SET metadata = metadata #- ${['_findingRedlines', finding.id]}::text[] WHERE id = ${id}`
    await createAuditEvent({
      orgId, userId, action: AuditAction.REVIEW_FINDING_DECIDED, resourceType: 'contract', resourceId: id,
      metadata: { findingId: finding.id, kind: finding.kind, title: finding.title, decision: 'redlined', versionId: r.data.newVersionId },
      ipAddress: req.ip,
    })
    recordAiSuggestion({ orgId, userId, contractId: id, versionId: r.data.newVersionId, feature: 'redline_to_position', outcome: 'accepted', suggestionId: finding.id })
    return reply.status(201).send(r.data)
  })

  // ── Fix all fixable: one staged batch, previewed before anything changes ─
  app.post('/:id/review/fix-all', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const contract = await contractOf(orgId, id)
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    if (!contract.currentVersionId) return reply.status(409).send({ code: 'NOT_ANALYSED', detail: 'This contract has no version to fix yet.' })
    const meta = (contract.metadata as Record<string, unknown> | null) ?? {}
    if (meta._playbookRedlineStatus === 'RUNNING' || meta._playbookRedlineStatus === 'QUEUED') {
      return reply.status(409).send({ detail: 'Fixes are already being drafted for this contract.' })
    }
    const rows = await findingsFor(id, contract.currentVersionId)
    const categories = await prisma.clauseCategory.findMany({ where: { orgId }, select: { id: true, name: true } })
    const fixable = rows.filter(f => OPEN.has(f.status) && f.clauseId && REDLINEABLE.has(f.kind))
    const onVersion = new Set((await prisma.contractClause.findMany({ where: { versionId: contract.currentVersionId, id: { in: fixable.map(f => f.clauseId!) } }, select: { id: true } })).map(c => c.id))
    const targets = fixable.filter(f => onVersion.has(f.clauseId!))
    if (!targets.length) return reply.status(409).send({ code: 'NOTHING_TO_FIX', detail: 'No open finding here can be fixed by a rewrite.' })
    const hints: Record<string, { category?: string; issue?: string }> = {}
    const severity: Record<string, string | null> = {}
    const findingIds: Record<string, string> = {}
    for (const f of targets) {
      hints[f.clauseId!] = { category: categories.find(c => c.id === f.categoryId)?.name, issue: `${f.title}. ${f.explanation}` }
      severity[f.clauseId!] = f.severity
      findingIds[f.clauseId!] = f.id
    }
    await prisma.$executeRaw`UPDATE contracts SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('_playbookRedlineStatus', 'QUEUED', '_playbookRedlineError', NULL) WHERE id = ${id}`
    const { queuePlaybookRedline } = await import('../lib/queue.js')
    queuePlaybookRedline({ contractId: id, orgId, userId, versionId: contract.currentVersionId, aggression: 'moderate', targets: { clauseIds: Object.keys(hints), hints, severity, findingIds } })
    return reply.status(202).send({ status: 'QUEUED', clauses: Object.keys(hints).length })
  })
}
