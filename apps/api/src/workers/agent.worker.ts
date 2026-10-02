/**
 * Agent Worker — handles agentQueue jobs:
 *   detect-binder    : LLM binder detection (Haiku, first 10K chars) → BINDER_DETECTED or classify-document
 *   classify-document: LLM contract type classification (Haiku, first 5K chars) → extract-ai
 *   extract-ai       : read, extract (agents /review/run) and save a contract's fields and clauses (lib/extraction-job.ts)
 *   classify-request : LLM intake classification (Haiku, 3K chars) → stores in request.metadata
 *   approval-summary : Phase 06 — AI executive summary for approvers (LangGraph 3-step pipeline)
 *   draft-contract   : a draft from a converted request, saved and analysed (lib/draft-save.ts)
 *   analysis-checkpoint: docs/41 P0.1 — an edited contract, analysed again once left alone (lib/analysis-trigger.ts)
 *   working-copy-idle: docs/41 Part 16 — draft changes left alone become a version (lib/working-copy.ts)
 */
import { Worker, type Job } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { queueClassifyDocument, queueExtractAi, queueSplitBinder } from '../lib/queue.js'
import { SPLIT_REQUIRES_PDF } from '../lib/binder-split.js'
import { docsToSplitSpecs } from '../lib/binder-pages.js'
import { onAgentJobFailed } from '../lib/agent-job-failure.js'
import { complianceStep } from '../lib/version-review-steps.js'
import { redlineTargets, uncheckedClauses, redlineClearNote, type ReviewFinding } from '../lib/playbook-redline-targets.js'
import type { DetectBinderJob, ClassifyDocumentJob, ExtractAiJob, ClassifyRequestJob, SplitBinderJob, RedlineAnalysisJob, ApprovalSummaryJob, PlaybookReviewJob, ComplianceReviewJob, ChangeAdviceJob, PlaybookRedlineJob, BackfillCustomFieldJob, ExtractObligationsJob, ExtractTypeFieldsJob, DetectClauseTypeJob, AnswerDiligenceColumnJob, AnswerDiligenceDocumentJob } from '../lib/queue.js'
import { extractObligationsForContract } from '../lib/obligation-extract.js'
import { runCustomFieldBackfill, type ExtractedField } from '../lib/custom-field-backfill.js'
import { readTypeFields, clearTypeFieldsMark } from '../lib/type-fields-read.js'
import { CostCapExceededError } from '../lib/costCap.js'
import { runDetect } from '../lib/clause-types.js'
import { agentsFindClause } from '../lib/clause-type-agents.js'
import { answerColumn, answerDocument } from '../lib/diligence-columns.js'
import { agentsAskFields } from '../lib/diligence-agents.js'
import { proposeClauseBatch } from '../lib/clause-propose-batch.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction, CLAUSE_TYPE_LABELS } from '@clm/types'
import { matchCategory } from '../lib/clause-category.js'
import { redactJson, restorePii, unresolvedPiiTokens } from '../lib/pii-policy.js'
import { htmlToText } from '../lib/html-text.js'
import { assertCostCapNotExceeded, estimateCostUsd, recordUsage } from '../lib/costCap.js'
import { modelFetch } from '../lib/model-boundary.js'
import { liabilityCaps } from '../lib/liability-cap.js'
import { runExtractionJob, recordRunUsage, type ExtractionJobData, type RunUsage } from '../lib/extraction-job.js'
import { callAgents } from '../lib/agents-call.js'
import { saveDraftVersion } from '../lib/draft-save.js'
import { draftFromRequest, type RequestDraftContext } from '../lib/request-draft.js'
import { runCheckpointAnalysis } from '../lib/analysis-trigger.js'
import { runJobStep, type StepOutcome } from '../lib/analysis-runs.js'
import { contractPlaybook } from '../lib/playbooks.js'
import { computeAndStoreFindings, positionCheckTargets, type PositionVerdict, type Verdict } from '../lib/review-findings.js'
import { normaliseText } from '../lib/fingerprint.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'


// playbook_check lives on THIS service's internal-ai plugin, not on the Python
// agents service. Same self-call shape agent-threads.ts uses.
const API_INTERNAL_URL = process.env.API_URL ?? 'http://localhost:3001'
const INTERNAL_SECRET  = process.env.INTERNAL_SERVICE_SECRET ?? ''

// ─── detect-binder ────────────────────────────────────────────────────────────

async function handleDetectBinder(data: DetectBinderJob): Promise<void> {
  const { contractId, versionId, orgId } = data
  console.info('[agent-worker] detect-binder start contractId=%s', contractId)

  // P2.3 — don't re-run binder detection on a contract that was itself
  // carved from a binder. Otherwise each child's plainText (which
  // starts with "MUTUAL NDA" / "MSA" headers) looks like a binder to
  // the LLM and we recurse forever.
  const contractMeta = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { parentContractId: true, relationshipType: true },
  })
  if (contractMeta?.parentContractId || contractMeta?.relationshipType === 'split_part') {
    console.info(
      '[agent-worker] detect-binder: skipping %s (already a split child: parent=%s, rel=%s)',
      contractId, contractMeta.parentContractId, contractMeta.relationshipType,
    )
    // Still move the child along the pipeline — queue the classifier.
    await prisma.contract.update({
      where: { id: contractId },
      data:  { analysisStatus: 'CLASSIFYING' },
    })
    queueClassifyDocument({ contractId, versionId, orgId })
    return
  }

  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true, mimeType: true },
  })
  if (!version?.plainText) {
    // Stale job from a previous run — a fresh parse job will re-queue detect-binder. Skip silently.
    console.warn('[agent-worker] detect-binder: plainText not yet ready for versionId=%s, skipping stale job', versionId)
    return
  }

  const res = await callAgents('/detect-binder', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ plainText: version.plainText, orgId }),
  }, { orgId, toolName: 'detect_binder', scope: contractId, contractId })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /detect-binder returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as {
    isBinder: boolean; confidence: number
    documents: Array<{ title: string; docType: string; charStart?: number; pageHint?: string }>
  }
  console.info('[agent-worker] detect-binder result contractId=%s isBinder=%s confidence=%.2f',
    contractId, result.isBinder, result.confidence)

  // C10 — splitting is PDF-only. A DOCX binder used to be auto-split anyway
  // and die inside pdf-lib after three retries. Flag it with the fix and
  // analyse it as one document instead.
  if (result.isBinder && result.confidence >= 0.7 && version.mimeType && version.mimeType !== 'application/pdf') {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } })
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        metadata: {
          ...((contract?.metadata as Record<string, unknown>) ?? {}),
          _binderDetected: true,
          _binderDocumentCount: result.documents.length,
          _binderSplitUnsupported: SPLIT_REQUIRES_PDF,
        } as never,
        analysisStatus: 'CLASSIFYING',
      },
    })
    queueClassifyDocument({ contractId, versionId, orgId })
    console.info('[agent-worker] detect-binder: non-PDF binder contractId=%s — not split, analysed as one document', contractId)
    return
  }

  if (result.isBinder && result.confidence >= 0.7) {
    // Fetch existing metadata (_totalPages stored by parse worker)
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { metadata: true },
    })
    const existingMeta = (contract?.metadata as Record<string, unknown>) ?? {}
    const totalPages = (existingMeta._totalPages as number) ?? 100  // fallback if not PDF

    // Concrete page ranges: from each agreement's offset in the text, else
    // from the model's "~page N" hints.
    const splits = docsToSplitSpecs(result.documents, totalPages, version.plainText.length)

    const metadata = {
      ...existingMeta,
      _binderDetected: true,
      _suggestedSplits: splits,
      _autoSplit: true,
    }
    await prisma.contract.update({
      where: { id: contractId },
      data: { metadata, analysisStatus: 'SPLITTING' },
    })

    // Auto-split immediately — user can correct after. P2.3 fix: use
    // the parent's real ownerId; 'system' isn't a valid FK target on
    // Contract.ownerId so the child .create() was silently failing.
    const parent = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { ownerId: true },
    })
    const userId = parent?.ownerId ?? ''
    if (!userId) {
      console.error('[agent-worker] detect-binder: no ownerId for contractId=%s; skipping split', contractId)
      return
    }
    queueSplitBinder({ contractId, orgId, userId, splits })
    console.info('[agent-worker] detect-binder: auto-splitting contractId=%s splits=%d owner=%s',
      contractId, splits.length, userId)
  } else {
    // Not a binder — proceed to classification
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'CLASSIFYING' },
    })
    queueClassifyDocument({ contractId, versionId, orgId })
  }
}

// ─── classify-document ────────────────────────────────────────────────────────

async function handleClassifyDocument(data: ClassifyDocumentJob): Promise<StepOutcome | void> {
  const { contractId, versionId, orgId, contractType: knownType } = data
  console.info('[agent-worker] classify-document start contractId=%s', contractId)

  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })
  if (!version?.plainText) {
    // Stale job from a previous run — a fresh parse/classify job will re-queue this. Skip silently.
    console.warn('[agent-worker] classify-document: plainText not yet ready for versionId=%s, skipping stale job', versionId)
    return { skipped: 'the document has no text yet' }
  }

  const res = await callAgents('/classify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ plainText: version.plainText, orgId }),
  }, { orgId, toolName: 'classify_document', scope: contractId, contractId })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /classify returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as { contractType: string; confidence: number; reason: string }
  // docs/39 A13 — a type a person set stands through a re-analysis.
  const current = await prisma.contract.findUnique({ where: { id: contractId }, select: { type: true, metadata: true } })
  const personType = (current?.metadata as Record<string, unknown> | null)?._typeSource === 'person' ? current?.type : undefined
  const resolvedType = knownType ?? personType ?? result.contractType
  console.info('[agent-worker] classify-document contractId=%s type=%s confidence=%.2f',
    contractId, resolvedType, result.confidence)

  await prisma.contract.update({
    where: { id: contractId },
    data: {
      type:           resolvedType,
      analysisStatus: 'EXTRACTING',
    },
  })

  queueExtractAi({ contractId, versionId, orgId, contractType: resolvedType, triggeredBy: 'upload', typeLocked: !!(knownType || personType) })
}

// ─── extract-ai ───────────────────────────────────────────────────────────────
// docs/39 A1 — the extraction runs inside this job, and is saved by it; see
// lib/extraction-job.ts. Saved through this API's own routes, as the agents
// service saved it when it ran in the background there.

async function apiWrite(method: 'PATCH' | 'POST', path: string, orgId: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${API_INTERNAL_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-internal-service': 'agents',
      'x-internal-secret': INTERNAL_SECRET,
      // Y1 — the write runs in the contract's tenant.
      'x-org-id': orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, text: await res.text().catch(() => '') }
}

async function handleExtractAi(job: Job<ExtractionJobData>): Promise<void> {
  const { contractId, orgId, triggeredBy } = job.data
  console.info('[agent-worker] extract-ai start contractId=%s triggeredBy=%s attempt=%d', contractId, triggeredBy, job.attemptsMade + 1)
  const agentsHeaders = { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' }
  const outcome = await runExtractionJob(job, {
    review: (body, text) => callAgents('/review/run', { method: 'POST', headers: agentsHeaders, body: JSON.stringify(body) },
      { orgId, toolName: 'extraction', scope: contractId, contractId, context: text, estimate: false }),
    reviewLegacy: (body, text) => callAgents('/review', { method: 'POST', headers: agentsHeaders, body: JSON.stringify(body) },
      { orgId, toolName: 'extraction', scope: contractId, contractId, context: text }),
    api: apiWrite,
  })
  console.info('[agent-worker] extract-ai %s contractId=%s', outcome, contractId)
}

// ─── classify-request ────────────────────────────────────────────────────────

async function handleClassifyRequest(data: ClassifyRequestJob): Promise<void> {
  const { requestId, orgId } = data
  console.info('[agent-worker] classify-request start requestId=%s', requestId)

  const request = await prisma.contractRequest.findUnique({
    where: { id: requestId },
    select: { title: true, description: true, counterpartyName: true },
  })
  if (!request) throw new Error(`Request not found: ${requestId}`)

  const res = await callAgents('/intake-classify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({
      title:           request.title,
      description:     request.description,
      counterpartyName: request.counterpartyName ?? undefined,
      orgId,
    }),
  }, {
    orgId, toolName: 'classify_request', scope: requestId,
    // One text, so a card number in the description counts as one when the
    // word "card" is in the title.
    context: [request.title, request.description, request.counterpartyName].filter(Boolean).join('\n'),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /intake-classify returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as {
    contractType: string; suggestedPriority: string
    extractedTerms: Record<string, unknown>; confidence: number; reason: string
  }
  console.info('[agent-worker] classify-request requestId=%s type=%s confidence=%.2f',
    requestId, result.contractType, result.confidence)

  // Build update — always store AI classification; update type only if high confidence
  const existingMeta = (await prisma.contractRequest.findUnique({
    where: { id: requestId }, select: { metadata: true },
  }))?.metadata as Record<string, unknown> ?? {}

  const updateData: Record<string, unknown> = {
    metadata: { ...existingMeta, _aiClassification: result },
  }
  if (result.confidence >= 0.75) {
    updateData.type = result.contractType
  }

  await prisma.contractRequest.update({
    where: { id: requestId },
    data:  updateData as Parameters<typeof prisma.contractRequest.update>[0]['data'],
  })
}

// ─── redline-analysis ────────────────────────────────────────────────────────

async function handleRedlineAnalysis(data: RedlineAnalysisJob): Promise<void> {
  const { contractId, v1Id, v2Id, orgId, userId, contractType } = data
  console.info('[agent-worker] redline-analysis start contractId=%s v1=%s v2=%s', contractId, v1Id, v2Id)

  const res = await callAgents('/redline', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ contractId, v1Id, v2Id, orgId, userId, contractType }),
  }, { orgId, toolName: 'redline', scope: contractId, contractId })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /redline returned ${res.status}: ${text.slice(0, 200)}`)
  }

  createAuditEvent({
    orgId,
    userId,
    action: AuditAction.REDLINE_ANALYZED,
    resourceType: 'contract',
    resourceId: contractId,
    metadata: { v1Id, v2Id },
  }).catch(() => {})

  console.info('[agent-worker] redline-analysis queued in agents service contractId=%s', contractId)
}

// ─── playbook-review ─────────────────────────────────────────────────────────
// Single-document playbook scoring, queued automatically once extraction lands.
// Redline analysis needs two versions to diff, so a contract received from a
// counterparty could never be scored against the playbook — the automatic
// pipeline only produced generic per-clause risk ratings and never loaded a
// playbook position at all.

/**
 * Phase 3 — whole-document redline against the playbook.
 *
 * check -> batch propose -> STAGE. Deliberately does not apply: the markup is
 * a proposal for a lawyer to review, and writing it into the contract first
 * would make it an unreviewed edit rather than a redline.
 *
 * Progress lands in `contract.metadata._playbookRedlineStatus` because that is
 * how every other long AI job in this codebase reports, and the detail page
 * already polls it at 4s. Holding it in memory would lose the run the moment
 * the user navigated away, and these take minutes.
 */
async function handlePlaybookRedline(data: PlaybookRedlineJob): Promise<void> {
  const { contractId, orgId, userId, versionId, aggression } = data

  const setMeta = async (patch: Record<string, unknown>) => {
    // Re-read before merging: other workers write sibling keys on the same
    // JSON column, and a stale spread would drop theirs.
    const row = await prisma.contract.findUnique({
      where: { id: contractId }, select: { metadata: true },
    })
    if (!row) return
    await prisma.contract.update({
      where: { id: contractId },
      data:  { metadata: { ...(row.metadata as object ?? {}), ...patch } as never },
    })
  }

  try {
    await setMeta({ _playbookRedlineStatus: 'RUNNING' })

    // docs/41 P1 — "Fix all fixable": the review's findings already say which
    // clauses and why; nothing is worked out again.
    if (data.targets?.clauseIds.length) {
      const { clauseIds, hints, severity = {}, findingIds = {} } = data.targets
      const proposed = await proposeClauseBatch({ orgId, contractId, clauseIds, aggression, hints })
      if (!proposed.ok) throw new Error(`${proposed.detail}${proposed.upstream ? `: ${proposed.upstream}` : ''}`)
      const rows = await prisma.contractClause.findMany({ where: { id: { in: clauseIds } }, select: { id: true, content: true, sectionRef: true } })
      const byId = new Map(rows.map(c => [c.id, c]))
      const proposals = proposed.data.proposals.map(p => ({
        clauseId: p.clauseId, clauseType: p.clauseType,
        sectionRef: byId.get(p.clauseId)?.sectionRef ?? null,
        originalText: byId.get(p.clauseId)?.content ?? '',
        proposedText: p.proposedText, rationale: p.rationale, changes: p.changes,
        severity: severity[p.clauseId] ?? null, findingId: findingIds[p.clauseId] ?? null, error: p.error,
      }))
      await setMeta({
        _playbookRedlineStatus: 'DONE',
        _playbookRedline: {
          versionId, aggression, proposals, source: 'review',
          deviationCount: clauseIds.length,
          proposedCount: proposals.filter(p => p.proposedText).length,
          failedCount: proposals.filter(p => p.error).length,
          worstSeverity: null, truncated: false, uncoveredClauses: 0,
          stagedAt: new Date().toISOString(),
        },
      })
      return
    }

    // 1. Which clauses deviate. Ask for the WHOLE document — Phase 0 raised the
    //    cap for exactly this caller.
    const checkRes = await fetch(`${API_INTERNAL_URL}/api/internal/ai/tools/playbook_check`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ orgId, contractId, maxClauses: 500 }),
    })
    if (!checkRes.ok) {
      throw new Error(`playbook_check ${checkRes.status}: ${(await checkRes.text()).slice(0, 200)}`)
    }
    const checked = await checkRes.json() as {
      summary?: { deviationCount?: number; worstSeverity?: string | null; truncated?: boolean; uncoveredClauses?: number }
      checks?: Array<{ clauseId: string; clauseType: string; passed: boolean; failedCount: number; worstSeverity: string | null; excerpt?: string }>
    }

    // What the rail's playbook review flagged, as well as what the rules
    // caught (lib/playbook-redline-targets.ts has why).
    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { metadata: true } })
    const review = (row?.metadata as { _playbookReview?: { versionId?: string; findings?: ReviewFinding[]; clausesReviewed?: number } } | null)?._playbookReview
    const { clauseIds: deviatingIds, hints, severity: bySeverity } = redlineTargets(checked.checks ?? [], review, versionId)
    // "Could not be checked" means neither the rules nor the review judged it.
    const uncoveredClauses = await uncheckedClauses(versionId, review, checked.summary?.uncoveredClauses ?? 0)
    if (deviatingIds.length === 0) {
      // docs/41 P0.7 — zero clauses checked is not an all-clear.
      const clauseCount = await prisma.contractClause.count({ where: { versionId, isSubChunk: false } })
      await setMeta({
        _playbookRedlineStatus: 'DONE',
        _playbookRedline: {
          versionId, aggression, proposals: [], deviationCount: 0,
          worstSeverity: checked.summary?.worstSeverity ?? null,
          truncated: checked.summary?.truncated ?? false,
          uncoveredClauses,
          clauseCount,
          stagedAt: new Date().toISOString(),
          note: redlineClearNote(clauseCount, (checked.checks ?? []).length),
        },
      })
      return
    }

    // 2. One batched rewrite for all of them.
    const proposed = await proposeClauseBatch({
      orgId, contractId,
      clauseIds: deviatingIds,
      aggression,
      hints,
    })
    if (!proposed.ok) {
      throw new Error(`${proposed.detail}${proposed.upstream ? `: ${proposed.upstream}` : ''}`)
    }

    // 3. Stage. Carry the ORIGINAL text alongside each rewrite so the reviewer
    //    sees both sides without another round-trip, and so the apply step can
    //    verify it is replacing what the reviewer actually saw.
    const clauses = await prisma.contractClause.findMany({
      where:  { id: { in: deviatingIds } },
      select: { id: true, content: true, sectionRef: true },
    })
    const contentById = new Map(clauses.map(c => [c.id, c]))

    const proposals = proposed.data.proposals.map(p => ({
      clauseId:     p.clauseId,
      clauseType:   p.clauseType,
      sectionRef:   contentById.get(p.clauseId)?.sectionRef ?? null,
      originalText: contentById.get(p.clauseId)?.content ?? '',
      proposedText: p.proposedText,
      rationale:    p.rationale,
      // The rewrite's own edits: how a clause that runs across paragraphs is
      // applied (lib/clause-apply.ts planEdits).
      changes:      p.changes,
      severity:     bySeverity.get(p.clauseId) ?? null,
      // Present instead of proposedText when this clause could not be
      // rewritten. Reported rather than omitted: an omitted clause reads as
      // "no change needed", which is the miss this feature exists to remove.
      error:        p.error,
    }))

    await setMeta({
      _playbookRedlineStatus: 'DONE',
      _playbookRedline: {
        versionId, aggression, proposals,
        deviationCount:   deviatingIds.length,
        proposedCount:    proposals.filter(p => p.proposedText).length,
        failedCount:      proposals.filter(p => p.error).length,
        worstSeverity:    checked.summary?.worstSeverity ?? null,
        truncated:        checked.summary?.truncated ?? false,
        uncoveredClauses,
        stagedAt:         new Date().toISOString(),
      },
    })

    createAuditEvent({
      orgId, userId,
      action:       AuditAction.AGENT_TOOL_APPLIED,
      resourceType: 'contract',
      resourceId:   contractId,
      metadata: { via: 'playbook-redline', deviationCount: deviatingIds.length, proposed: proposals.filter(p => p.proposedText).length },
    }).catch(() => {})
  } catch (err) {
    // Surface the reason. A run that fails silently looks identical to one
    // still working, and these take minutes.
    console.error('[agent-worker] playbook-redline failed contractId=%s: %s', contractId, (err as Error).message)
    await setMeta({
      _playbookRedlineStatus: 'FAILED',
      _playbookRedlineError:  (err as Error).message.slice(0, 300),
    }).catch(() => {})
  }
}

/** The built-in clause type a playbook category is (the first that names it). */
function clauseTypeFor(categoryName: string | null | undefined): string | null {
  if (!categoryName) return null
  const cat = { id: 'c', name: categoryName }
  return Object.keys(CLAUSE_TYPE_LABELS).find(t => matchCategory([cat], t)) ?? null
}

/**
 * docs/41 P1 (Part 7) — the model's position check, after the findings.
 *
 * Only the clauses the findings say changed since the baseline (all of them
 * on a contract with none) and that aren't standard (still the template's
 * words) are sent, each judged against the positions of the playbook this
 * contract is reviewed against: a verdict, a quote and a sentence, stored on
 * the clause. The findings are then worked out again with the verdicts in.
 * The model judges clauses; it never writes the recommendation.
 */
async function handlePlaybookReview(data: PlaybookReviewJob): Promise<StepOutcome> {
  const { contractId, orgId } = data

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, type: true, currentVersionId: true, playbookId: true },
  })
  if (!contract) {
    console.info('[agent-worker] playbook-review skip contractId=%s — contract gone', contractId)
    return { skipped: 'the contract was deleted' }
  }
  // DD2 — a review after edits takes the version the contract stands on now.
  const versionId = data.versionId ?? contract.currentVersionId
  if (!versionId) return { skipped: 'the contract has no version' }

  // Which clauses changed, and which are standard: the findings, fresh.
  const review = await computeAndStoreFindings(contractId, versionId)
  if (!review) return { skipped: 'the version is gone' }
  const rows = await prisma.contractClause.findMany({
    where:   { versionId, isSubChunk: false },
    select:  { id: true, clauseType: true, content: true, sectionRef: true, sortOrder: true, positionVerdict: true, sourceRef: true },
    orderBy: { sortOrder: 'asc' },
  })
  if (rows.length === 0) {
    console.info('[agent-worker] playbook-review skip contractId=%s — no clauses extracted', contractId)
    return { skipped: 'no clauses to check' }
  }
  const targets = positionCheckTargets(
    rows.map(r => ({ ...r, positionVerdict: r.positionVerdict as PositionVerdict | null, standardSource: r.sourceRef })),
    review.changedClauseIds,
  )
  const standard = review.standardClauseIds.length
  if (targets.length === 0) {
    return { skipped: standard ? 'every changed clause is standard or already checked' : 'no changed clauses to check', counts: { checked: 0, standard } }
  }

  // docs/41 P1 — the positions of the playbook this contract is reviewed
  // against (lib/playbooks.ts), for its type.
  const { resolution, where: positionScope } = await contractPlaybook(orgId, contract)
  const relevant = positionScope ? await prisma.playbookPosition.findMany({
    where:  positionScope,
    select: {
      id: true, positionType: true, content: true, notes: true, contractTypes: true,
      clauseCategory: { select: { name: true } },
    },
  }) : []
  if (relevant.length === 0) {
    console.info('[agent-worker] playbook-review skip contractId=%s — no playbook positions for type=%s',
      contractId, contract.type)
    return { skipped: resolution.playbook ? `${resolution.playbook.name} has no positions for this type` : resolution.explanation, counts: { checked: 0, standard } }
  }

  const res = await callAgents('/playbook-review', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({
      contractId,
      orgId,
      mode: 'positions',
      // DD1 — a clause's caps, measured from its words, so the review states
      // them instead of working them out.
      clauses: targets.map(c => {
        const facts = liabilityCaps(c.content).map(x => x.statement)
        return { id: c.id, clauseType: c.clauseType, content: c.content, sectionRef: c.sectionRef, ...(facts.length && { facts }) }
      }),
      playbookPositions: relevant.map(p => ({
        id:           p.id,
        clauseType:   p.clauseCategory?.name ?? 'other',
        positionType: p.positionType,
        content:      htmlToText(p.content),
        notes:        p.notes,
      })),
      contractType: contract.type,
    }),
  }, {
    orgId, toolName: 'playbook_review', scope: contractId, contractId,
    // The clauses are sent one by one; the document decides what counts as PII.
    context: (await prisma.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true } }))?.plainText,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /playbook-review returned ${res.status}: ${text.slice(0, 200)}`)
  }
  const result = await res.json() as { verdicts?: Array<{ clauseId: string; positionId: string | null; verdict: Verdict; quote: string; explanation: string }> }

  // Each verdict on its clause, with a quote that is really in the clause:
  // a quote the model made up is replaced by the clause's own words.
  const typeOf = new Map(relevant.map(p => [p.id, p.positionType]))
  const at = new Date().toISOString()
  let stored = 0
  for (const v of result.verdicts ?? []) {
    const clause = targets.find(c => c.id === v.clauseId)
    if (!clause) continue
    const real = v.quote && normaliseText(clause.content).includes(normaliseText(v.quote))
    const verdict: PositionVerdict = {
      positionId: v.positionId, verdict: v.verdict,
      quote: real ? v.quote : clause.content.slice(0, 300),
      explanation: v.explanation || 'No reason was given.',
      positionType: v.positionId ? typeOf.get(v.positionId) ?? null : null,
      at,
    }
    // docs/41 P1 — new text from an edit has no type yet: the position it
    // was judged against names it (the only re-classification an edit gets).
    const retyped = clause.clauseType === 'unclassified' && v.positionId ? clauseTypeFor(relevant.find(p => p.id === v.positionId)?.clauseCategory?.name) : null
    await prisma.contractClause.update({ where: { id: clause.id }, data: { positionVerdict: verdict as object, ...(retyped && { clauseType: retyped }) } })
    stored++
  }

  // The rail's older review and the redline targets read this; kept for a release (docs/41 Part 8).
  const verdicts = result.verdicts ?? []
  const legacy = verdicts.filter(v => v.verdict !== 'meets_preferred' && v.verdict !== 'not_covered').map(v => {
    const walkaway = v.positionId && typeOf.get(v.positionId) === 'walkaway'
    return {
      clauseId: v.clauseId,
      clauseType: targets.find(c => c.id === v.clauseId)?.clauseType ?? 'other',
      playbookAlignment: v.verdict === 'meets_fallback' ? 'fallback' : walkaway ? 'walkaway' : 'outside_playbook',
      severity: v.verdict === 'meets_fallback' ? 'low' : walkaway ? 'critical' : 'high',
      recommendation: v.verdict === 'meets_fallback' ? 'accept' : 'negotiate',
      reasoning: v.explanation,
      requiresHumanReview: v.verdict !== 'meets_fallback',
    }
  })
  await prisma.$executeRaw`UPDATE contracts SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_playbookReview}', ${JSON.stringify({
    findings: legacy,
    summary: legacy.length ? `${legacy.length} of ${targets.length} changed clause(s) are not at your preferred position.` : `Checked ${targets.length} changed clause(s) against your playbook.`,
    requiresHumanGate: legacy.some(f => f.requiresHumanReview),
    clausesReviewed: targets.length,
    playbookPositions: relevant.length,
    playbook: resolution.playbook ? { id: resolution.playbook.id, name: resolution.playbook.name, version: resolution.playbook.version } : null,
    reviewedAt: at,
    versionId,
  })}::jsonb) WHERE id = ${contractId}`

  // The findings again, with the verdicts in.
  await computeAndStoreFindings(contractId, versionId)
  console.info('[agent-worker] playbook-review done contractId=%s checked=%d verdicts=%d standard=%d', contractId, targets.length, stored, standard)
  return { counts: { checked: targets.length, verdicts: stored, standard } }
}

// ─── approval-summary ─────────────────────────────────────────────────────────

async function handleApprovalSummary(data: ApprovalSummaryJob): Promise<void> {
  const { instanceId, contractId, versionId, orgId, approverIds } = data
  console.info('[agent-worker] approval-summary start instanceId=%s contractId=%s', instanceId, contractId)

  const res = await callAgents('/approval-summary', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ instanceId, contractId, versionId, orgId, approverIds }),
  }, { orgId, toolName: 'approval_summary', scope: contractId, contractId })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /approval-summary returned ${res.status}: ${text.slice(0, 200)}`)
  }
  console.info('[agent-worker] approval-summary queued in agents service instanceId=%s', instanceId)
}

// ─── draft-contract ──────────────────────────────────────────────────────────

/**
 * The convert route's `_draftContext` (routes/requests.ts), plus what the
 * requester picked on the request page (docs/41 Part 1).
 */
type DraftContractJobData = RequestDraftContext & {
  contractId: string
  orgId: string
  userId: string
}

/**
 * docs/41 Part 1 — the request's draft, made as the assistant makes one: the
 * template and the clause slots chosen by rule (lib/draft-plan.ts), the
 * agent asked only to read values out of the request's words, with quotes
 * (lib/request-draft.ts). No LLM picks a template or a clause.
 */
async function handleDraftContract(data: DraftContractJobData): Promise<void> {
  const { contractId, orgId, userId, contractType } = data
  console.info('[agent-worker] draft-contract start contractId=%s type=%s', contractId, contractType)
  const result = await draftFromRequest({ orgId, contractId, ctx: data })
  await saveDraftVersion({ contractId, orgId, userId, result, changeNote: 'AI-generated first draft', source: 'request' })
  console.info('[agent-worker] draft-contract done contractId=%s template=%s', contractId, result.usedTemplateId)
}

// ─── backfill-custom-field (X2) ──────────────────────────────────────────────
// See lib/custom-field-backfill.ts. The extraction goes through callAgents, so
// the org's PII policy and cost cap apply as on every other job.

async function handleBackfillCustomField(data: BackfillCustomFieldJob): Promise<void> {
  const state = await runCustomFieldBackfill(data, async ({ orgId, contractId, body }) => {
    const res = await callAgents('/extract-fields', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body:    JSON.stringify(body),
    }, { orgId, toolName: 'backfill_custom_field', scope: contractId, contractId, estimate: false })
    if (!res.ok) throw new Error(`Agents /extract-fields returned ${res.status}`)
    const reply = await res.json() as { customFields?: Record<string, ExtractedField>; usage?: RunUsage }
    // A15 — the call's real use, priced per model.
    await recordRunUsage(orgId, reply.usage, { inputChars: JSON.stringify(body).length, outputChars: JSON.stringify(reply).length }, 'backfill_custom_field')
    return reply.customFields ?? null
  })
  console.info('[agent-worker] backfill-custom-field field=%s status=%s processed=%d filled=%d failed=%d',
    data.fieldDefinitionId, state?.status, state?.processed ?? 0, state?.filled ?? 0, state?.failed ?? 0)
}

// ─── extract-obligations (docs/39 G4) ────────────────────────────────────────
// A signed contract read for its obligations after its analysis, or in bulk
// from the Obligations page. What it finds is suggested until a person
// confirms it (lib/obligation-extract.ts).

// ─── extract-type-fields (docs/39 A13) ───────────────────────────────────────
// A retyped contract reads its new type's own fields, and only those.

async function handleExtractTypeFields(data: ExtractTypeFieldsJob): Promise<void> {
  const r = await readTypeFields({
    contractId: data.contractId, orgId: data.orgId, contractType: data.contractType,
    call: async body => {
      const res = await callAgents('/extract-fields', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
        body:    JSON.stringify(body),
      }, { orgId: data.orgId, toolName: 'extract_type_fields', scope: data.contractId, contractId: data.contractId, estimate: false }).catch((err: Error) => {
        // Said so a person can act on it: a read that fails is on the page (_typeFieldsRead).
        if (err instanceof CostCapExceededError) throw new Error('today’s AI budget is used up')
        throw new Error(err.message === 'fetch failed' ? 'the AI service didn’t answer' : err.message)
      })
      if (!res.ok) throw new Error(`the AI service answered ${res.status}`)
      const reply = await res.json() as { customFields?: Record<string, { value: unknown; confidence?: number; quote?: string; issue?: string }>; usage?: RunUsage }
      await recordRunUsage(data.orgId, reply.usage, { inputChars: JSON.stringify(body).length, outputChars: JSON.stringify(reply).length }, 'extract_type_fields')
      return reply.customFields ?? null
    },
  })
  // The retype marked it as being read; it's done (or there was nothing to
  // read). A later retype's read is its own, and finishes itself.
  await prisma.contract.updateMany({ where: { id: data.contractId, type: data.contractType, analysisStatus: 'ANALYZING' }, data: { analysisStatus: 'DONE' } })
  await clearTypeFieldsMark(data.contractId, data.contractType)
  console.info('[agent-worker] extract-type-fields contract=%s type=%s written=%d', data.contractId, data.contractType, r?.written.length ?? 0)
}

async function handleExtractObligations(data: ExtractObligationsJob): Promise<void> {
  const r = await extractObligationsForContract({ orgId: data.orgId, contractId: data.contractId, userId: 'system' })
  console.info('[agent-worker] extract-obligations contract=%s ok=%s suggested=%d%s',
    data.contractId, r.ok, r.count, r.skippedReason ? ` skipped=${r.skippedReason}` : '')
  // A failed read is retried (the job's attempts); one with nothing to read is done.
  if (!r.ok && r.error) throw new Error(r.error)
}

export const agentWorker = new Worker(
  'agents',
  async (job) => {
    console.info('[worker:agents] → start name=%s id=%s', job.name, job.id)
    if (job.name === 'detect-binder') {
      // docs/41 P1 — each analysis step records itself on the version's run.
      const data = job.data as DetectBinderJob
      await runJobStep(job, data, () => handleDetectBinder(data))
    } else if (job.name === 'classify-document') {
      const data = job.data as ClassifyDocumentJob
      await runJobStep(job, data, () => handleClassifyDocument(data))
    } else if (job.name === 'extract-ai') {
      const data = job.data as ExtractionJobData
      await runJobStep(job, data, () => handleExtractAi(job as Job<ExtractionJobData>))
    } else if (job.name === 'classify-request') {
      await handleClassifyRequest(job.data as ClassifyRequestJob)
    } else if (job.name === 'redline-analysis') {
      await handleRedlineAnalysis(job.data as RedlineAnalysisJob)
    } else if (job.name === 'playbook-redline') {
      await handlePlaybookRedline(job.data as PlaybookRedlineJob)
    } else if (job.name === 'playbook-review') {
      const data = job.data as PlaybookReviewJob
      // A review asked for after edits takes the version the contract stands on.
      const versionId = data.versionId ?? (await prisma.contract.findUnique({ where: { id: data.contractId }, select: { currentVersionId: true } }))?.currentVersionId
      await runJobStep(job, { contractId: data.contractId, versionId }, () => handlePlaybookReview(data))
    } else if (job.name === 'compliance-review') {
      // docs/41 Part 9 — which compliance frameworks apply, their checks and findings.
      const data = job.data as ComplianceReviewJob
      await runJobStep(job, data, () => complianceStep(data.contractId, data.versionId))
    } else if (job.name === 'change-advice') {
      // docs/41 Part 15 — the model's advice on a counterparty version's changes, on their findings.
      const data = job.data as ChangeAdviceJob
      const { changeAdviceStep } = await import('../lib/change-advice.js')
      await runJobStep(job, data, () => changeAdviceStep(data.contractId, data.versionId))
    } else if (job.name === 'approval-summary') {
      await handleApprovalSummary(job.data as ApprovalSummaryJob)
    } else if (job.name === 'draft-contract') {
      await handleDraftContract(job.data as DraftContractJobData)
    } else if (job.name === 'analysis-checkpoint') {
      // docs/41 P0.1 — an edited contract, left alone long enough: analysed again.
      const outcome = await runCheckpointAnalysis(job.data as { contractId: string; orgId: string })
      console.info('[agent-worker] analysis-checkpoint contractId=%s %s', (job.data as { contractId: string }).contractId, outcome)
    } else if (job.name === 'working-copy-idle') {
      // docs/41 Part 16 (C1) — draft changes nobody touched for a while: saved as a version.
      const { runIdleCheckpoint } = await import('../lib/working-copy.js')
      const outcome = await runIdleCheckpoint(job.data as { orgId: string; contractId: string; revision: number })
      console.info('[agent-worker] working-copy-idle contractId=%s %s', (job.data as { contractId: string }).contractId, outcome)
    } else if (job.name === 'backfill-custom-field') {
      await handleBackfillCustomField(job.data as BackfillCustomFieldJob)
    } else if (job.name === 'extract-obligations') {
      await handleExtractObligations(job.data as ExtractObligationsJob)
    } else if (job.name === 'extract-type-fields') {
      await handleExtractTypeFields(job.data as ExtractTypeFieldsJob)
    } else if (job.name === 'detect-clause-type') {
      // docs/39 E3 — a new clause type, found in the contracts read before it.
      const state = await runDetect(job.data as DetectClauseTypeJob, agentsFindClause('clause_detect'))
      console.info('[agent-worker] detect-clause-type %s processed=%d found=%d status=%s', (job.data as DetectClauseTypeJob).definitionId, state?.processed ?? 0, state?.found ?? 0, state?.status ?? 'gone')
    } else if (job.name === 'answer-diligence-column') {
      // docs/39 D6 — a diligence room's question (or field) answered for its documents.
      const data = job.data as AnswerDiligenceColumnJob
      const run = await answerColumn(data, agentsAskFields())
      console.info('[agent-worker] answer-diligence-column %s processed=%d answered=%d failed=%d status=%s', data.columnId, run?.processed ?? 0, run?.answered ?? 0, run?.failed ?? 0, run?.status ?? 'gone')
    } else if (job.name === 'answer-diligence-document') {
      // docs/39 D6 — a room's document read after its questions were asked.
      const data = job.data as AnswerDiligenceDocumentJob
      const asked = await answerDocument(data, agentsAskFields())
      console.info('[agent-worker] answer-diligence-document %s asked=%d', data.contractId, asked)
    }
  },
  { connection: redis, concurrency: 2 }
)

agentWorker.on('completed', (job) => {
  console.info('[worker:agents] ✓ job done name=%s id=%s', job.name, job.id)
})

agentWorker.on('failed', async (job, err) => {
  console.error('[worker:agents] ✗ job failed name=%s id=%s attempt=%d/%d err=%s',
    job?.name, job?.id, job?.attemptsMade ?? 0, job?.opts?.attempts ?? 2, err.message)
  // Follow-on jobs (playbook review and redline, redline analysis, approval
  // summary) run after extraction succeeded: they record their own failure,
  // never the contract's analysis (lib/agent-job-failure.ts, X57).
  await onAgentJobFailed(job, err)
})
