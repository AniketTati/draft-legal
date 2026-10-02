/**
 * Obligation routes (P8 Step 3).
 *
 *   GET  /api/v1/obligations
 *     Org-wide list with filters: status, type, severity, contractId,
 *     dueWithin (days), q (search description+contract title), sort.
 *     Returns paginated rows with contract context (title, status,
 *     counterparty) so the table can render a single page without
 *     N+1 fetches.
 *
 *   GET  /api/v1/obligations/:id
 *     Single obligation with full contract context (used by detail
 *     drawer + complete modal).
 *
 *   POST /api/v1/obligations/:id/complete   ← Step 4
 *
 *   GET  /api/v1/obligations/stats
 *     KPI counts: open, due-soon, overdue, completed (last 30d). Used
 *     by the page header.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { queueExtractObligations } from '../lib/queue.js'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { buildCsv } from '../lib/csv.js'
import { withReplacedBy, replacedStatus } from '../lib/amendments.js'
import { fireWebhook } from '../lib/webhook-events.js'
import { checkUpload, servableContentType, EVIDENCE_TYPES } from '../lib/file-type.js'
import { guardOwnScopeRoutes, ownScopeGuard } from '../lib/own-scope-guard.js'

const ListSchema = z.object({
  status:     z.enum(['PROPOSED', 'OPEN', 'COMPLETED', 'OVERDUE', 'WAIVED', 'all']).default('all'),
  type:       z.string().optional(),
  severity:   z.enum(['low', 'medium', 'high']).optional(),
  contractId: z.string().optional(),
  dueWithin:  z.coerce.number().int().min(0).max(3650).optional(),
  /** "due_soon" → only items with dueDate inside next 30d (incl overdue) */
  bucket:     z.enum(['all', 'due_soon', 'overdue', 'open', 'completed']).default('all'),
  q:          z.string().optional(),
  sort:       z.enum(['dueDate', 'severity', 'createdAt']).default('dueDate'),
  order:      z.enum(['asc', 'desc']).default('asc'),
  limit:      z.coerce.number().int().min(1).max(100).default(50),
  offset:     z.coerce.number().int().min(0).default(0),
  // docs/39 G4 — the AI's suggestions, the confirmed ones, or both (never the dismissed, unless asked).
  review:     z.enum(['all', 'suggested', 'confirmed', 'dismissed']).default('all'),
})

/** G4 — which review state a list shows: a dismissed suggestion is gone unless asked for. */
/**
 * Fix-up 13 — an obligation an amendment replaced stays on the record (the
 * full list shows it as "Replaced by Amendment No. N") but isn't owed: the
 * open, due-soon and overdue views and counts leave it out.
 */
function owedWhere(q: { bucket: string; status: string }): { supersededAt?: null } {
  return ['open', 'due_soon', 'overdue'].includes(q.bucket) || ['OPEN', 'OVERDUE'].includes(q.status) ? { supersededAt: null } : {}
}

function reviewWhere(review: 'all' | 'suggested' | 'confirmed' | 'dismissed'): { reviewState: string | { not: string } } {
  if (review === 'suggested') return { reviewState: 'SUGGESTED' }
  if (review === 'confirmed') return { reviewState: 'CONFIRMED' }
  if (review === 'dismissed') return { reviewState: 'DISMISSED' }
  return { reviewState: { not: 'DISMISSED' } }
}

/** G4 — what a person may change as they confirm a suggestion. */
const ConfirmSchema = z.object({
  description: z.string().trim().min(1).max(4000).optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  owner:       z.enum(['customer', 'provider', 'either', 'unknown']).optional(),
  severity:    z.enum(['low', 'medium', 'high']).optional(),
  recurrence:  z.string().max(40).optional(),
}).default({})

/** G4 — the org's signed contracts never read for obligations (and with text to read). */
function unreadSignedSql(orgId: string, ownerId?: string): Prisma.Sql {
  return Prisma.sql`c."orgId" = ${orgId} AND c."deletedAt" IS NULL AND c."diligenceRoomId" IS NULL
    AND c.status = 'EXECUTED' AND (c.metadata->>'obligationsExtractedAt') IS NULL
    ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
    AND EXISTS (SELECT 1 FROM contract_versions v WHERE v."contractId" = c.id AND COALESCE(v."plainText", '') <> '')`
}

/** At most this many contracts queued for obligations per press. */
const FIND_MAX = 500

/**
 * X7 — own-scope callers see only the obligations of contracts they own.
 * X17 — and, unless one contract is asked about, none of a diligence room's
 * contracts: a target's obligations aren't the org's.
 */
function ownObligationWhere(req: FastifyRequest, contractId?: string): { contract: { is: { diligenceRoomId?: null; ownerId?: string } } } {
  return { contract: { is: {
    ...(contractId ? {} : { diligenceRoomId: null }),
    ...(req.permissionScope === 'own' ? { ownerId: req.user.sub } : {}),
  } } }
}

export async function obligationRoutes(app: FastifyInstance) {
  // X7 — by id, an own-scope caller must own the obligation's contract.
  guardOwnScopeRoutes(app, /\/:id(\/|$)/, ownScopeGuard(
    async (req, id) => (await prisma.obligation.count({ where: { id, orgId: req.user.orgId, contract: { is: { ownerId: req.user.sub } } } })) > 0,
    'Obligation not found',
  ))

  // ── GET / ──────────────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    let q
    try { q = ListSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user

    const where: Record<string, unknown> = { orgId, ...ownObligationWhere(req, q.contractId), ...reviewWhere(q.review) }
    if (q.status !== 'all') where.status = q.status
    // docs/41 Part 11 — a draft's proposed obligations aren't owed yet: they
    // show on their contract, or when asked for, not in the org's list.
    else if (!q.contractId) where.status = { not: 'PROPOSED' }
    if (q.type)             where.type = q.type
    if (q.severity)         where.severity = q.severity
    if (q.contractId)       where.contractId = q.contractId

    // Bucket filters take precedence over raw status when set.
    const now = new Date()
    if (q.bucket === 'due_soon') {
      const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      where.status = 'OPEN'
      where.dueDate = { lte: horizon }
    } else if (q.bucket === 'overdue') {
      where.status = 'OPEN'
      where.dueDate = { lt: now }
    } else if (q.bucket === 'open') {
      where.status = 'OPEN'
    } else if (q.bucket === 'completed') {
      where.status = 'COMPLETED'
    }
    Object.assign(where, owedWhere(q))

    if (q.dueWithin != null) {
      const horizon = new Date(now.getTime() + q.dueWithin * 24 * 60 * 60 * 1000)
      where.dueDate = { ...(where.dueDate as object ?? {}), lte: horizon }
    }

    if (q.q) {
      // Search description + contract title (case-insensitive).
      where.OR = [
        { description: { contains: q.q, mode: 'insensitive' } },
        { contract: { is: { title: { contains: q.q, mode: 'insensitive' } } } },
      ]
    }

    // Sort. dueDate-asc puts NULLs last by chaining createdAt.
    let orderBy: object | object[] = { [q.sort]: q.order }
    if (q.sort === 'dueDate') {
      orderBy = [
        { dueDate: { sort: q.order, nulls: 'last' } as never },
        { createdAt: 'asc' },
      ]
    } else if (q.sort === 'severity') {
      // emulate severity ranking via createdAt fallback; Postgres collation
      // gives high>medium>low alphabetically as h>m>l so desc=most-severe.
      orderBy = [{ severity: q.order }, { createdAt: 'asc' }]
    }

    const [items, total] = await Promise.all([
      prisma.obligation.findMany({
        where: where as never,
        orderBy: orderBy as never,
        skip: q.offset, take: q.limit,
        include: {
          contract: {
            select: { id: true, title: true, status: true, type: true, counterpartyName: true },
          },
          completedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.obligation.count({ where: where as never }),
    ])

    return reply.send({
      data: await withReplacedBy(orgId, items),
      total,
      limit: q.limit,
      offset: q.offset,
    })
  })

  // ── GET /export — CSV download (P9 Step 7) ─────────────────────────
  // Mirrors the GET / filter set so users can export exactly what
  // they're seeing on screen.
  app.get('/export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const format = ((req.query as { format?: string }).format ?? 'csv').toLowerCase()
    if (format !== 'csv') return reply.status(400).send({ detail: 'Only csv is supported' })
    let q
    try { q = ListSchema.parse(req.query as Record<string, unknown>) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid query', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId } = req.user
    const where: Record<string, unknown> = { orgId, ...ownObligationWhere(req, q.contractId), ...reviewWhere(q.review) }
    if (q.status !== 'all') where.status = q.status
    // docs/41 Part 11 — a draft's proposed obligations aren't owed yet: they
    // show on their contract, or when asked for, not in the org's list.
    else if (!q.contractId) where.status = { not: 'PROPOSED' }
    if (q.type)             where.type = q.type
    if (q.severity)         where.severity = q.severity
    if (q.contractId)       where.contractId = q.contractId
    const now = new Date()
    if (q.bucket === 'due_soon') {
      where.status = 'OPEN'
      where.dueDate = { lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) }
    } else if (q.bucket === 'overdue') {
      where.status = 'OPEN'
      where.dueDate = { lt: now }
    } else if (q.bucket === 'open') {
      where.status = 'OPEN'
    } else if (q.bucket === 'completed') {
      where.status = 'COMPLETED'
    }
    Object.assign(where, owedWhere(q))

    const items = await prisma.obligation.findMany({
      where: where as never,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } as never }, { createdAt: 'asc' }],
      take: 5_000,
      include: {
        contract: { select: { id: true, title: true, counterpartyName: true, type: true } },
        completedBy: { select: { name: true, email: true } },
      },
    })

    const marked = await withReplacedBy(orgId, items)
    const headers = [
      'Type', 'Description', 'Owner', 'Severity', 'Recurrence', 'Section',
      'Due Date', 'Status', 'Contract', 'Counterparty', 'Contract Type',
      'Completed At', 'Completed By', 'Completion Note', 'Has Evidence',
    ]
    const rows = marked.map(o => [
      o.type, o.description, o.owner, o.severity, o.recurrence, o.sectionRef ?? '',
      o.dueDate?.toISOString().slice(0, 10) ?? '',
      replacedStatus(o.replacedBy, o.status),
      o.contract?.title ?? '',
      o.contract?.counterpartyName ?? '',
      o.contract?.type ?? '',
      o.completedAt?.toISOString().slice(0, 19).replace('T', ' ') ?? '',
      o.completedBy?.email ?? '',
      o.completionNote ?? '',
      o.evidenceS3Key ? 'yes' : 'no',
    ])
    const csv = buildCsv(headers, rows)
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="obligations-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })

  // ── GET /stats — KPI numbers for the page header ──────────────────────
  app.get('/stats', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const now = new Date()
    const dueSoonHorizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    const recentCompletedSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const own = ownObligationWhere(req)

    // G4 — a dismissed suggestion isn't an obligation: it counts nowhere.
    // Fix-up 13 — nor is one an amendment replaced: it is on the record, not owed.
    const live = { reviewState: { not: 'DISMISSED' }, supersededAt: null }
    const [open, dueSoon, overdue, completedRecent, suggested, unread] = await Promise.all([
      prisma.obligation.count({ where: { orgId, ...own, ...live, status: 'OPEN' } }),
      prisma.obligation.count({
        where: { orgId, ...own, ...live, status: 'OPEN', dueDate: { gte: now, lte: dueSoonHorizon } },
      }),
      prisma.obligation.count({
        where: { orgId, ...own, ...live, status: 'OPEN', dueDate: { lt: now, not: null } },
      }),
      prisma.obligation.count({
        where: { orgId, ...own, ...live, status: 'COMPLETED', completedAt: { gte: recentCompletedSince } },
      }),
      prisma.obligation.count({ where: { orgId, ...own, reviewState: 'SUGGESTED', supersededAt: null, status: { in: ['OPEN', 'OVERDUE'] } } }),
      prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM contracts c WHERE ${unreadSignedSql(orgId, req.permissionScope === 'own' ? req.user.sub : undefined)}`,
    ])

    return reply.send({ open, dueSoon, overdue, completedRecent, suggested, unreadSigned: unread[0]?.n ?? 0 })
  })

  // ── POST /find — docs/39 G4: read signed contracts for their obligations ──
  // The org's signed contracts never read (or those named), queued in the
  // background; what's found arrives as suggestions.
  app.post('/find', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const body = z.object({ contractIds: z.array(z.string().min(1).max(64)).max(FIND_MAX).optional() }).parse(req.body ?? {})
    const { orgId } = req.user
    const ownerId = req.permissionScope === 'own' ? req.user.sub : undefined
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM contracts c WHERE ${unreadSignedSql(orgId, ownerId)}
      ${body.contractIds ? Prisma.sql`AND c.id IN (${Prisma.join(body.contractIds.length ? body.contractIds : [''])})` : Prisma.empty}
      ORDER BY c."updatedAt" DESC LIMIT ${FIND_MAX + 1}`
    const ids = rows.slice(0, FIND_MAX).map(r => r.id)
    let queued = 0
    for (const contractId of ids) if (await queueExtractObligations({ orgId, contractId })) queued++
    return reply.status(202).send({ queued, more: rows.length > FIND_MAX })
  })

  // ── POST /review — docs/39 G4: confirm or dismiss suggestions in bulk ──
  app.post('/review', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200), action: z.enum(['confirm', 'dismiss']) }).parse(req.body)
    const { orgId, sub: userId } = req.user
    const r = await prisma.obligation.updateMany({
      // X7 — own-scope callers review only their own contracts' obligations.
      where: { id: { in: body.ids }, orgId, reviewState: 'SUGGESTED', ...(req.permissionScope === 'own' ? { contract: { is: { ownerId: req.user.sub } } } : {}) },
      data: { reviewState: body.action === 'confirm' ? 'CONFIRMED' : 'DISMISSED', reviewedAt: new Date(), reviewedById: userId.startsWith('apikey:') ? null : userId },
    })
    await createAuditEvent({
      orgId, userId, action: AuditAction.OBLIGATION_REVIEWED, resourceType: 'obligation', resourceId: 'bulk',
      metadata: { action: body.action, count: r.count, ids: body.ids.slice(0, 50) },
    }).catch(() => {})
    return reply.send({ ok: true, count: r.count })
  })

  // ── GET /:id — single obligation with contract context ────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const o = await prisma.obligation.findFirst({
      where: { id, orgId },
      include: {
        contract: { select: { id: true, title: true, status: true, type: true, counterpartyName: true, ownerId: true, owner: { select: { name: true, email: true } } } },
        completedBy: { select: { id: true, name: true, email: true } },
      },
    })
    if (!o) return reply.status(404).send({ detail: 'Obligation not found' })
    return reply.send((await withReplacedBy(orgId, [o]))[0])
  })

  // ── POST /:id/complete (P8 Step 4) ────────────────────────────────────
  // Mark an obligation done, with optional evidence file + completion note.
  // Multipart: file (optional), note (optional). When a file is uploaded
  // it lands in S3 under obligations/<orgId>/<id>/<filename>.
  app.post('/:id/complete', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    const existing = await prisma.obligation.findFirst({
      where: { id, orgId },
      select: { id: true, contractId: true, type: true, description: true, status: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Obligation not found' })
    if (existing.status === 'COMPLETED') {
      return reply.status(409).send({ detail: 'Already completed' })
    }
    if (existing.status === 'PROPOSED') {
      return reply.status(409).send({ detail: 'This obligation is proposed: it is owed once the contract is signed.' })
    }
    // X45 — who completed it is a user, and a key is none: a key's completion
    // records no one here (its audit event names the key).
    const completedById = req.user.sub.startsWith('apikey:') ? null : userId

    let note = ''
    let fileBuffer: Buffer | null = null
    let mimeType = ''
    let filename = ''

    // Support both multipart/form-data (with file) AND application/json (no file).
    const ct = req.headers['content-type'] ?? ''
    if (ct.startsWith('multipart/')) {
      const parts = req.parts()
      for await (const part of parts) {
        if (part.type === 'file') {
          const chunks: Buffer[] = []
          for await (const chunk of part.file) chunks.push(chunk)
          fileBuffer = Buffer.concat(chunks)
          mimeType   = part.mimetype
          filename   = part.filename || 'evidence.bin'
        } else if (part.fieldname === 'note') {
          note = String((part as { value?: unknown }).value ?? '').slice(0, 4000)
        }
      }
    } else {
      const body = (req.body ?? {}) as { note?: string }
      note = (body.note ?? '').slice(0, 4000)
    }

    let evidenceS3Key: string | null = null
    if (fileBuffer) {
      // Cap evidence file size at 25MB — generous for invoices/receipts but
      // protects S3 + the email reminder pipeline (some senders block >10MB).
      if (fileBuffer.byteLength > 25 * 1024 * 1024) {
        return reply.status(413).send({ detail: 'Evidence file too large (25MB max)' })
      }
      // S3 — the evidence is served back by presigned URL with the stored type.
      const checked = checkUpload(fileBuffer, mimeType, EVIDENCE_TYPES)
      if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
      mimeType = checked.mimeType
      evidenceS3Key = `${orgId}/obligations/${id}/${Date.now()}-${filename.replace(/[^\x20-\x7E]/g, '').slice(0, 200)}`
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key:    evidenceS3Key,
        Body:   fileBuffer,
        ContentType: mimeType,
      }))
    }

    const completedAt = new Date()
    const updated = await prisma.obligation.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt,
        completedById,
        completionNote:  note || null,
        evidenceS3Key:   evidenceS3Key,
        evidenceFilename: fileBuffer ? filename : null,
        evidenceMimeType: fileBuffer ? mimeType : null,
        evidenceSize:     fileBuffer ? fileBuffer.byteLength : null,
      },
      include: {
        completedBy: { select: { id: true, name: true, email: true } },
        contract:    { select: { id: true, title: true } },
      },
    })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.OBLIGATION_COMPLETED,
      resourceType: 'contract', resourceId: existing.contractId,
      metadata: {
        obligationId: id,
        type: existing.type,
        hasEvidence: !!evidenceS3Key,
        hasNote: !!note,
      },
    })
    fireWebhook(orgId, 'obligation.completed', {
      obligationId: id, contractId: existing.contractId,
      type: existing.type, completedAt: completedAt.toISOString(),
      hasEvidence: !!evidenceS3Key,
    })

    return reply.send(updated)
  })

  // ── GET /:id/evidence — presigned download URL ────────────────────────
  app.get('/:id/evidence', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const o = await prisma.obligation.findFirst({
      where: { id, orgId },
      select: { evidenceS3Key: true, evidenceFilename: true, evidenceMimeType: true },
    })
    if (!o) return reply.status(404).send({ detail: 'Obligation not found' })
    if (!o.evidenceS3Key) return reply.status(404).send({ detail: 'No evidence on this obligation' })

    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key:    o.evidenceS3Key,
      ResponseContentDisposition: `attachment; filename="${o.evidenceFilename ?? 'evidence'}"`,
      ResponseContentType: servableContentType(o.evidenceMimeType),
    }), { expiresIn: 600 })

    return reply.send({ url, filename: o.evidenceFilename, mimeType: o.evidenceMimeType })
  })

  // ── POST /:id/confirm, /:id/dismiss — docs/39 G4 ───────────────────────
  // A suggestion the AI made becomes an obligation (as it stands, or as a
  // person corrected it), or is dismissed and not suggested again.
  app.post('/:id/confirm', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const edits = ConfirmSchema.parse(req.body ?? {})
    const existing = await prisma.obligation.findFirst({ where: { id, orgId }, select: { id: true, contractId: true, reviewState: true } })
    if (!existing) return reply.status(404).send({ detail: 'Obligation not found' })
    const updated = await prisma.obligation.update({
      where: { id },
      data: {
        ...(edits.description !== undefined && { description: edits.description }),
        ...(edits.dueDate !== undefined && { dueDate: edits.dueDate ? new Date(`${edits.dueDate}T00:00:00Z`) : null }),
        ...(edits.owner !== undefined && { owner: edits.owner }),
        ...(edits.severity !== undefined && { severity: edits.severity }),
        ...(edits.recurrence !== undefined && { recurrence: edits.recurrence }),
        reviewState: 'CONFIRMED', reviewedAt: new Date(), reviewedById: userId.startsWith('apikey:') ? null : userId,
      },
    })
    await createAuditEvent({
      orgId, userId, action: AuditAction.OBLIGATION_REVIEWED, resourceType: 'contract', resourceId: existing.contractId,
      metadata: { obligationId: id, action: 'confirm', from: existing.reviewState, edited: Object.keys(edits) },
    }).catch(() => {})
    return reply.send(updated)
  })

  app.post('/:id/dismiss', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const existing = await prisma.obligation.findFirst({ where: { id, orgId }, select: { id: true, contractId: true, status: true, reviewState: true } })
    if (!existing) return reply.status(404).send({ detail: 'Obligation not found' })
    if (existing.status === 'COMPLETED') return reply.status(409).send({ detail: 'A completed obligation can’t be dismissed: reopen it first' })
    const updated = await prisma.obligation.update({
      where: { id },
      data: { reviewState: 'DISMISSED', reviewedAt: new Date(), reviewedById: userId.startsWith('apikey:') ? null : userId },
    })
    await createAuditEvent({
      orgId, userId, action: AuditAction.OBLIGATION_REVIEWED, resourceType: 'contract', resourceId: existing.contractId,
      metadata: { obligationId: id, action: 'dismiss', from: existing.reviewState },
    }).catch(() => {})
    return reply.send(updated)
  })

  // ── POST /:id/reopen — undo completion (admins/owners) ────────────────
  app.post('/:id/reopen', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const existing = await prisma.obligation.findFirst({
      where: { id, orgId },
      select: { id: true, contractId: true, status: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Obligation not found' })
    if (existing.status !== 'COMPLETED') {
      return reply.status(409).send({ detail: 'Obligation is not completed' })
    }
    const updated = await prisma.obligation.update({
      where: { id },
      data: {
        status: 'OPEN',
        completedAt: null, completedById: null, completionNote: null,
        // Evidence file is retained on S3 for audit; we just unlink it
        // from the row so it won't show on the next completion.
        evidenceS3Key: null, evidenceFilename: null, evidenceMimeType: null, evidenceSize: null,
      },
    })
    await createAuditEvent({
      orgId, userId,
      action: AuditAction.OBLIGATION_COMPLETED,
      resourceType: 'contract', resourceId: existing.contractId,
      metadata: { obligationId: id, action: 'reopen' },
    })
    return reply.send(updated)
  })
}
