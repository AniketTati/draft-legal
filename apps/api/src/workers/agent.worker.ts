/**
 * Agent Worker — handles agentQueue jobs:
 *   detect-binder    : LLM binder detection (Haiku, first 10K chars) → BINDER_DETECTED or classify-document
 *   classify-document: LLM contract type classification (Haiku, first 5K chars) → extract-ai
 *   extract-ai       : fetch custom field defs + call agents /review with full payload
 *   classify-request : LLM intake classification (Haiku, 3K chars) → stores in request.metadata
 *   approval-summary : Phase 06 — AI executive summary for approvers (LangGraph 3-step pipeline)
 */
import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { queueClassifyDocument, queueExtractAi, queueSplitBinder } from '../lib/queue.js'
import type { DetectBinderJob, ClassifyDocumentJob, ExtractAiJob, ClassifyRequestJob, SplitBinderJob, RedlineAnalysisJob, ApprovalSummaryJob, PlaybookReviewJob, PlaybookRedlineJob } from '../lib/queue.js'
import { proposeClauseBatch } from '../lib/clause-propose-batch.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8000'
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
    select: { plainText: true },
  })
  if (!version?.plainText) {
    // Stale job from a previous run — a fresh parse job will re-queue detect-binder. Skip silently.
    console.warn('[agent-worker] detect-binder: plainText not yet ready for versionId=%s, skipping stale job', versionId)
    return
  }

  const res = await fetch(`${AGENTS_URL}/detect-binder`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ plainText: version.plainText, orgId }),
  })
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

  if (result.isBinder && result.confidence >= 0.7) {
    // Fetch existing metadata (_totalPages stored by parse worker)
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { metadata: true },
    })
    const existingMeta = (contract?.metadata as Record<string, unknown>) ?? {}
    const totalPages = (existingMeta._totalPages as number) ?? 100  // fallback if not PDF

    // Compute concrete page ranges from LLM pageHint strings ("~page N")
    const splits = docsToSplitSpecs(result.documents, totalPages)

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

// Convert LLM pageHint strings ("~page N") to concrete {pageStart,
// pageEnd} ranges. Resilient to an LLM that hands us bad hints:
//   • "~page 1" for all 3 docs (all same) → distribute evenly
//   • "~page 5" on a 2-page PDF (out of range) → clamp + distribute
//   • missing hints → index-proportional default
// If after parsing we end up with <2 unique page starts but docs.length >= 2,
// we FALL BACK to even distribution across the PDF.
function docsToSplitSpecs(
  docs: Array<{ title: string; docType: string; charStart?: number; pageHint?: string }>,
  totalPages: number
): SplitBinderJob['splits'] {
  if (docs.length === 0) return []
  const evenShare = Math.max(1, Math.floor(totalPages / docs.length))

  let withPages = docs.map((doc, i) => {
    const match = doc.pageHint?.match(/\d+/)
    const rawPage = match ? parseInt(match[0], 10) : NaN
    // Valid if within [1, totalPages]
    const pageNum = Number.isFinite(rawPage) && rawPage >= 1 && rawPage <= totalPages
      ? rawPage
      : i * evenShare + 1
    return { ...doc, pageNum }
  })

  // Sort by LLM-suggested start (usable when hints vary).
  withPages.sort((a, b) => a.pageNum - b.pageNum)

  // Collapsed starts? Example: LLM gave pageHint="~page 1" for every
  // agreement → all pageNums equal. Detect + re-distribute so we
  // actually carve N pieces.
  const uniqueStarts = new Set(withPages.map(w => w.pageNum))
  if (uniqueStarts.size < withPages.length && withPages.length >= 2) {
    console.warn(
      '[agent-worker] docsToSplitSpecs: %d unique starts for %d docs — redistributing evenly',
      uniqueStarts.size, withPages.length,
    )
    // Preserve the original order from the LLM (insertion order) for
    // the title sequence, then space them across totalPages.
    withPages = docs.map((doc, i) => ({
      ...doc,
      pageNum: Math.min(totalPages, i * evenShare + 1),
    }))
  }

  return withPages.map((doc, i) => {
    const nextStart = i < withPages.length - 1 ? withPages[i + 1].pageNum : totalPages + 1
    const pageEnd   = Math.max(doc.pageNum, nextStart - 1)
    return {
      title:     doc.title,
      type:      doc.docType,
      pageStart: doc.pageNum,
      pageEnd,
    }
  })
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

  const res = await fetch(`${AGENTS_URL}/classify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ plainText: version.plainText, orgId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /classify returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as { contractType: string; confidence: number; reason: string }
  const resolvedType = knownType ?? result.contractType
  console.info('[agent-worker] classify-document contractId=%s type=%s confidence=%.2f',
    contractId, resolvedType, result.confidence)

  await prisma.contract.update({
    where: { id: contractId },
    data: {
      type:           resolvedType,
      analysisStatus: 'EXTRACTING',
    },
  })

  queueExtractAi({ contractId, versionId, orgId, contractType: resolvedType, triggeredBy: 'upload' })
}

// ─── extract-ai ───────────────────────────────────────────────────────────────

async function handleExtractAi(data: ExtractAiJob): Promise<void> {
  const { contractId, versionId, orgId, contractType, triggeredBy } = data

  console.info('[agent-worker] extract-ai start contractId=%s triggeredBy=%s', contractId, triggeredBy)

  // Fetch full plain text from DB (written by parse worker)
  const version = await prisma.contractVersion.findUnique({
    where: { id: versionId },
    select: { plainText: true },
  })

  if (!version?.plainText) {
    throw new Error(`No plainText for versionId=${versionId} — parse worker may not have finished`)
  }

  // Fetch org custom field definitions (global + type-scoped) + org name.
  // orgName is passed to the agents service so the counterparty picker can
  // filter out parties whose name matches the user's own org — without this
  // the extractor picks "us" as counterparty in ~40% of contracts because
  // both parties have a name and the model has no context for which one is
  // the user. (Wave E.3)
  const [customFields, org] = await Promise.all([
    prisma.contractFieldDefinition.findMany({
      where: {
        orgId,
        deletedAt: null,
        OR: [
          { contractType: contractType ?? null },
          { contractType: null },   // global fields apply to all types
        ],
      },
      orderBy: { sortOrder: 'asc' },
      select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true },
    }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
  ])

  console.info('[agent-worker] found %d custom fields for orgId=%s contractType=%s',
    customFields.length, orgId, contractType ?? 'any')

  // Call agents service
  const body = {
    contractId,
    versionId,
    orgId,
    orgName:       org?.name,
    contractType:  contractType ?? undefined,
    customFields:  customFields.map(f => ({
      fieldKey:   f.fieldKey,
      fieldLabel: f.fieldLabel,
      fieldType:  f.fieldType,
      options:    (f.options as string[]) ?? [],
      helpText:   f.helpText ?? undefined,
    })),
    plainText: version.plainText,
  }

  const res = await fetch(`${AGENTS_URL}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /review returned ${res.status}: ${text.slice(0, 200)}`)
  }

  console.info('[agent-worker] extract-ai queued in agents service contractId=%s', contractId)
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

  const res = await fetch(`${AGENTS_URL}/intake-classify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({
      title:           request.title,
      description:     request.description,
      counterpartyName: request.counterpartyName ?? undefined,
      orgId,
    }),
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

  const res = await fetch(`${AGENTS_URL}/redline`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({ contractId, v1Id, v2Id, orgId, userId, contractType }),
  })
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

    const deviating = (checked.checks ?? []).filter(c => c.failedCount > 0)
    if (deviating.length === 0) {
      await setMeta({
        _playbookRedlineStatus: 'DONE',
        _playbookRedline: {
          versionId, aggression, proposals: [], deviationCount: 0,
          worstSeverity: checked.summary?.worstSeverity ?? null,
          truncated: checked.summary?.truncated ?? false,
          uncoveredClauses: checked.summary?.uncoveredClauses ?? 0,
          stagedAt: new Date().toISOString(),
          note: 'No clause deviated from the playbook.',
        },
      })
      return
    }

    // 2. One batched rewrite for all of them.
    const proposed = await proposeClauseBatch({
      orgId, contractId,
      clauseIds: deviating.map(c => c.clauseId),
      aggression,
    })
    if (!proposed.ok) {
      throw new Error(`${proposed.detail}${proposed.upstream ? `: ${proposed.upstream}` : ''}`)
    }

    // 3. Stage. Carry the ORIGINAL text alongside each rewrite so the reviewer
    //    sees both sides without another round-trip, and so the apply step can
    //    verify it is replacing what the reviewer actually saw.
    const clauses = await prisma.contractClause.findMany({
      where:  { id: { in: deviating.map(c => c.clauseId) } },
      select: { id: true, content: true, sectionRef: true },
    })
    const contentById = new Map(clauses.map(c => [c.id, c]))
    const bySeverity = new Map(deviating.map(c => [c.clauseId, c.worstSeverity]))

    const proposals = proposed.data.proposals.map(p => ({
      clauseId:     p.clauseId,
      clauseType:   p.clauseType,
      sectionRef:   contentById.get(p.clauseId)?.sectionRef ?? null,
      originalText: contentById.get(p.clauseId)?.content ?? '',
      proposedText: p.proposedText,
      rationale:    p.rationale,
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
        deviationCount:   deviating.length,
        proposedCount:    proposals.filter(p => p.proposedText).length,
        failedCount:      proposals.filter(p => p.error).length,
        worstSeverity:    checked.summary?.worstSeverity ?? null,
        truncated:        checked.summary?.truncated ?? false,
        uncoveredClauses: checked.summary?.uncoveredClauses ?? 0,
        stagedAt:         new Date().toISOString(),
      },
    })

    createAuditEvent({
      orgId, userId,
      action:       AuditAction.AGENT_TOOL_APPLIED,
      resourceType: 'contract',
      resourceId:   contractId,
      metadata: { via: 'playbook-redline', deviationCount: deviating.length, proposed: proposals.filter(p => p.proposedText).length },
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
  const { contractId, orgId, versionId } = data

  const contract = await prisma.contract.findFirst({
    where:  { id: contractId, orgId, deletedAt: null },
    select: { id: true, type: true },
  })
  if (!contract) {
    console.info('[agent-worker] playbook-review skip contractId=%s — contract gone', contractId)
    return
  }

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

  const res = await fetch(`${AGENTS_URL}/playbook-review`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body:    JSON.stringify({
      contractId,
      orgId,
      clauses,
      playbookPositions: relevant.map(p => ({
        clauseType:   p.clauseCategory?.name ?? 'other',
        positionType: p.positionType,
        content:      p.content,
        notes:        p.notes,
      })),
      contractType: contract.type,
    }),
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

  const res = await fetch(`${AGENTS_URL}/approval-summary`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ instanceId, contractId, versionId, orgId, approverIds }),
  })
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
}

async function handleDraftContract(data: DraftContractJobData): Promise<void> {
  const { contractId, orgId, userId, requestTitle, requestDescription, contractType, counterpartyName, estimatedValue } = data
  console.info('[agent-worker] draft-contract start contractId=%s type=%s', contractId, contractType)

  const userMessage = `Draft a ${contractType} titled "${requestTitle}". ${requestDescription ?? ''}`
  const context: Record<string, unknown> = {}
  if (counterpartyName) context.counterpartyName = counterpartyName
  if (estimatedValue) context.estimatedValue = estimatedValue

  const res = await fetch(`${AGENTS_URL}/draft`, {
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
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agents /draft returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const result = await res.json() as { html?: string; error?: string }

  if (result.error || !result.html) {
    throw new Error(`Draft agent error: ${result.error ?? 'No HTML returned'}`)
  }

  // Save as version 1
  const latest = await prisma.contractVersion.findFirst({
    where: { contractId },
    orderBy: { versionNumber: 'desc' },
  })
  const nextVersion = (latest?.versionNumber ?? 0) + 1

  await prisma.contractVersion.create({
    data: {
      contractId,
      versionNumber: nextVersion,
      htmlContent:   result.html,
      plainText:     result.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      mimeType:      'text/html',
      fileSize:      Buffer.byteLength(result.html),
      changeNote:    'AI-generated first draft',
      createdById:   userId,
    },
  })

  // Mark contract as done drafting
  await prisma.contract.update({
    where: { id: contractId },
    data:  { analysisStatus: 'DONE' },
  })

  console.info('[agent-worker] draft-contract done contractId=%s', contractId)
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
      await handleExtractAi(job.data as ExtractAiJob)
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
  const contractId = (job?.data as { contractId?: string })?.contractId
  // playbook-review is a supplementary pass that runs AFTER extraction has
  // already succeeded. Failing it (no model key, provider error) must not mark
  // the contract's analysis FAILED — the document is extracted and perfectly
  // usable; only the playbook scoring is missing.
  if (job?.name === 'playbook-review') {
    console.warn('[worker:agents] playbook-review failed for contractId=%s — leaving analysisStatus untouched', contractId)
    return
  }
  if (contractId && job && job.attemptsMade >= (job.opts.attempts ?? 2)) {
    await prisma.contract.update({
      where: { id: contractId },
      data: { analysisStatus: 'FAILED', analysisError: err.message.slice(0, 500) },
    }).catch(() => {})
  }
})
