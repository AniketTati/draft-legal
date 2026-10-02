/**
 * Review Queue (P2.5 / Wave F.5; docs/39 B4) — every value across the org's
 * contracts that needs a person, from the field store:
 *
 *   proposed        the other side's tracked changes, not accepted, would change the value (A9)
 *   suggestion      a re-analysis reads a value a person set or checked differently
 *   conflict        the contract says different things about it: every reading, to choose from (A6)
 *   notice_type     a notice period found before notices were told apart (F1)
 *   words_changed   the words an AI value came from aren't in the current version (B2)
 *   low_confidence  the AI read a value but isn't sure of it
 *   not_found       the AI found nothing, and isn't sure the term is absent
 *
 * Before docs/39 the queue read the fieldConfidence blob of the 500 most
 * recently updated contracts: core fields only, one reason, no way through a
 * migrated portfolio of thousands. It now reads every field kind (core,
 * contract-type, custom) of every contract in scope, a page at a time, with a
 * count per reason, the passage each value came from, and a bulk verify.
 *
 * Design reference: Ironclad's Review Flagged Records / Focused
 * Verification; Hebbia's review queue (bulk actions).
 *
 *   GET  /api/v1/review-queue?reason=&field=&contractType=&q=&threshold=&offset=&limit=&contractId=&diligenceRoomId=
 *     → { items, total, counts: { [reason]: n }, fields: [{ key, label }], threshold, offset, limit }
 *   GET  /api/v1/review-queue/:contractId/source?field=
 *     → { field, excerpt: { before, match, after, … } | null }
 *   POST /api/v1/review-queue/:contractId/verify   { field, value? }
 *     → the value as it stands is right (or, with `value`, this is the right one)
 *   POST /api/v1/review-queue/:contractId/reject   { field }
 *     → the value is wrong: it is cleared
 *   POST /api/v1/review-queue/verify-bulk          { items: [{ contractId, field }] }
 *     → verify many at once (at most 100); each contract re-indexed once
 *   POST /api/v1/review-queue/reassign-bulk        { to, items: [{ contractId, field }] }
 *     → say which notice many unconfirmed notice periods are (F1), at once
 *
 * C5 — a correction (or rejection) writes through to the canonical column
 * when the field has one; the field store (lib/field-store.ts) does that for
 * every field, records who set the value so a re-analysis can't overwrite
 * it, and re-indexes search. An older spelling of a field (noticePeriod) is
 * accepted as its canonical name.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma, type ContractFieldValue } from '@prisma/client'
import { z } from 'zod'
// Wave 1.7 — this router mutates AI-extracted contract fields (keyTerms /
// metadata) on verify/reject, so it must be RBAC-gated, not requireAuth-only.
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes, ownContractWhere } from '../lib/own-scope-guard.js'
import { prisma } from '../lib/prisma.js'
import { reindexContract } from '../lib/elasticsearch.js'
import {
  computedConfidence, computedConfidenceSql, checkBelowSql, fieldAccuracy, fieldCheckLevels, fieldRulesSql,
} from '../lib/field-confidence.js'
import {
  setFieldValue, verifyFieldValue, rejectFieldValue, reassignLegacyValue, fieldSource, fieldDefsFor, resolveDef, fieldView,
  materializeContractFields, placeContractQuotes, withCurrency, type CustomFieldDefRow, type FieldDef, type FieldWriteResult, type AuditContext,
} from '../lib/field-store.js'

// B3 — 'always': a field the org checks every time (Settings › Fields), however sure the AI was.
export const REVIEW_REASONS = ['proposed', 'suggestion', 'conflict', 'notice_type', 'words_changed', 'low_confidence', 'always', 'not_found'] as const
export type ReviewReason = typeof REVIEW_REASONS[number]

/** Contracts analysed before the store existed, read into it per request (the backfill script does them all). */
const MATERIALIZE_PER_REQUEST = 25
/** Contracts whose quotes are placed in an older version (or never), placed per request. */
const PLACE_PER_REQUEST = 25
const BULK_MAX = 100

/** A value in a JSON column that holds something: not SQL NULL, JSON null, or an empty list, text or object. */
const present = (col: Prisma.Sql) => Prisma.sql`(${col} IS NOT NULL AND ${col} NOT IN ('null'::jsonb, '[]'::jsonb, '""'::jsonb, '{}'::jsonb))`

/**
 * Why a row needs a person, or NULL: the first reason that applies, in
 * REVIEW_REASONS order. B3 — "unsure" is the computed confidence (the
 * model's, held down by a missing quote, a flag, the field's record) under
 * the field's own threshold; a field checked always is listed however sure.
 */
function reasonSql(threshold: number): Prisma.Sql {
  const unchecked = Prisma.sql`v.source IN ('ai', 'calculated') AND v."verifiedAt" IS NULL AND v."rejectedAt" IS NULL`
  return Prisma.sql`CASE
    WHEN ${present(Prisma.sql`v.suggestion`)} AND v.suggestion->>'reason' = 'proposed' THEN 'proposed'
    WHEN ${present(Prisma.sql`v.suggestion`)} THEN 'suggestion'
    WHEN ${unchecked} AND ${present(Prisma.sql`v.value`)} AND ${present(Prisma.sql`v.candidates`)} THEN 'conflict'
    WHEN v."fieldKey" = 'noticePeriodDays' AND ${present(Prisma.sql`v.value`)} THEN 'notice_type'
    WHEN ${unchecked} AND ${present(Prisma.sql`v.value`)} AND ${present(Prisma.sql`v.anchor`)}
      AND v.anchor->>'versionId' = c."currentVersionId" AND v.anchor->'start' = 'null'::jsonb
      AND v.anchor->'noText' IS NULL AND v.anchor->'exhibit' IS NULL THEN 'words_changed'
    WHEN ${unchecked} AND ${present(Prisma.sql`v.value`)} AND ${computedConfidenceSql()} < ${checkBelowSql(threshold)} THEN 'low_confidence'
    WHEN ${unchecked} AND ${present(Prisma.sql`v.value`)} AND r.level = 'always' THEN 'always'
    WHEN ${unchecked} AND NOT ${present(Prisma.sql`v.value`)} AND v.confidence IS NOT NULL
      AND (v.confidence < ${checkBelowSql(threshold)} OR r.level = 'always') THEN 'not_found'
  END`
}

interface QueueFilter {
  orgId: string
  ownerId?: string
  threshold: number
  /** B3 — the org's per-field rules (fieldRulesSql). */
  rules: Prisma.Sql
  contractId?: string
  diligenceRoomId?: string
  contractType?: string
  field?: string
  q?: string
}

/** The contracts and rows in scope, each with its reason. */
function scopeSql(f: QueueFilter): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    Prisma.sql`v."orgId" = ${f.orgId}`,
    Prisma.sql`c."deletedAt" IS NULL`,
    // Only contracts that have been analysed: nothing to review on a PENDING one.
    Prisma.sql`c."analysisStatus" IN ('DONE', 'INDEXING')`,
  ]
  // X7 — own-scope callers review only the contracts they own.
  if (f.ownerId) conds.push(Prisma.sql`c."ownerId" = ${f.ownerId}`)
  // X17 — the org's queue is the org's contracts; a room's own queue, or a named contract, on request.
  if (f.contractId) conds.push(Prisma.sql`c.id = ${f.contractId}`)
  else if (f.diligenceRoomId) conds.push(Prisma.sql`c."diligenceRoomId" = ${f.diligenceRoomId}`)
  else conds.push(Prisma.sql`c."diligenceRoomId" IS NULL`)
  if (f.contractType) conds.push(Prisma.sql`c.type = ${f.contractType}`)
  if (f.field) conds.push(Prisma.sql`v."fieldKey" = ${f.field}`)
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, m => `\\${m}`)}%`
    conds.push(Prisma.sql`(c.title ILIKE ${like} OR c."counterpartyName" ILIKE ${like})`)
  }
  return Prisma.sql`
    SELECT v.id, v."fieldKey", ${computedConfidenceSql()} AS confidence, v."updatedAt", ${reasonSql(f.threshold)} AS reason
    FROM contract_field_values v
    JOIN contracts c ON c.id = v."contractId"
    LEFT JOIN ${f.rules} ON r.key = v."fieldKey"
    WHERE ${Prisma.join(conds, ' AND ')}`
}

/** Proposals, suggestions, readings to choose from and notice types first (a value is at stake), then the least sure. */
const REASON_ORDER = Prisma.sql`CASE reason
  WHEN 'proposed' THEN 0 WHEN 'suggestion' THEN 1 WHEN 'conflict' THEN 2 WHEN 'notice_type' THEN 3 WHEN 'words_changed' THEN 4
  WHEN 'low_confidence' THEN 5 WHEN 'always' THEN 6 ELSE 7 END`

/** Every field definition an org's contracts can have, per contract type. */
async function defsLoader(orgId: string) {
  const custom = await prisma.contractFieldDefinition.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    select: { fieldKey: true, fieldLabel: true, fieldType: true, options: true, helpText: true, required: true, contractType: true },
  })
  const cache = new Map<string, FieldDef[]>()
  return (contractType: string): FieldDef[] => {
    let defs = cache.get(contractType)
    if (!defs) {
      const rows: CustomFieldDefRow[] = custom.filter(d => d.contractType === null || d.contractType === contractType)
      defs = fieldDefsFor(contractType, rows)
      cache.set(contractType, defs)
    }
    return defs
  }
}

/** Contracts in scope whose values are still only in the legacy blobs. */
async function materializeLegacy(req: FastifyRequest, where: Prisma.ContractWhereInput): Promise<void> {
  const pending = await prisma.contract.findMany({
    where: { ...where, fieldConfidence: { not: {} }, fieldValues: { none: {} } },
    select: { id: true },
    take: MATERIALIZE_PER_REQUEST,
  })
  for (const c of pending) {
    try {
      await materializeContractFields(c.id)
    } catch (err) {
      req.log.warn({ err, contractId: c.id }, '[review-queue] could not read legacy values into the field store')
    }
  }
}

/**
 * Contracts in scope with a quoted value not yet placed in the version the
 * contract stands on: a new version since, or never opened. Placing them is
 * what finds "words changed" (B2).
 */
async function placeStaleQuotes(req: FastifyRequest, orgId: string, ownerId: string | undefined): Promise<void> {
  const owner = ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty
  const stale = await prisma.$queryRaw<Array<{ contractId: string }>>`
    SELECT DISTINCT v."contractId" FROM contract_field_values v
    JOIN contracts c ON c.id = v."contractId"
    WHERE v."orgId" = ${orgId} AND c."deletedAt" IS NULL AND c."currentVersionId" IS NOT NULL ${owner}
      AND v.quote IS NOT NULL AND v.quote <> '' AND ${present(Prisma.sql`v.value`)}
      AND (NOT ${present(Prisma.sql`v.anchor`)} OR v.anchor->>'versionId' IS DISTINCT FROM c."currentVersionId")
    LIMIT ${PLACE_PER_REQUEST}`
  for (const { contractId } of stale) {
    try {
      await placeContractQuotes(contractId)
    } catch (err) {
      req.log.warn({ err, contractId }, '[review-queue] could not place quotes')
    }
  }
}

export async function reviewQueueRoutes(app: FastifyInstance) {
  // X7 — verify/reject/source name the contract `:contractId`; own scope must own it.
  guardOwnScopeContractRoutes(app, /\/:contractId(\/|$)/, 'contractId')

  // ── GET /api/v1/review-queue ────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const q = z.object({
      threshold: z.coerce.number().min(0).max(1).default(0.7),
      reason: z.enum(REVIEW_REASONS).optional(),
      field: z.string().max(64).optional(),
      contractType: z.string().max(64).optional(),
      q: z.string().trim().max(200).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      contractId: z.string().optional(),
      // X17 — a diligence room's extractions, on request.
      diligenceRoomId: z.string().optional(),
    }).parse(req.query)

    const owner = ownContractWhere(req)
    await materializeLegacy(req, {
      orgId, deletedAt: null, analysisStatus: { in: ['DONE', 'INDEXING'] }, ...owner,
      ...(q.contractId ? { id: q.contractId } : { diligenceRoomId: q.diligenceRoomId ?? null }),
    })
    await placeStaleQuotes(req, orgId, owner.ownerId)

    const [accuracy, levels] = await Promise.all([fieldAccuracy(orgId), fieldCheckLevels(orgId)])
    const scope = scopeSql({
      orgId, ownerId: owner.ownerId, threshold: q.threshold, contractId: q.contractId,
      diligenceRoomId: q.diligenceRoomId, contractType: q.contractType, q: q.q,
      rules: fieldRulesSql(accuracy, levels),
    })
    const reasonFilter = q.reason ? Prisma.sql`AND reason = ${q.reason}` : Prisma.empty
    const fieldFilter = q.field ? Prisma.sql`AND "fieldKey" = ${q.field}` : Prisma.empty
    const [page, counts, fieldKeys] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; reason: ReviewReason }>>`
        SELECT id, reason FROM (${scope}) s
        WHERE reason IS NOT NULL ${reasonFilter} ${fieldFilter}
        ORDER BY ${REASON_ORDER}, confidence ASC NULLS LAST, "updatedAt" DESC, id
        LIMIT ${q.limit} OFFSET ${q.offset}`,
      // Counts per reason for the same scope and field (not narrowed by the reason picked).
      prisma.$queryRaw<Array<{ reason: ReviewReason; n: bigint }>>`
        SELECT reason, COUNT(*)::bigint AS n FROM (${scope}) s
        WHERE reason IS NOT NULL ${fieldFilter}
        GROUP BY reason`,
      // Which fields have something to review, for the field filter.
      prisma.$queryRaw<Array<{ fieldKey: string; n: bigint }>>`
        SELECT "fieldKey", COUNT(*)::bigint AS n FROM (${scope}) s
        WHERE reason IS NOT NULL ${reasonFilter}
        GROUP BY "fieldKey" ORDER BY n DESC`,
    ])

    const rows = page.length
      ? await prisma.contractFieldValue.findMany({
          where: { id: { in: page.map(p => p.id) } },
          include: { contract: { select: { id: true, title: true, type: true, status: true, counterpartyName: true, currency: true } } },
        })
      : []
    const byId = new Map(rows.map(r => [r.id, r]))
    const defsFor = await defsLoader(orgId)
    const labels = new Map<string, string>()

    const items = page.flatMap(p => {
      const r = byId.get(p.id) as (ContractFieldValue & { contract: { id: string; title: string; type: string; status: string; counterpartyName: string | null; currency: string | null } }) | undefined
      if (!r) return []
      const defs = defsFor(r.contract.type)
      const def = resolveDef(defs, r.fieldKey) ?? {
        key: r.fieldKey, kind: r.kind as FieldDef['kind'], label: r.label ?? r.fieldKey, type: r.valueType as FieldDef['type'], group: r.kind === 'custom' ? 'custom' : 'type',
      } satisfies FieldDef
      const raw = fieldView(def, r)
      // B3 — as sure as the Fields panel says: the model's number held down by what can be checked.
      const computed = computedConfidence({
        source: raw.source, verifiedAt: raw.verifiedAt, model: raw.modelConfidence, quote: raw.quote, issue: raw.issue,
        gone: p.reason === 'words_changed', hasValue: raw.value !== null && raw.value !== '', value: raw.value,
      }, accuracy.get(def.key))
      const view = { ...raw, confidence: computed.confidence }
      // The contract value reads with its currency ("USD 12,500"), as everywhere else.
      const display = def.key === 'value' && typeof view.value === 'number' && r.contract.currency ? `${r.contract.currency} ${view.display}` : view.display
      labels.set(def.key, def.label)
      return [{
        id: r.id,
        reason: p.reason,
        contractId: r.contract.id,
        contractTitle: r.contract.title,
        contractType: r.contract.type,
        contractStatus: r.contract.status,
        counterparty: r.contract.counterpartyName,
        field: def.key,
        fieldLabel: view.label,
        kind: def.kind,
        type: def.type,
        options: def.options,
        unit: def.unit,
        legacy: def.legacy ?? false,
        // The value as people read it (the page shows this); the typed value is `raw`.
        value: view.value === null || view.value === '' || (Array.isArray(view.value) && !view.value.length) ? null : display,
        raw: view.value,
        quote: view.quote,
        section: view.section,
        issue: view.issue,
        source: view.source,
        confidence: view.confidence ?? 1,
        confidenceReasons: computed.reasons,
        check: levels[def.key] ?? 'unsure',
        suggestion: view.suggestion,
        // A6 — what the contract says about it, when it says different things.
        candidates: def.key === 'value' && r.contract.currency && view.candidates ? withCurrency(view.candidates, r.contract.currency) : view.candidates,
        updatedAt: view.updatedAt,
      }]
    })

    const countMap = Object.fromEntries(REVIEW_REASONS.map(r => [r, 0])) as Record<ReviewReason, number>
    for (const c of counts) countMap[c.reason] = Number(c.n)
    const total = q.reason ? countMap[q.reason] : Object.values(countMap).reduce((a, b) => a + b, 0)

    // A label for every field key in the filter, from this page's rows or the core registry.
    const coreDefs = defsFor('OTHER')
    const fields = fieldKeys.map(f => ({
      key: f.fieldKey,
      label: labels.get(f.fieldKey) ?? resolveDef(coreDefs, f.fieldKey)?.label ?? f.fieldKey,
      count: Number(f.n),
    }))

    return reply.send({ items, total, counts: countMap, fields, threshold: q.threshold, offset: q.offset, limit: q.limit })
  })

  // ── GET /api/v1/review-queue/:contractId/source?field= ──────────────────
  app.get('/:contractId/source', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { contractId } = req.params as { contractId: string }
    const { field } = z.object({ field: z.string().min(1).max(64) }).parse(req.query)
    const r = await fieldSource(req.user.orgId, contractId, field)
    if (!r) return reply.status(404).send({ detail: 'Field not found' })
    return reply.send(r)
  })

  // ── POST /api/v1/review-queue/:contractId/verify ────────────────────────
  app.post('/:contractId/verify', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { contractId } = req.params as { contractId: string }
    const body = z.object({
      field: z.string().min(1).max(64),
      // When supplied, overwrite the extracted value with the human-corrected
      // one — typed as the field's editor sends it (text, a number, a date,
      // { value, unit } for a duration, …). Keeps flag-and-fix in one call.
      value: z.unknown().optional(),
    }).parse(req.body)

    const audit = { source: 'review_queue', ipAddress: req.ip }
    const r = body.value === undefined
      ? await verifyFieldValue({ orgId, contractId, key: body.field, userId, audit })
      : await setFieldValue({ orgId, contractId, key: body.field, raw: body.value, userId, audit })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ ok: true, contractId, field: r.field.key, verifiedBy: userId, view: r.field, statusChange: r.statusChange })
  })

  // ── POST /api/v1/review-queue/:contractId/reject ────────────────────────
  app.post('/:contractId/reject', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { contractId } = req.params as { contractId: string }
    const body = z.object({ field: z.string().min(1).max(64) }).parse(req.body)
    // C5 — "reject" clears the value (as the UI says), so a value a human
    // called wrong stops driving renewals, alerts and agent answers.
    const r = await rejectFieldValue({ orgId, contractId, key: body.field, userId, audit: { source: 'review_queue', ipAddress: req.ip } })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ ok: true, contractId, field: r.field.key, rejectedBy: userId, statusChange: r.statusChange })
  })

  // ── POST /api/v1/review-queue/verify-bulk ───────────────────────────────
  app.post('/verify-bulk', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { items } = z.object({ items: BulkItems }).parse(req.body)
    const r = await eachAllowed(req, items, (it, audit) =>
      verifyFieldValue({ orgId: req.user.orgId, contractId: it.contractId, key: it.field, userId: req.user.sub, audit, reindex: false }))
    return reply.send({ verified: r.done, failed: r.failed, results: r.results })
  })

  // ── POST /api/v1/review-queue/reassign-bulk ─────────────────────────────
  app.post('/reassign-bulk', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { items, to } = z.object({ items: BulkItems, to: z.enum(['nonRenewalNotice', 'terminationNotice']) }).parse(req.body)
    const r = await eachAllowed(req, items, (it, audit) =>
      reassignLegacyValue({ orgId: req.user.orgId, contractId: it.contractId, key: it.field, to, userId: req.user.sub, audit, reindex: false }))
    return reply.send({ reassigned: r.done, failed: r.failed, results: r.results })
  })
}

const BulkItems = z.array(z.object({ contractId: z.string().min(1), field: z.string().min(1).max(64) })).min(1).max(BULK_MAX)

/**
 * One write per item, for the items on contracts the caller may edit (X7:
 * the route names no contract, so own scope is checked here), then each
 * touched contract re-indexed once.
 */
async function eachAllowed(
  req: FastifyRequest,
  items: Array<{ contractId: string; field: string }>,
  write: (it: { contractId: string; field: string }, audit: AuditContext) => Promise<FieldWriteResult>,
) {
  const allowed = new Set((await prisma.contract.findMany({
    where: { id: { in: [...new Set(items.map(i => i.contractId))] }, orgId: req.user.orgId, deletedAt: null, ...ownContractWhere(req) },
    select: { id: true },
  })).map(c => c.id))
  const audit = { source: 'review_queue', ipAddress: req.ip }
  const results: Array<{ contractId: string; field: string; ok: boolean; detail?: string }> = []
  const touched = new Set<string>()
  for (const it of items) {
    if (!allowed.has(it.contractId)) { results.push({ ...it, ok: false, detail: 'Contract not found' }); continue }
    const r = await write(it, audit)
    results.push(r.ok ? { ...it, ok: true } : { ...it, ok: false, detail: r.detail })
    if (r.ok) touched.add(it.contractId)
  }
  for (const id of touched) {
    reindexContract(id).catch(err => req.log.warn({ err, contractId: id }, '[review-queue] re-index failed'))
  }
  return { done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), results }
}
