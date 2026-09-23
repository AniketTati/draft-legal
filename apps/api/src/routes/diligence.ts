/**
 * Diligence Room routes (P9 Step 4 — Harvey Vault equivalent).
 *
 * A Diligence Room is a bag of contracts uploaded together for
 * cross-document analysis (M&A due diligence, vendor consolidation,
 * portfolio risk review). Each uploaded document creates a Contract
 * row with `diligenceRoomId` set — it goes through the standard parse
 * + extract + score pipeline but is hidden from the main repo by the
 * `diligenceRoomId IS NULL` filter on /contracts.
 *
 *   POST   /diligence                       — create room
 *   GET    /diligence                       — list rooms
 *   GET    /diligence/:id                   — single room + progress
 *   POST   /diligence/:id/upload            — multipart bulk upload
 *   GET    /diligence/:id/documents         — contract list within room
 *   GET    /diligence/:id/results           — flat extracted-fields table
 *   GET    /diligence/:id/export?format=csv — CSV download
 *   PATCH  /diligence/:id                   — rename / archive
 *   DELETE /diligence/:id                   — soft delete (cascades to contracts)
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'
import { queueParseDocument } from '../lib/queue.js'
import { indexContract } from '../lib/elasticsearch.js'
import { checkUpload, CONTRACT_DOCUMENT_TYPES } from '../lib/file-type.js'
import { guardOwnScopeRoutes, ownScopeGuard } from '../lib/own-scope-guard.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'

const CreateRoomSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
})

const PatchRoomSchema = z.object({
  name:        z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  status:      z.enum(['ACTIVE', 'ARCHIVED']).optional(),
})

// Cap a single multipart upload at 50 files — protects the API from
// 500-file uploads that would block the request thread.
const MAX_FILES_PER_UPLOAD = 50

export async function diligenceRoutes(app: FastifyInstance) {
  // X7 — an own-scope caller (view:contract at `own`) sees only the rooms it
  // created: the room, its documents, results and export.
  guardOwnScopeRoutes(app, /\/:id(\/|$)/, ownScopeGuard(
    async (req, id) => (await prisma.diligenceRoom.count({ where: { id, orgId: req.user.orgId, createdById: req.user.sub } })) > 0,
    'Diligence room not found',
  ))

  // ── POST / — create room ─────────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    let body
    try { body = CreateRoomSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const { orgId, sub: userId } = req.user
    const room = await prisma.diligenceRoom.create({
      data: {
        orgId, createdById: userId,
        name:        body.name.trim(),
        description: body.description?.trim() ?? null,
      },
    })
    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_CREATED,
      resourceType: 'diligence_room', resourceId: room.id,
      metadata: { source: 'diligence_create', name: room.name },
    })
    return reply.status(201).send(room)
  })

  // ── GET / — list rooms with progress counts ─────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const rooms = await prisma.diligenceRoom.findMany({
      where: { orgId, deletedAt: null, ...(req.permissionScope === 'own' ? { createdById: req.user.sub } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        _count: { select: { contracts: true } },
      },
    })

    // Fan out per-room progress queries — small N (≤200) so this is fine.
    const enriched = await Promise.all(rooms.map(async r => {
      const [done, failed, processing] = await Promise.all([
        prisma.contract.count({ where: { diligenceRoomId: r.id, analysisStatus: 'DONE' } }),
        prisma.contract.count({ where: { diligenceRoomId: r.id, analysisStatus: 'FAILED' } }),
        prisma.contract.count({
          where: {
            diligenceRoomId: r.id,
            analysisStatus: { in: ['PENDING', 'ANALYZING', 'PARSING', 'EXTRACTING', 'INDEXING', 'CLASSIFYING', 'SPLITTING'] },
          },
        }),
      ])
      return {
        ...r,
        documentCount: r._count.contracts,
        progress: { done, failed, processing },
      }
    }))

    return reply.send({ data: enriched })
  })

  // ── GET /:id — single room ───────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const room = await prisma.diligenceRoom.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { _count: { select: { contracts: true } } },
    })
    if (!room) return reply.status(404).send({ detail: 'Diligence room not found' })

    const [done, failed, processing] = await Promise.all([
      prisma.contract.count({ where: { diligenceRoomId: room.id, analysisStatus: 'DONE' } }),
      prisma.contract.count({ where: { diligenceRoomId: room.id, analysisStatus: 'FAILED' } }),
      prisma.contract.count({
        where: {
          diligenceRoomId: room.id,
          analysisStatus: { in: ['PENDING', 'ANALYZING', 'PARSING', 'EXTRACTING', 'INDEXING', 'CLASSIFYING', 'SPLITTING'] },
        },
      }),
    ])

    return reply.send({
      ...room,
      documentCount: room._count.contracts,
      progress: { done, failed, processing },
    })
  })

  // ── PATCH /:id — rename / archive ────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    let body
    try { body = PatchRoomSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues })
    }
    const updated = await prisma.diligenceRoom.updateMany({
      where: { id, orgId, deletedAt: null },
      data:  body,
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'Diligence room not found' })
    return reply.send({ ok: true })
  })

  // ── DELETE /:id ──────────────────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('delete', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const updated = await prisma.diligenceRoom.updateMany({
      where: { id, orgId, deletedAt: null },
      data:  { deletedAt: new Date() },
    })
    if (updated.count === 0) return reply.status(404).send({ detail: 'Diligence room not found' })
    // Cascade: soft-delete all contracts in the room too.
    await prisma.contract.updateMany({
      where: { diligenceRoomId: id, deletedAt: null },
      data:  { deletedAt: new Date() },
    })
    return reply.status(204).send()
  })

  // ── POST /:id/upload — multipart bulk upload ─────────────────────────
  app.post('/:id/upload', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    const room = await prisma.diligenceRoom.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!room) return reply.status(404).send({ detail: 'Diligence room not found' })
    // X45 — an API key's uploads belong to the user who made the key.
    const ownerId = await actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

    const parts = req.parts()
    const files: { buffer: Buffer; mimeType: string; filename: string }[] = []
    for await (const part of parts) {
      if (part.type === 'file') {
        if (files.length >= MAX_FILES_PER_UPLOAD) {
          return reply.status(413).send({
            detail: `Too many files in one upload — cap is ${MAX_FILES_PER_UPLOAD}. Split into multiple requests.`,
          })
        }
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        files.push({
          buffer:   Buffer.concat(chunks),
          mimeType: part.mimetype,
          filename: part.filename || 'document.pdf',
        })
      }
    }
    if (files.length === 0) return reply.status(400).send({ detail: 'No files uploaded' })
    // S3 — validate every file's bytes before storing any. A data room batch
    // often holds a stray .doc or spreadsheet: skip those with a reason
    // rather than failing the other 49. The detected type replaces the declared one.
    const skipped: Array<{ filename: string; detail: string }> = []
    const accepted: typeof files = []
    for (const f of files) {
      const checked = checkUpload(f.buffer, f.mimeType, CONTRACT_DOCUMENT_TYPES)
      if (checked.ok) accepted.push({ ...f, mimeType: checked.mimeType })
      else skipped.push({ filename: f.filename, detail: checked.detail })
    }
    if (accepted.length === 0) {
      return reply.status(415).send({
        detail: skipped.map(s => `${s.filename}: ${s.detail}`).join(' '),
        skipped,
      })
    }

    const created = []
    for (const f of accepted) {
      const cleanTitle = f.filename
        .replace(/\.[^.]+$/, '')
        .replace(/[_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      const s3Key = `${orgId}/diligence/${id}/${Date.now()}-${f.filename.replace(/[^\w.\-]+/g, '_')}`
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: s3Key, Body: f.buffer, ContentType: f.mimeType,
      }))

      const contract = await prisma.contract.create({
        data: {
          orgId, ownerId,
          title:   cleanTitle || f.filename,
          type:    'OTHER',
          status:  'DRAFT',
          analysisStatus: 'PENDING',
          diligenceRoomId: id,
          versions: {
            create: {
              versionNumber: 1,
              htmlContent: '',
              plainText:   '',
              s3Key,
              mimeType:    f.mimeType,
              fileSize:    f.buffer.byteLength,
              createdById: userId,
            },
          },
        },
        include: { versions: true },
      })
      await prisma.contract.update({
        where: { id: contract.id },
        data: { currentVersionId: contract.versions[0].id },
      })
      // Queue parse → chains to extract → chunk-and-index → score, exactly
      // like a normal contract upload.
      queueParseDocument({
        contractId: contract.id,
        versionId:  contract.versions[0].id,
        s3Key, mimeType: f.mimeType, orgId,
        filename:   f.filename,
      })

      // ES index with sparse data; gets refreshed after parse completes.
      indexContract(contract.id, {
        orgId,
        title:     contract.title,
        type:      contract.type,
        status:    contract.status,
        plainText: '',
        tags:      contract.tags,
        createdAt: contract.createdAt.toISOString(),
        diligenceRoomId: id,
      } as never).catch(err => app.log.warn({ err }, 'ES initial index failed'))

      created.push({
        id:    contract.id,
        title: contract.title,
        s3Key,
        analysisStatus: contract.analysisStatus,
      })
    }

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_UPLOADED,
      resourceType: 'diligence_room', resourceId: id,
      metadata: { fileCount: accepted.length, skippedCount: skipped.length, source: 'diligence_upload' },
    })

    // Bump the room's updatedAt so it floats to the top of the list.
    await prisma.diligenceRoom.update({
      where: { id }, data: { updatedAt: new Date() },
    })

    return reply.status(201).send({ data: created, count: created.length, skipped })
  })

  // ── GET /:id/documents — list with extraction status ─────────────────
  app.get('/:id/documents', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const room = await prisma.diligenceRoom.findFirst({
      where: { id, orgId, deletedAt: null }, select: { id: true },
    })
    if (!room) return reply.status(404).send({ detail: 'Diligence room not found' })

    const docs = await prisma.contract.findMany({
      where: { diligenceRoomId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true,
        effectiveDate: true, expiryDate: true, jurisdiction: true,
        riskScore: true, riskFactors: true, overallConfidence: true,
        analysisStatus: true, analysisError: true,
        createdAt: true, updatedAt: true,
      },
    })
    return reply.send({ data: docs })
  })

  // ── GET /:id/results — flat extracted-fields table ───────────────────
  // Returns one row per document with all the comparable fields the UI
  // wants to render in a tabular cross-document view.
  app.get('/:id/results', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const room = await prisma.diligenceRoom.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!room) return reply.status(404).send({ detail: 'Diligence room not found' })

    const docs = await prisma.contract.findMany({
      where: { diligenceRoomId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 1_000,
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true,
        effectiveDate: true, expiryDate: true, jurisdiction: true,
        riskScore: true, riskFactors: true, overallConfidence: true,
        keyTerms: true, summary: true, tags: true,
        analysisStatus: true,
      },
    })

    const rows = docs.map(d => {
      const kt = (d.keyTerms ?? {}) as Record<string, unknown>
      return {
        id:               d.id,
        title:            d.title,
        type:             d.type,
        status:           d.status,
        counterpartyName: d.counterpartyName,
        value:            d.value ? Number(d.value.toString()) : null,
        currency:         d.currency,
        effectiveDate:    d.effectiveDate?.toISOString().slice(0, 10) ?? null,
        expiryDate:       d.expiryDate?.toISOString().slice(0, 10) ?? null,
        jurisdiction:     d.jurisdiction,
        riskScore:        d.riskScore,
        riskFactors:      d.riskFactors,
        overallConfidence: d.overallConfidence,
        summary:          d.summary,
        analysisStatus:   d.analysisStatus,
        // Surface a few common keyTerms as columns so users can compare.
        autoRenew:        kt.auto_renew ?? kt.autoRenew ?? null,
        terminationNotice: kt.termination_notice_days ?? kt.terminationNoticeDays ?? null,
        governingLaw:     kt.governing_law ?? kt.governingLaw ?? null,
        paymentTerms:     kt.payment_terms ?? kt.paymentTerms ?? null,
      }
    })

    return reply.send({
      data:  rows,
      total: rows.length,
      room:  { id: room.id, name: room.name },
    })
  })

  // ── GET /:id/export?format=csv — CSV download ────────────────────────
  app.get('/:id/export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const format = ((req.query as { format?: string }).format ?? 'csv').toLowerCase()
    if (format !== 'csv') {
      return reply.status(400).send({ detail: 'Only csv is supported (Excel coming in V1.1)' })
    }
    const { orgId } = req.user
    const room = await prisma.diligenceRoom.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!room) return reply.status(404).send({ detail: 'Diligence room not found' })

    const docs = await prisma.contract.findMany({
      where: { diligenceRoomId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 5_000,
      select: {
        title: true, type: true, status: true,
        counterpartyName: true, value: true, currency: true,
        effectiveDate: true, expiryDate: true, jurisdiction: true,
        riskScore: true, summary: true, keyTerms: true, analysisStatus: true,
      },
    })

    const headers = [
      'Title', 'Type', 'Status', 'Counterparty', 'Value', 'Currency',
      'Effective Date', 'Expiry Date', 'Jurisdiction', 'Risk Score',
      'Auto Renew', 'Termination Notice', 'Governing Law', 'Payment Terms',
      'Analysis Status', 'Summary',
    ]
    const escape = (v: unknown): string => {
      if (v == null) return ''
      const s = String(v)
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const lines: string[] = [headers.join(',')]
    for (const d of docs) {
      const kt = (d.keyTerms ?? {}) as Record<string, unknown>
      lines.push([
        escape(d.title),
        escape(d.type),
        escape(d.status),
        escape(d.counterpartyName),
        escape(d.value ? Number(d.value.toString()) : ''),
        escape(d.currency),
        escape(d.effectiveDate?.toISOString().slice(0, 10)),
        escape(d.expiryDate?.toISOString().slice(0, 10)),
        escape(d.jurisdiction),
        escape(d.riskScore != null ? Math.round(d.riskScore * 100) : ''),
        escape(kt.auto_renew ?? kt.autoRenew),
        escape(kt.termination_notice_days ?? kt.terminationNoticeDays),
        escape(kt.governing_law ?? kt.governingLaw),
        escape(kt.payment_terms ?? kt.paymentTerms),
        escape(d.analysisStatus),
        escape(d.summary),
      ].join(','))
    }
    const csv = lines.join('\n')

    const safeName = room.name.replace(/[^\w.\-]+/g, '_').slice(0, 100)
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${safeName}-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })
}
