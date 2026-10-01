/**
 * docs/39 D3 — the contracts list by field values (lib/field-query.ts).
 *
 *   GET  /api/v1/contracts/fields   every field the org's contracts can hold (columns, filters)
 *   POST /api/v1/contracts/query    contracts by filters, field filters and sort, with chosen field columns
 *
 * The query is a POST because a view carries a list of field filters and
 * columns, and a search's matches (ids) — too much for a query string.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AuditAction, normalizeRiskScore, type CatalogField } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { catalogField, fieldCatalog, fieldCells, queryContractIds, type FieldCell } from '../lib/field-query.js'
import { buildSpreadsheetCsv } from '../lib/csv.js'
import { fieldAccuracy } from '../lib/field-confidence.js'
import { verificationSummaries, type VerificationSummary } from '../lib/field-verification.js'
import { createAuditEvent } from '../lib/audit.js'

export const FieldFilterSchema = z.object({
  key: z.string().min(1).max(64),
  op: z.enum(['is', 'is_not', 'contains', 'gte', 'gt', 'lte', 'lt', 'between', 'any_of', 'present', 'empty']),
  value: z.unknown().optional(),
  to: z.unknown().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
})

const pct = z.number().min(0).max(100).optional()

export const ContractQuerySchema = z.object({
  q: z.string().max(200).optional(),
  ids: z.array(z.string().min(1).max(64)).max(500).optional(),
  type: z.string().max(64).optional(),
  status: z.string().max(64).optional(),
  counterpartyId: z.string().max(64).optional(),
  counterpartyName: z.string().max(300).optional(),
  jurisdiction: z.string().max(200).optional(),
  expiryDateTo: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  riskScoreMin: pct,
  riskScoreMax: pct,
  otdMin: pct,
  otdMax: pct,
  uptimeSlaMin: pct,
  uptimeSlaMax: pct,
  // docs/39 B3 — how much of each contract a person checked.
  checked: z.enum(['verified', 'partly', 'unverified']).optional(),
  // docs/39 A16 — the contracts one import made.
  importBatch: z.string().regex(/^imp_[0-9a-f]{12}$/).optional(),
  where: z.array(FieldFilterSchema).max(20).optional(),
  columns: z.array(z.string().min(1).max(64)).max(24).optional(),
  sort: z.object({ key: z.string().min(1).max(64), dir: z.enum(['asc', 'desc']) }).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
})

/** The most rows one export holds; past it, the response says how many matched. */
const EXPORT_MAX = 10_000
const EXPORT_CHUNK = 500
const APP_BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173'

/** Fields the export always has as columns of its own. */
const FIXED_EXPORT_KEYS = new Set(['value', 'currency', 'effectiveDate', 'expiryDate', 'counterpartyName'])

/** A field's column(s) in the export: money as an amount and a currency, dates as dates, numbers as numbers. */
function exportColumns(f: CatalogField): { headers: string[]; cells: (c: FieldCell | undefined) => unknown[] } {
  const v = (c: FieldCell | undefined) => c?.value ?? null
  switch (f.type) {
    case 'currency':
      return {
        headers: [f.label, `${f.label} currency`],
        cells: c => { const m = v(c) as { amount?: number; currency?: string } | null; return [m?.amount ?? null, m?.currency ?? null] },
      }
    case 'number':
    case 'percentage':
      return { headers: [f.unit ? `${f.label} (${f.unit})` : f.type === 'percentage' ? `${f.label} (%)` : f.label], cells: c => [typeof v(c) === 'number' ? v(c) : null] }
    case 'date':
      return { headers: [f.label], cells: c => [v(c) ? String(v(c)).slice(0, 10) : null] }
    default:
      return { headers: [f.label], cells: c => [c?.display || null] }
  }
}

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** "12 of 18" and the names of the AI's values nobody checked. */
function checkedCells(v: VerificationSummary | undefined, labelOf: (key: string) => string): unknown[] {
  if (!v || !v.filled) return [null, null]
  return [`${v.checked} of ${v.filled}`, v.unchecked.length ? v.unchecked.map(labelOf).join('; ') : null]
}

export async function contractQueryRoutes(app: FastifyInstance) {
  app.get('/fields', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    return reply.send({ fields: await fieldCatalog(req.user.orgId) })
  })

  app.post('/query', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = ContractQuerySchema.parse(req.body ?? {})
    const { orgId } = req.user
    const catalog = await fieldCatalog(orgId)
    const r = await queryContractIds({
      ...body, orgId,
      // X7 — own-scope callers see only their own contracts.
      ownerId: req.permissionScope === 'own' ? req.user.sub : undefined,
    }, catalog)
    if (!r.ok) return reply.status(400).send({ detail: r.detail })

    // The rows as GET /contracts returns them, in the query's order.
    const rows = r.ids.length
      ? await prisma.contract.findMany({
        where: { id: { in: r.ids }, orgId },
        include: {
          counterparty: { select: { id: true, name: true } },
          versions: { take: 1, orderBy: { versionNumber: 'asc' }, select: { s3Key: true } },
        },
      })
      : []
    const byId = new Map(rows.map(c => [c.id, c]))
    const ordered = r.ids.map(id => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c)
    const [cells, checked] = await Promise.all([
      fieldCells(ordered, body.columns ?? [], catalog, await fieldAccuracy(orgId)),
      verificationSummaries(ordered.map(c => c.id)),
    ])
    return reply.send({
      data: ordered.map(c => {
        const v = checked.get(c.id)
        return {
          ...c, riskScore: normalizeRiskScore(c.riskScore), fields: cells.get(c.id) ?? {},
          // B3 — Verified / Partly / Unverified, and how many of its values a person checked.
          verification: v ? { state: v.state, checked: v.checked, filled: v.filled } : null,
        }
      }),
      total: r.total,
      offset: body.offset,
      hasMore: body.offset + ordered.length < r.total,
    })
  })

  // ── docs/39 D3 — the list as filtered and sorted, with its field columns, as CSV ──
  // Needs the export right (viewers and approvers read the list, they don't take it away).
  app.post('/query/export', { preHandler: requirePermission('export', 'contract') }, async (req, reply) => {
    const body = ContractQuerySchema.omit({ offset: true, limit: true }).parse(req.body ?? {})
    const { orgId, sub: userId } = req.user
    const catalog = await fieldCatalog(orgId)
    const r = await queryContractIds({
      ...body, orgId, offset: 0, limit: EXPORT_MAX,
      ownerId: req.permissionScope === 'own' ? userId : undefined,
    }, catalog)
    if (!r.ok) return reply.status(400).send({ detail: r.detail })

    const fields = (body.columns ?? [])
      .map(k => catalogField(catalog, k))
      .filter((f): f is CatalogField => !!f && !FIXED_EXPORT_KEYS.has(f.key))
    const shapes = fields.map(exportColumns)
    // B3 — whoever gets the file can tell what a person checked: per contract,
    // how many values, and which of the AI's nobody did.
    const headers = [
      'Title', 'Type', 'Status', 'Counterparty', 'Effective date', 'Expiry date', 'Contract value', 'Currency',
      'Risk score', 'Created', ...shapes.flatMap(s => s.headers), 'Values checked', 'Not yet checked', 'Link',
    ]
    const labelOf = (key: string) => catalogField(catalog, key)?.label ?? key
    const rows: unknown[][] = []
    for (let i = 0; i < r.ids.length; i += EXPORT_CHUNK) {
      const ids = r.ids.slice(i, i + EXPORT_CHUNK)
      const chunk = await prisma.contract.findMany({
        where: { id: { in: ids }, orgId },
        select: {
          id: true, title: true, type: true, status: true, counterpartyName: true, effectiveDate: true, expiryDate: true,
          value: true, currency: true, riskScore: true, createdAt: true, jurisdiction: true, keyTerms: true, metadata: true,
          counterparty: { select: { name: true } },
        },
      })
      const byId = new Map(chunk.map(c => [c.id, c]))
      const [cells, checked] = await Promise.all([fieldCells(chunk, fields.map(f => f.key), catalog), verificationSummaries(ids)])
      for (const id of ids) {
        const c = byId.get(id)
        if (!c) continue
        const f = cells.get(id) ?? {}
        rows.push([
          c.title, c.type.replace(/_/g, ' '), c.status, c.counterpartyName ?? c.counterparty?.name ?? null,
          isoDay(c.effectiveDate), isoDay(c.expiryDate), c.value != null ? Number(c.value) : null, c.value != null ? c.currency : null,
          c.riskScore != null ? normalizeRiskScore(c.riskScore) : null, isoDay(c.createdAt),
          ...shapes.flatMap((s, j) => s.cells(f[fields[j].key])),
          ...checkedCells(checked.get(id), labelOf),
          `${APP_BASE}/contracts/${c.id}`,
        ])
      }
    }

    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACTS_EXPORTED, resourceType: 'contract', resourceId: 'list',
      metadata: { rows: rows.length, matched: r.total, columns: fields.map(f => f.key), where: body.where ?? [], format: 'csv' },
      ipAddress: req.ip,
    }).catch(() => {})
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="contracts-${new Date().toISOString().slice(0, 10)}.csv"`)
      // More matched than one export holds: the page says so.
      .header('x-total-count', String(r.total))
      .header('x-exported-count', String(rows.length))
      .send(buildSpreadsheetCsv(headers, rows))
  })
}
