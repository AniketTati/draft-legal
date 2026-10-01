/**
 * Agent Worker — handles agentQueue jobs:
 *   detect-binder    : LLM binder detection (Haiku, first 10K chars) → BINDER_DETECTED or classify-document
 *   classify-document: LLM contract type classification (Haiku, first 5K chars) → extract-ai
 *   extract-ai       : read, extract (agents /review/run) and save a contract's fields and clauses (lib/extraction-job.ts)
 *   classify-request : LLM intake classification (Haiku, 3K chars) → stores in request.metadata
 *   approval-summary : Phase 06 — AI executive summary for approvers (LangGraph 3-step pipeline)
 *   draft-contract   : a draft from a converted request, saved and analysed (lib/draft-save.ts)
 *   analysis-checkpoint: docs/41 P0.1 — an edited contract, analysed again once left alone (lib/analysis-trigger.ts)
 */
import { Worker, type Job } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { queueClassifyDocument, queueExtractAi, queueSplitBinder } from '../lib/queue.js'
import { SPLIT_REQUIRES_PDF } from '../lib/binder-split.js'
import { docsToSplitSpecs } from '../lib/binder-pages.js'
import { onAgentJobFailed } from '../lib/agent-job-failure.js'
import { redlineTargets, uncheckedClauses, redlineClearNote, type ReviewFinding } from '../lib/playbook-redline-targets.js'
import type { DetectBinderJob, ClassifyDocumentJob, ExtractAiJob, ClassifyRequestJob, SplitBinderJob, RedlineAnalysisJob, ApprovalSummaryJob, PlaybookReviewJob, PlaybookRedlineJob, BackfillCustomFieldJob, ExtractObligationsJob, ExtractTypeFieldsJob, DetectClauseTypeJob, AnswerDiligenceColumnJob, AnswerDiligenceDocumentJob } from '../lib/queue.js'
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
import { AuditAction } from '@clm/types'
import { redactJson, restorePii, unresolvedPiiTokens } from '../lib/pii-policy.js'
import { htmlToText } from '../lib/html-text.js'
import { assertCostCapNotExceeded, estimateCostUsd, recordUsage } from '../lib/costCap.js'
import { modelFetch } from '../lib/model-boundary.js'
import { liabilityCaps } from '../lib/liability-cap.js'
import { runExtractionJob, recordRunUsage, type ExtractionJobData, type RunUsage } from '../lib/extraction-job.js'
import { callAgents } from '../lib/agents-call.js'
import { saveDraftVersion, requestTerms, type DraftAgentResult } from '../lib/draft-save.js'
import { runCheckpointAnalysis } from '../lib/analysis-trigger.js'

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
  if (contractMeta?.parentContractId || contractMeta?.relationshipType === 'exhibit_only') {
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

async function handleClassifyDocument(data: ClassifyDocumentJob): Promise<void> {
  const { contractId, versionId, orgId, contractType: knownType } = data
  console.info('[agent-worker] classify-document start contractId=%s', contractId)

  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })
  if (!version?.plainText) {
    // Stale job from a previous run — a fresh parse/classify job will re-queue this. Skip silently.
    console.warn('[agent-worker] classify-document: plainText not yet ready for versionId=%s, skipping stale job', versionId)
    return
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

async function handlePlaybookReview(data: PlaybookReviewJob): Promise<void> {
  const { contractId, orgId } = data

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, type: true, currentVersionId: true },
  })
  if (!contract) {
    console.info('[agent-worker] playbook-review skip contractId=%s — contract gone', contractId)
    return
  }
  // DD2 — a review after edits takes the version the contract stands on now.
  const versionId = data.versionId ?? contract.currentVersionId
  if (!versionId) return

  // Review the version that was just extracted, not whatever is "current" by
  // the time this runs — the pointer may have moved on, and the stamp below
  // must describe the document actually scored.
  const clauses = await prisma.contractClause.findMany({
    where:   { versionId, isSubChunk: false },
    select:  { id: true, clauseType: true, content: true, sectionRef: true },
    orderBy: { id: 'asc' },
  })
  if (clauses.length === 0) {
    console.info('[agent-worker] playbook-review skip contractId=%s — no clauses extracted', contractId)
    return
  }

  const positions = await prisma.playbookPosition.findMany({
    where:  { orgId },
    select: {
      positionType: true, content: true, notes: true, contractTypes: true,
      clauseCategory: { select: { name: true } },
    },
  })
  // A position pinned to specific contract types must not be applied to others.
  const relevant = positions.filter(
    p => p.contractTypes.length === 0 || p.contractTypes.includes(contract.type),
  )
  if (relevant.length === 0) {
    console.info('[agent-worker] playbook-review skip contractId=%s — no playbook positions for type=%s',
      contractId, contract.type)
    return
  }

  const res = await callAgents('/playbook-review', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({
      contractId,
      orgId,
      // DD1 — a clause's caps, measured from its words, so the review states
      // them instead of working them out.
      clauses: clauses.map(c => {
        const facts = liabilityCaps(c.content).map(x => x.statement)
        return facts.length ? { ...c, facts } : c
      }),
      playbookPositions: relevant.map(p => ({
        clauseType:   p.clauseCategory?.name ?? 'other',
        positionType: p.positionType,
        content:      p.content,
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
  const result = await res.json() as {
    findings: unknown[]
    summary: string
    requiresHumanGate: boolean
    clausesReviewed: number
    playbookPositions: number
  }

  // Re-read metadata immediately before merging. The LLM round-trip above can
  // take tens of seconds, and anything written to contract.metadata in that
  // window (e.g. POST /:id/redline setting _redlineStatus) would be silently
  // clobbered by a snapshot taken before the call.
  const fresh = await prisma.contract.findUnique({
    where:  { id: contractId },
    select: { metadata: true },
  })
  const existing = (fresh?.metadata as Record<string, unknown> | null) ?? {}
  await prisma.contract.update({
    where: { id: contractId },
    data:  {
      metadata: {
        ...existing,
        _playbookReview: {
          ...result,
          reviewedAt: new Date().toISOString(),
          versionId,
        },
      } as never,
    },
  })

  console.info('[agent-worker] playbook-review done contractId=%s findings=%d gate=%s',
    contractId, result.findings.length, result.requiresHumanGate)
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

interface DraftContractJobData {
  contractId: string
  orgId: string
  userId: string
  requestTitle: string
  requestDescription: string
  contractType: string
  counterpartyName?: string
  estimatedValue?: number
  /**
   * docs/41 P0.4 — what the intake classifier read from the request
   * (governing law, term, value…). It was dropped at convert, so a request
   * that said "New York law" drafted as Delaware.
   */
  extractedTerms?: Record<string, unknown>
}

async function handleDraftContract(data: DraftContractJobData): Promise<void> {
  const { contractId, orgId, userId, requestTitle, requestDescription, contractType, counterpartyName, estimatedValue, extractedTerms } = data
  console.info('[agent-worker] draft-contract start contractId=%s type=%s', contractId, contractType)

  const userMessage = `Draft a ${contractType} titled "${requestTitle}". ${requestDescription ?? ''}`
  const context: Record<string, unknown> = {}
  if (counterpartyName) context.counterpartyName = counterpartyName
  if (estimatedValue) context.estimatedValue = estimatedValue
  const terms = requestTerms(extractedTerms)
  if (Object.keys(terms).length) context.requestTerms = terms

  const res = await callAgents('/draft', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({
      user_message: userMessage,
      org_id: orgId,
      user_id: userId,
      context,
    }),
  }, { orgId, toolName: 'draft_contract', scope: contractId, contractId })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /draft returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as DraftAgentResult

  if (result.error || !result.html) {
    throw new Error(`Draft agent error: ${result.error ?? 'No HTML returned'}`)
  }

  await saveDraftVersion({ contractId, orgId, userId, result, changeNote: 'AI-generated first draft', source: 'request' })
  console.info('[agent-worker] draft-contract done contractId=%s', contractId)
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
      await handleDetectBinder(job.data as DetectBinderJob)
    } else if (job.name === 'classify-document') {
      await handleClassifyDocument(job.data as ClassifyDocumentJob)
    } else if (job.name === 'extract-ai') {
      await handleExtractAi(job as Job<ExtractionJobData>)
    } else if (job.name === 'classify-request') {
      await handleClassifyRequest(job.data as ClassifyRequestJob)
    } else if (job.name === 'redline-analysis') {
      await handleRedlineAnalysis(job.data as RedlineAnalysisJob)
    } else if (job.name === 'playbook-redline') {
      await handlePlaybookRedline(job.data as PlaybookRedlineJob)
    } else if (job.name === 'playbook-review') {
      await handlePlaybookReview(job.data as PlaybookReviewJob)
    } else if (job.name === 'approval-summary') {
      await handleApprovalSummary(job.data as ApprovalSummaryJob)
    } else if (job.name === 'draft-contract') {
      await handleDraftContract(job.data as DraftContractJobData)
    } else if (job.name === 'analysis-checkpoint') {
      // docs/41 P0.1 — an edited contract, left alone long enough: analysed again.
      const outcome = await runCheckpointAnalysis(job.data as { contractId: string; orgId: string })
      console.info('[agent-worker] analysis-checkpoint contractId=%s %s', (job.data as { contractId: string }).contractId, outcome)
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
