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
 *
 * C5 — a correction (or rejection) writes through to the canonical column
 * when the field has one. The contracts list, renewals and the renewal scan
 * read the columns; keyTerms is display/back-compat and is kept in step.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
// Wave 1.7 — this router mutates AI-extracted contract fields (keyTerms /
// metadata) on verify/reject, so it must be RBAC-gated, not requireAuth-only.
import { requirePermission } from '../middleware/permissions.js'
import { prisma } from '../lib/prisma.js'
import { indexContract } from '../lib/elasticsearch.js'
import { normalizeRiskScore } from '@clm/types'

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

// Fields backed by a canonical Contract column. governingLaw is the source the
// extraction derives `jurisdiction` from (agents review.py), so it writes there.
const COLUMN_FOR_FIELD: Record<string, { column: 'counterpartyName' | 'jurisdiction' | 'currency' | 'effectiveDate' | 'expiryDate' | 'value'; kind: 'text' | 'date' | 'number' }> = {
  counterpartyName: { column: 'counterpartyName', kind: 'text' },
  jurisdiction:     { column: 'jurisdiction',     kind: 'text' },
  governingLaw:     { column: 'jurisdiction',     kind: 'text' },
  currency:         { column: 'currency',         kind: 'text' },
  effectiveDate:    { column: 'effectiveDate',    kind: 'date' },
  expiryDate:       { column: 'expiryDate',       kind: 'date' },
  value:            { column: 'value',            kind: 'number' },
}

/** Parse a human correction for a column-backed field. */
function parseCorrection(
  kind: 'text' | 'date' | 'number',
  raw: string | number | null,
): { ok: true; column: string | number | Date | null; keyTerm: string | number | null } | { ok: false; detail: string } {
  if (raw === null || String(raw).trim() === '') return { ok: true, column: null, keyTerm: null }
  if (kind === 'date') {
    const text = String(raw).trim()
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text)
    if (Number.isNaN(d.getTime())) return { ok: false, detail: 'Enter the date as YYYY-MM-DD.' }
    return { ok: true, column: d, keyTerm: d.toISOString().slice(0, 10) }
  }
  if (kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[\s,]/g, '').replace(/^[$€£¥]/, ''))
    if (!Number.isFinite(n)) return { ok: false, detail: 'Enter the value as a number, e.g. 250000.' }
    return { ok: true, column: n, keyTerm: n }
  }
  const text = String(raw).trim()
  return { ok: true, column: text, keyTerm: text }
}

/**
 * Refresh the contract's search document after a column changed. indexContract
 * is a full-document overwrite, so carry every searchable field (as PATCH does).
 */
async function reindex(contractId: string): Promise<void> {
  const c = await prisma.contract.findUnique({ where: { id: contractId } })
  if (!c) return
  const version = c.currentVersionId
    ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { plainText: true } })
    : null
  await indexContract(c.id, {
    orgId: c.orgId,
    title: c.title,
    type: c.type,
    status: c.status,
    counterpartyName: c.counterpartyName ?? undefined,
    jurisdiction: c.jurisdiction ?? undefined,
    plainText: version?.plainText ?? '',
    summary: c.summary ?? undefined,
    tags: c.tags,
    riskScore: normalizeRiskScore(c.riskScore) ?? undefined,
    effectiveDate: c.effectiveDate?.toISOString(),
    expiryDate: c.expiryDate?.toISOString(),
    createdAt: c.createdAt.toISOString(),
    keyTerms: c.keyTerms as Record<string, unknown>,
    metadata: c.metadata as Record<string, unknown>,
  })
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
      const fc = (c.fieldConfidence ?? {}) as Record<string, {
        confidence?: number
        quote?:      string | null
        section?:    string | null
        verifiedAt?: string | null
        verifiedBy?: string | null
      } | undefined>
      for (const [field, entry] of Object.entries(fc)) {
        if (!entry) continue
        // Skip items a human has already signed off on.
        if (entry.verifiedAt) continue
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
    fc[body.field] = {
      ...existing,
      confidence: 1,
      verifiedAt: new Date().toISOString(),
      verifiedBy: userId,
    }

    const updateData: Record<string, unknown> = { fieldConfidence: fc }
    // If the caller provided a corrected value, persist it onto the canonical
    // column (C5) and keep keyTerms in step, so every reader agrees.
    const mapped = COLUMN_FOR_FIELD[body.field]
    if (body.value !== undefined) {
      const kt = { ...(contract.keyTerms as Record<string, unknown> ?? {}) }
      if (mapped) {
        const parsed = parseCorrection(mapped.kind, body.value)
        if (!parsed.ok) return reply.status(400).send({ detail: parsed.detail })
        updateData[mapped.column] = parsed.column
        if (body.field in kt || mapped.column !== body.field) kt[body.field] = parsed.keyTerm
      } else {
        kt[body.field] = body.value
      }
      updateData.keyTerms = kt
    }

    await prisma.contract.update({
      where: { id: contract.id },
      data: updateData as never,
    })
    if (mapped && body.value !== undefined) {
      reindex(contract.id).catch(err => app.log.warn({ err }, '[review-queue] ES re-index failed'))
    }
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
    fc[body.field] = {
      ...existing,
      confidence: 0,
      rejectedAt: new Date().toISOString(),
      rejectedBy: userId,
    }
    // Mark verifiedAt too so the queue skips this entry — "rejected"
    // is a terminal review state.
    fc[body.field].verifiedAt = fc[body.field].rejectedAt
    fc[body.field].verifiedBy = userId

    // C5 — "reject" clears the value (as the UI says), so a value a human
    // called wrong stops driving renewals, alerts and agent answers.
    const kt = { ...(contract.keyTerms as Record<string, unknown> ?? {}) }
    delete kt[body.field]
    const mapped = COLUMN_FOR_FIELD[body.field]
    await prisma.contract.update({
      where: { id: contract.id },
      data:  {
        fieldConfidence: fc as never,
        keyTerms: kt as never,
        ...(mapped ? { [mapped.column]: null } : {}),
      },
    })
    if (mapped) reindex(contract.id).catch(err => app.log.warn({ err }, '[review-queue] ES re-index failed'))
    return reply.send({ ok: true, contractId, field: body.field, rejectedBy: userId })
  })
}
