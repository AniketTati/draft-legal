/**
 * Review Queue (P2.5 / Wave F.5)
 *
 * Surfaces AI-extracted contract fields whose extractor confidence is
 * below a threshold so Legal can verify them. Without this queue,
 * low-confidence fields silently land in the DB and downstream
 * tooling (risk scoring, reports, agent answers) treats them as if
 * they were high-quality extractions.
 *
 * Design reference:
 *   - Hebbia review queue — per-field verify with bulk actions
 *   - Ironclad confidence thresholds — flagged fields require sign-off
 *   - Harvey confidence badges — one-click accept/reject
 *
 * Endpoints:
 *   GET  /api/v1/review-queue?threshold=0.7
 *     → { items: [{contractId, contractTitle, contractType, field,
 *                  value, quote, confidence, updatedAt}] }
 *   POST /api/v1/review-queue/:contractId/verify
 *        body: { field: string, value?: string | null }
 *     → marks the field as human-verified (confidence=1.0, verifiedBy,
 *        verifiedAt). The queue skips verified entries on subsequent
 *        reads.
 *   POST /api/v1/review-queue/:contractId/reject
 *        body: { field: string }
 *     → inverse: mark the extracted value WRONG. Clears the field's
 *        value so the contract shows "—" + logs the rejection for the
 *        re-extraction queue (future).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
// Wave 1.7 — this router mutates AI-extracted contract fields (keyTerms /
// metadata) on verify/reject, so it must be RBAC-gated, not requireAuth-only.
import { requirePermission } from '../middleware/permissions.js'
import { prisma } from '../lib/prisma.js'

// Fields worth surfacing in the queue. Extraction produces keyTerms for
// a lot of keys but not all are HITL-worthy (internal helpers). We keep
// the whitelist narrow so the queue is actionable, not a firehose.
const FIELD_LABELS: Record<string, string> = {
  counterpartyName: 'Counterparty',
  effectiveDate:    'Effective date',
  expiryDate:       'Expiry date',
  governingLaw:     'Governing law',
  jurisdiction:     'Jurisdiction',
  value:            'Contract value',
  currency:         'Currency',
  autoRenew:        'Auto-renew',
  renewalTerm:      'Renewal term',
  noticePeriod:     'Notice period',
  liabilityCap:     'Liability cap',
  exclusivity:      'Exclusivity',
  ipOwnership:      'IP ownership',
  indemnification:  'Indemnification',
  termination:      'Termination',
}

/** Pull the human value for a given field off keyTerms / top-level columns. */
function valueOfField(contract: Record<string, unknown>, field: string): string | number | null {
  // Top-level columns first — a few fields live directly on Contract.
  if (field === 'counterpartyName') return (contract.counterpartyName as string | null) ?? null
  if (field === 'effectiveDate')    return (contract.effectiveDate as Date | null)?.toISOString()?.slice(0, 10) ?? null
  if (field === 'expiryDate')       return (contract.expiryDate as Date | null)?.toISOString()?.slice(0, 10) ?? null
  if (field === 'jurisdiction')     return (contract.jurisdiction as string | null) ?? null
  if (field === 'value')            return (contract.value as number | null) ?? null
  if (field === 'currency')         return (contract.currency as string | null) ?? null
  // Everything else lives under keyTerms.
  const kt = (contract.keyTerms ?? {}) as Record<string, unknown>
  const v = kt[field]
  if (v == null || v === '') return null
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'object')  return JSON.stringify(v).slice(0, 120)
  return String(v)
}

export async function reviewQueueRoutes(app: FastifyInstance) {

  // ── GET /api/v1/review-queue ────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const q = z.object({
      threshold: z.coerce.number().min(0).max(1).default(0.7),
      limit:     z.coerce.number().int().min(1).max(500).default(200),
      contractId: z.string().optional(),
    }).parse(req.query)

    const where: Record<string, unknown> = {
      orgId,
      deletedAt: null,
      // Only contracts that have been analyzed — nothing to verify on
      // a still-PENDING contract.
      analysisStatus: { in: ['DONE', 'INDEXING'] },
      fieldConfidence: { not: {} },
    }
    if (q.contractId) where.id = q.contractId

    const contracts = await prisma.contract.findMany({
      where: where as never,
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, effectiveDate: true, expiryDate: true,
        jurisdiction: true, value: true, currency: true,
        keyTerms: true, fieldConfidence: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    })

    const items: Array<Record<string, unknown>> = []
    for (const c of contracts) {
      // Both shapes at once: the current one (`review`) and the legacy one
      // (`verifiedAt`/`rejectedAt`), because un-backfilled rows carry the
      // latter. normalizeFieldConfidence folds them for API responses; this
      // read predates that boundary and reads the column directly.
      const fc = (c.fieldConfidence ?? {}) as Record<string, {
        confidence?: number | null
        quote?:      string | null
        section?:    string | null
        review?:     { verdict: 'verified' | 'rejected' }
        verifiedAt?: string | null
        verifiedBy?: string | null
        rejectedAt?: string | null
      } | undefined>
      for (const [field, entry] of Object.entries(fc)) {
        if (!entry) continue
        // Skip items a human has already signed off on.
        // `review` is the current marker; `verifiedAt` is the legacy one and is
        // still present on every row written before this change.
        if (entry.review || entry.verifiedAt) continue
        const conf = typeof entry.confidence === 'number' ? entry.confidence : 1
        if (conf >= q.threshold) continue
        const label = FIELD_LABELS[field] ?? field
        items.push({
          contractId:    c.id,
          contractTitle: c.title,
          contractType:  c.type,
          contractStatus: c.status,
          field,
          fieldLabel:    label,
          value:         valueOfField(c as never, field),
          quote:         entry.quote ?? null,
          section:       entry.section ?? null,
          confidence:    conf,
          updatedAt:     c.updatedAt,
        })
      }
    }

    // Sort most-actionable first — lowest confidence then most recent.
    items.sort((a, b) => {
      const ca = (a.confidence as number), cb = (b.confidence as number)
      if (ca !== cb) return ca - cb
      return new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime()
    })

    return reply.send({
      items: items.slice(0, q.limit),
      total: items.length,
      threshold: q.threshold,
    })
  })

  // ── POST /api/v1/review-queue/:contractId/verify ────────────────────────
  app.post('/:contractId/verify', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { contractId } = req.params as { contractId: string }
    const body = z.object({
      field: z.string().min(1).max(60),
      // When supplied, overwrite the extracted value with the human-
      // corrected one. Keeps the flag-and-fix workflow in one call.
      value: z.union([z.string(), z.number(), z.null()]).optional(),
    }).parse(req.body)

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId, deletedAt: null },
      select: {
        id: true, fieldConfidence: true, keyTerms: true,
        counterpartyName: true, jurisdiction: true, currency: true,
      },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const fc = { ...(contract.fieldConfidence as Record<string, Record<string, unknown>> ?? {}) }
    const existing = fc[body.field] ?? {}
    // `confidence` is the EXTRACTOR's and is not touched. It used to be set to
    // 1 here, which destroyed the only variable a human verdict could be
    // regressed against -- and did so irrecoverably, the moment someone
    // clicked. It also collided with a real extractor output: review_agent.py
    // emits confidence 1.0 for "certain absence", so 1 never distinguished
    // AI-certain from human-verified.
    fc[body.field] = {
      ...existing,
      review: { verdict: 'verified', at: new Date().toISOString(), by: userId },
    }

    const updateData: Record<string, unknown> = { fieldConfidence: fc }
    // If the caller provided a corrected value, persist it onto the
    // right column / keyTerm key.
    if (body.value !== undefined) {
      if (body.field === 'counterpartyName') updateData.counterpartyName = body.value
      else if (body.field === 'jurisdiction') updateData.jurisdiction = body.value
      else if (body.field === 'currency')     updateData.currency = body.value
      else {
        const kt = { ...(contract.keyTerms as Record<string, unknown> ?? {}) }
        kt[body.field] = body.value
        updateData.keyTerms = kt
      }
    }

    await prisma.contract.update({
      where: { id: contract.id },
      data: updateData as never,
    })
    return reply.send({ ok: true, contractId, field: body.field, verifiedBy: userId })
  })

  // ── POST /api/v1/review-queue/:contractId/reject ────────────────────────
  app.post('/:contractId/reject', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { contractId } = req.params as { contractId: string }
    const body = z.object({ field: z.string().min(1).max(60) }).parse(req.body)

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId, deletedAt: null },
      select: { id: true, fieldConfidence: true, keyTerms: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const fc = { ...(contract.fieldConfidence as Record<string, Record<string, unknown>> ?? {}) }
    const existing = fc[body.field] ?? {}
    // Same as verify: the extractor's confidence stays. The old code wrote 0
    // AND stamped verifiedAt/verifiedBy so the queue would skip the row -- with
    // the side effect that any "agreement rate" joining on verifiedBy counted
    // every rejection as an agreement. The read path now skips on `review`
    // being present, so a rejection no longer has to impersonate a verification.
    fc[body.field] = {
      ...existing,
      review: { verdict: 'rejected', at: new Date().toISOString(), by: userId },
    }

    await prisma.contract.update({
      where: { id: contract.id },
      data:  { fieldConfidence: fc as never },
    })
    return reply.send({ ok: true, contractId, field: body.field, rejectedBy: userId })
  })
}
