/**
 * docs/39 A16 — contracts imported from a spreadsheet, with their documents
 * (lib/contract-import.ts):
 *
 *   POST /api/v1/contracts/import/read           a spreadsheet (CSV or .xlsx): its columns, its rows, and where each column likely goes
 *   POST /api/v1/contracts/import                a chunk of its rows made contracts: { batch?, plan, rows }
 *   POST /api/v1/contracts/:id/import-document   the document an imported row goes with, then read by the AI
 *
 * POST /contracts/bulk-import (a CSV with fixed columns) stays, for the API.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { AuditAction, suggestImportTarget } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { createAuditEvent } from '../lib/audit.js'
import { checkUpload, CONTRACT_DOCUMENT_TYPES, MIME } from '../lib/file-type.js'
import { queueParseDocument } from '../lib/queue.js'
import { fieldCatalog } from '../lib/field-query.js'
import { readSpreadsheet } from '../lib/spreadsheet.js'
import { importRows, newImportBatch, waitingForDocument } from '../lib/contract-import.js'

const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title') }),
  z.object({ kind: z.literal('type') }),
  z.object({ kind: z.literal('status') }),
  z.object({ kind: z.literal('file') }),
  z.object({ kind: z.literal('owner') }),
  z.object({ kind: z.literal('field'), key: z.string().min(1).max(100) }),
])

/** Rows per request: the wizard sends a large sheet a chunk at a time, and shows it going. */
export const IMPORT_CHUNK = 100

/** A spreadsheet past this is split: a thousand rows of contracts is far smaller. */
const SHEET_MAX_BYTES = 10 * 1024 * 1024

const ImportSchema = z.object({
  batch: z.string().regex(/^imp_[0-9a-f]{12}$/).optional(),
  plan: z.object({
    // None, when only documents are imported.
    headers: z.array(z.string().max(300)).max(100),
    mapping: z.array(TargetSchema.nullable()).max(100),
    typeValues: z.record(z.string().max(300), z.string().max(40)).optional(),
    statusValues: z.record(z.string().max(300), z.string().max(40)).optional(),
    defaultStatus: z.enum(['DRAFT', 'EXECUTED']).optional(),
  }),
  rows: z.array(z.object({
    // 0: a document without a row, named by its file.
    row: z.number().int().min(0).max(1_000_000),
    cells: z.array(z.string().max(10_000)).max(100),
    file: z.string().max(500).nullable().optional(),
  })).min(1).max(IMPORT_CHUNK),
})

export async function contractImportRoutes(app: FastifyInstance) {
  // X7 — an own-scope caller attaches documents only to contracts they own.
  guardOwnScopeContractRoutes(app)

  app.post('/import/read', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    let file: Buffer | null = null
    let filename = ''
    let declared = ''
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue
      const chunks: Buffer[] = []
      for await (const chunk of part.file) chunks.push(chunk)
      file = Buffer.concat(chunks)
      filename = part.filename
      declared = part.mimetype
      break
    }
    if (!file?.length) return reply.status(400).send({ detail: 'No spreadsheet uploaded' })
    if (file.length > SHEET_MAX_BYTES) return reply.status(413).send({ detail: 'The spreadsheet is over 10 MB: split it into smaller ones.' })
    // An Excel file is a zip: checked for what it opens up to before it's read (Wave 1.8's guard).
    if (file.subarray(0, 2).toString('latin1') === 'PK') {
      const checked = checkUpload(file, declared, [MIME.XLSX])
      if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
    }
    // Only read, never stored: text a CSV reader can't read is refused below.
    const sheet = await readSpreadsheet(file)
    if (!sheet.ok) return reply.status(422).send({ detail: sheet.detail })
    const catalog = await fieldCatalog(req.user.orgId)
    // A kind of target goes to one column: the first header that names it.
    const taken = new Set<string>()
    const suggestions = sheet.headers.map(h => {
      const t = suggestImportTarget(h, catalog)
      const id = t ? (t.kind === 'field' ? `field:${t.key}` : t.kind) : null
      if (!t || !id || taken.has(id)) return null
      taken.add(id)
      return t
    })
    return reply.send({ filename, sheetName: sheet.sheetName ?? null, headers: sheet.headers, rows: sheet.rows, total: sheet.total, suggestions })
  })

  app.post('/import', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const parsed = ImportSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ detail: 'Invalid request', issues: parsed.error.issues })
    const { plan, rows } = parsed.data
    // X45 — an API key's contracts belong to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)
    // Each of a contract's own properties comes from one column; a field too.
    const seen = new Set<string>()
    for (const t of plan.mapping) {
      if (!t) continue
      const id = t.kind === 'field' ? `field:${t.key}` : t.kind
      if (seen.has(id)) return reply.status(400).send({ detail: `Two columns go to the same ${t.kind === 'field' ? 'field' : t.kind}: pick one.` })
      seen.add(id)
    }
    const batch = parsed.data.batch ?? newImportBatch()
    const results = await importRows({ orgId: req.user.orgId, userId: req.user.sub, ownerId, batch, plan, rows, ipAddress: req.ip })
    return reply.send({ batch, results })
  })

  app.post('/:id/import-document', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await waitingForDocument(orgId, id)
    if (!contract) {
      const exists = await prisma.contract.count({ where: { id, orgId, deletedAt: null } })
      return reply.status(exists ? 409 : 404).send({ detail: exists ? 'This contract isn’t waiting for an imported document.' : 'Contract not found' })
    }
    let file: Buffer | null = null
    let mimeType = 'application/pdf'
    let filename = 'document.pdf'
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue
      const chunks: Buffer[] = []
      for await (const chunk of part.file) chunks.push(chunk)
      file = Buffer.concat(chunks)
      mimeType = part.mimetype
      filename = part.filename || filename
      break
    }
    if (!file?.length) return reply.status(400).send({ detail: 'No file uploaded' })
    // Wave 1.8 — the bytes say what it is, not the name.
    const checked = checkUpload(file, mimeType, CONTRACT_DOCUMENT_TYPES)
    if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
    mimeType = checked.mimeType

    const s3Key = `${orgId}/contracts/${Date.now()}-${filename.replace(/[^\w.\-]+/g, '_')}`
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Body: file, ContentType: mimeType }))
    const version = await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: 1, htmlContent: '', plainText: '', s3Key, mimeType, fileSize: file.byteLength, createdById: userId },
      select: { id: true },
    })
    // Only a contract still without its document takes this one (two uploads at once: the first).
    const claimed = await prisma.contract.updateMany({ where: { id, orgId, currentVersionId: null }, data: { currentVersionId: version.id, analysisStatus: 'PENDING' } })
    if (!claimed.count) {
      await prisma.contractVersion.delete({ where: { id: version.id } }).catch(() => {})
      return reply.status(409).send({ detail: 'This contract isn’t waiting for an imported document.' })
    }
    // Read like any upload: the analysis leaves the imported values alone and suggests where it reads otherwise.
    queueParseDocument({ contractId: id, versionId: version.id, s3Key, mimeType, orgId, filename })
    await createAuditEvent({
      orgId, userId, action: AuditAction.CONTRACT_UPLOADED, resourceType: 'contract', resourceId: id,
      metadata: { source: 'import', filename, mimeType, fileSize: file.byteLength }, ipAddress: req.ip,
    })
    return reply.status(201).send({ contractId: id, versionId: version.id })
  })
}
