import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
// @ts-ignore — no type definitions for node-htmldiff
import htmldiff from 'node-htmldiff'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { renderHtmlToPdfAndStore } from '../lib/gotenberg.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { extractObligationsForContract } from '../lib/obligation-extract.js'
import { generateRedlineDocx } from '../lib/docx-export.js'
import { resolveRevisionAuthors } from '../lib/revision-author.js'
import { runComplianceCheck, COMPLIANCE_FRAMEWORKS } from '../lib/compliance-check.js'
import { generateCompliancePackage } from '../lib/compliance-export.js'
import { buildCsv, parseCsv } from '../lib/csv.js'
import { fireWebhook } from '../lib/webhook-events.js'
import { applyPiiPolicy } from '../lib/pii-policy.js'
import { assertCostCapNotExceeded, recordCost, estimateCostUsd, CostCapExceededError, recordUsage } from '../lib/costCap.js'
import { indexContract, deleteContractFromIndex } from '../lib/elasticsearch.js'
import { proposeClauseAlternatives } from '../lib/clause-propose.js'
import { applyClauseProposal } from '../lib/clause-apply.js'
import { storeClauseSegments, searchClauses } from '../lib/embeddings.js'
import { queueParseDocument, queueClassifyDocument, queueExtractAi, queueChunkAndIndex, queueSplitBinder, queueEmbedContract, queueRedlineAnalysis, queueApprovalSummary, queueNotification, queueDraftContract, queuePlaybookRedline } from '../lib/queue.js'
import { applyClauseBatch } from '../lib/clause-apply.js'
import { checkAutoApprove, resolveApprovers, type WorkflowStepDef } from '../lib/workflow-engine.js'
import {
  CreateContractSchema,
  UpdateContractSchema,
  ContractFilterSchema,
  AuditAction,
} from '@clm/types'

export async function contractRoutes(app: FastifyInstance) {
  // ── List ────────────────────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const query = ContractFilterSchema.parse(req.query)
    const { orgId } = req.user

    // B.6.9 — when drilling from Counterparties we accept either id
    // or name; OR them so the legacy name-only contracts that
    // pre-date the counterpartyId FK still match.
    const andClauses: Array<Record<string, unknown>> = []
    if (query.counterpartyId || query.counterpartyName) {
      const or: Array<Record<string, unknown>> = []
      if (query.counterpartyId) or.push({ counterpartyId: query.counterpartyId })
      if (query.counterpartyName) or.push({ counterpartyName: query.counterpartyName })
      andClauses.push({ OR: or })
    }
    if (query.search) {
      andClauses.push({
        OR: [
          { title: { contains: query.search, mode: 'insensitive' as const } },
          { counterpartyName: { contains: query.search, mode: 'insensitive' as const } },
        ],
      })
    }

    // U12 audit (2026-04-29). Numeric metadata facets — OTD and uptime
    // SLA. We persist these as Contract.metadata.otdSlaPct /
    // .uptimeSlaPct on logistics + cloud contracts during seeding so
    // the list page can answer "OTD < 95%" without invoking the agent.
    // Prisma JSON path filters use { path: [...], gt/gte/lt/lte } —
    // works with Postgres ::jsonb columns.
    if (query.otdMax !== undefined) {
      andClauses.push({ metadata: { path: ['otdSlaPct'], lte: query.otdMax } as never })
    }
    if (query.otdMin !== undefined) {
      andClauses.push({ metadata: { path: ['otdSlaPct'], gte: query.otdMin } as never })
    }
    if (query.uptimeSlaMax !== undefined) {
      andClauses.push({ metadata: { path: ['uptimeSlaPct'], lte: query.uptimeSlaMax } as never })
    }
    if (query.uptimeSlaMin !== undefined) {
      andClauses.push({ metadata: { path: ['uptimeSlaPct'], gte: query.uptimeSlaMin } as never })
    }

    const where = {
      orgId,
      deletedAt: null,
      // P9 Step 4 — exclude diligence-room contracts from the main repo
      // (they're surfaced inside the DiligenceRoom detail page instead).
      diligenceRoomId: null,
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
      ...(query.ownerId && { ownerId: query.ownerId }),
      ...(query.expiryDateTo && {
        expiryDate: { gte: new Date(), lte: new Date(query.expiryDateTo) },
      }),
      ...(andClauses.length > 0 && { AND: andClauses }),
    }

    // Scope enforcement: restrict to own contracts for users with 'own' scope
    if (req.permissionScope === 'own') {
      (where as any).ownerId = req.user.sub
    }

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        include: {
          counterparty: { select: { id: true, name: true } },
          // B.6.8 — include the earliest version's s3Key so ContractsPage
          // can fall back to the uploaded filename when the LLM failed
          // to extract a meaningful title. We only need one version and
          // the keys are small, so overhead is trivial.
          versions: {
            take: 1,
            orderBy: { versionNumber: 'asc' },
            select: { s3Key: true },
          },
        },
        take: query.limit + 1,
        ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.contract.count({ where }),
    ])

    const hasMore = contracts.length > query.limit
    const data = hasMore ? contracts.slice(0, query.limit) : contracts
    const nextCursor = hasMore ? data[data.length - 1].id : undefined

    return reply.send({ data, cursor: nextCursor, hasMore, total })
  })

  // ── POST /bulk-import — CSV bulk import (P10D) ──────────────────────
  // Multipart upload of a CSV with these columns (header required):
  //   title (req), type, status, counterpartyName, value, currency,
  //   effectiveDate, expiryDate, jurisdiction
  // Each row creates a Contract row with ownerId = current user.
  // Returns a summary with per-row success/failure for the UI to render.
  app.post('/bulk-import', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { sub: userId, orgId } = req.user

    const parts = req.parts()
    let csv = ''
    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        csv = Buffer.concat(chunks).toString('utf-8')
        break
      }
    }
    if (!csv) return reply.status(400).send({ detail: 'No CSV uploaded' })

    // Tiny CSV parser — handles quoted fields + embedded commas/newlines.
    // Doesn't try to be fully RFC-4180 compliant; sufficient for the
    // typical "Excel save as CSV" output our customers will paste.
    const rows = parseCsv(csv)
    if (rows.length < 2) return reply.status(400).send({ detail: 'CSV must include a header row + at least one data row' })

    const headers = rows[0].map(h => h.trim().toLowerCase())
    const idx = (name: string) => headers.indexOf(name)
    const REQUIRED = ['title']
    const missing = REQUIRED.filter(r => idx(r) === -1)
    if (missing.length > 0) {
      return reply.status(400).send({ detail: `Missing required column(s): ${missing.join(', ')}` })
    }

    const ALLOWED_TYPES = new Set(['MSA', 'NDA', 'SOW', 'AMENDMENT', 'LICENSE', 'LEASE', 'EMPLOYMENT', 'VENDOR', 'CONSULTING', 'DPA', 'DISTRIBUTION', 'RESELLER', 'SETTLEMENT', 'ORDER_FORM', 'OTHER'])
    const ALLOWED_STATUS = new Set(['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED', 'PENDING_SIGNATURE', 'EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED'])

    const results: Array<{ row: number; ok: boolean; id?: string; error?: string; title?: string }> = []
    const dataRows = rows.slice(1).slice(0, 1000) // hard cap
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i]
      const rowNo = i + 2 // human-readable (1-indexed + header)
      const get = (name: string) => {
        const j = idx(name)
        return j === -1 ? '' : (r[j] ?? '').trim()
      }
      const title = get('title')
      if (!title) {
        results.push({ row: rowNo, ok: false, error: 'title is required' })
        continue
      }
      const rawType = get('type').toUpperCase() || 'OTHER'
      const type = ALLOWED_TYPES.has(rawType) ? rawType : 'OTHER'
      const rawStatus = get('status').toUpperCase() || 'DRAFT'
      const status = ALLOWED_STATUS.has(rawStatus) ? rawStatus : 'DRAFT'
      const valueStr = get('value')
      const value = valueStr && !isNaN(Number(valueStr)) ? Number(valueStr) : undefined
      const eff = get('effectivedate') || get('effective_date') || get('effective date')
      const exp = get('expirydate') || get('expiry_date') || get('expiry date')
      const safeDate = (s: string): Date | undefined => {
        if (!s) return undefined
        const d = new Date(s)
        return isNaN(d.getTime()) ? undefined : d
      }
      try {
        const cp = get('counterpartyname') || get('counterparty_name') || get('counterparty') || null
        const jur = get('jurisdiction') || null
        const created = await prisma.contract.create({
          data: {
            orgId, ownerId: userId,
            title, type, status,
            counterpartyName: cp,
            value: value as never,
            currency: (get('currency') || 'USD').toUpperCase(),
            effectiveDate: safeDate(eff),
            expiryDate:    safeDate(exp),
            jurisdiction:  jur,
            tags:          ['bulk-import'],
            // P27 audit (2026-05-02). Bulk-import has no file → no
            // parse pipeline → no worker advances analysisStatus past
            // PENDING. Same fix as POST /contracts blank-create.
            analysisStatus: 'DONE',
          },
          select: { id: true, createdAt: true, tags: true },
        })
        // P81 audit (2026-05-02). Index in ES so portfolio_search can
        // find bulk-imported rows. CSV path was previously invisible
        // to ES — a customer who migrated 5000 NDAs this way couldn't
        // find any of them via the agent.
        indexContract(created.id, {
          orgId, title, type, status,
          counterpartyName: cp ?? undefined,
          jurisdiction:     jur ?? undefined,
          plainText:        '',
          tags:             created.tags,
          createdAt:        created.createdAt.toISOString(),
          effectiveDate:    safeDate(eff)?.toISOString(),
          expiryDate:       safeDate(exp)?.toISOString(),
        }).catch(err => req.log.warn({ err }, 'ES index on bulk-import failed'))
        results.push({ row: rowNo, ok: true, id: created.id, title })
      } catch (err) {
        results.push({ row: rowNo, ok: false, error: (err as Error).message.slice(0, 200), title })
      }
    }

    const okCount = results.filter(r => r.ok).length
    return reply.send({
      total: results.length,
      created: okCount,
      failed: results.length - okCount,
      results,
    })
  })

  // ── GET /export — CSV download (P9 Step 7) ─────────────────────────
  // Mirrors the GET / filter set so users can export the same view
  // they're seeing on the Contracts page.
  app.get('/export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const format = ((req.query as { format?: string }).format ?? 'csv').toLowerCase()
    if (format !== 'csv') return reply.status(400).send({ detail: 'Only csv is supported' })
    const { orgId } = req.user
    const q = req.query as Record<string, string | undefined>

    const where: Record<string, unknown> = {
      orgId, deletedAt: null, diligenceRoomId: null,
    }
    if (q.status)         where.status = q.status
    if (q.type)            where.type = q.type
    if (q.counterpartyId)  where.counterpartyId = q.counterpartyId
    if (q.ownerId)         where.ownerId = q.ownerId
    if (q.riskBand === 'high')   where.riskScore = { gt: 0.67 }
    if (q.riskBand === 'medium') where.riskScore = { gte: 0.34, lte: 0.67 }
    if (q.riskBand === 'low')    where.riskScore = { lt: 0.34 }
    if (q.expiryDateTo) {
      where.expiryDate = { gte: new Date(), lte: new Date(q.expiryDateTo) }
    }

    const contracts = await prisma.contract.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      take: 5_000,
      select: {
        title: true, type: true, status: true, counterpartyName: true,
        value: true, currency: true,
        effectiveDate: true, expiryDate: true, jurisdiction: true,
        riskScore: true, overallConfidence: true,
        analysisStatus: true, summary: true, tags: true,
        createdAt: true, updatedAt: true,
        owner: { select: { name: true, email: true } },
      },
    })

    const headers = [
      'Title', 'Type', 'Status', 'Counterparty', 'Owner',
      'Value', 'Currency', 'Effective Date', 'Expiry Date', 'Jurisdiction',
      'Risk Score', 'Confidence', 'Tags', 'Analysis', 'Created', 'Summary',
    ]
    const rows = contracts.map(c => [
      c.title, c.type, c.status, c.counterpartyName ?? '',
      c.owner?.name ?? '',
      c.value ? Number(c.value.toString()) : '',
      c.currency ?? '',
      c.effectiveDate?.toISOString().slice(0, 10) ?? '',
      c.expiryDate?.toISOString().slice(0, 10) ?? '',
      c.jurisdiction ?? '',
      c.riskScore != null ? Math.round(c.riskScore * 100) : '',
      c.overallConfidence != null ? Math.round(c.overallConfidence * 100) : '',
      (c.tags ?? []).join('; '),
      c.analysisStatus ?? '',
      c.createdAt.toISOString().slice(0, 10),
      c.summary ?? '',
    ])

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="contracts-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(buildCsv(headers, rows))
  })

  // ── Create (manual, no file) ─────────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const body = CreateContractSchema.parse(req.body)
    const { sub: ownerId, orgId } = req.user

    // P27 audit (2026-05-02). Blank-create has no file → no parse
    // pipeline → no worker will ever advance analysisStatus past
    // PENDING. The contract page polls and sits at "Processing
    // starting…" forever. Default to DONE so the row is immediately
    // usable; uploads override this back to PENDING (see /upload).
    const contract = await prisma.contract.create({
      data: { ...body, orgId, ownerId, analysisStatus: 'DONE' } as Prisma.ContractUncheckedCreateInput,
    })

    // P81 audit (2026-05-02). Index every fresh contract into ES so
    // the agent's portfolio_search hybrid retrieval can find it.
    // Previously only the /upload + PATCH paths indexed; blank-create
    // / bulk-import / amendments / template-create all skipped ES,
    // leaving ~40% of contracts invisible to portfolio_search.
    indexContract(contract.id, {
      orgId,
      title:            contract.title,
      type:             contract.type,
      status:           contract.status,
      counterpartyName: contract.counterpartyName ?? undefined,
      jurisdiction:     contract.jurisdiction ?? undefined,
      plainText:        '',
      summary:          contract.summary ?? undefined,
      tags:             contract.tags,
      riskScore:        contract.riskScore ?? undefined,
      effectiveDate:    contract.effectiveDate?.toISOString(),
      expiryDate:       contract.expiryDate?.toISOString(),
      createdAt:        contract.createdAt.toISOString(),
      keyTerms:         contract.keyTerms as Record<string, unknown>,
      metadata:         contract.metadata as Record<string, unknown>,
    }).catch(err => app.log.warn({ err }, 'ES index on blank-create failed'))

    await createAuditEvent({
      orgId,
      userId: ownerId,
      action: AuditAction.CONTRACT_CREATED,
      resourceType: 'contract',
      resourceId: contract.id,
      ipAddress: req.ip,
    })
    fireWebhook(orgId, 'contract.created', {
      contractId: contract.id, title: contract.title, type: contract.type,
      status: contract.status, counterpartyName: contract.counterpartyName,
    })

    return reply.status(201).send(contract)
  })

  // ── Upload (multipart PDF/DOCX → S3 → extract → index) ──────────────────
  app.post('/upload', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { sub: userId, orgId } = req.user

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let mimeType = 'application/pdf'
    let filename = 'contract.pdf'
    let title = ''
    let type = 'OTHER'
    let counterpartyName = ''
    let parentContractId: string | undefined
    let relationshipType: string | undefined

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
        mimeType = part.mimetype
        filename = part.filename
      } else {
        const val = (part as any).value as string
        if (part.fieldname === 'title') title = val
        if (part.fieldname === 'type') type = val
        if (part.fieldname === 'counterpartyName') counterpartyName = val
        if (part.fieldname === 'parentContractId' && val) parentContractId = val
        if (part.fieldname === 'relationshipType' && val) relationshipType = val
      }
    }

    if (!fileBuffer) return reply.status(400).send({ detail: 'No file uploaded' })

    // Wave 1.8 — validate the upload by MAGIC BYTES, not the client-declared
    // mimetype (which is spoofable). A user could otherwise store HTML/SVG/
    // executables as a "contract" and have the download endpoint serve them
    // back with an attacker-chosen Content-Type (content-confusion / stored
    // XSS). We sniff the real type and use it; text/plain is allowed only when
    // no binary signature is present. Everything else is rejected.
    const detectBinaryType = (b: Buffer): string | null => {
      if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
      if (b.subarray(0, 4).toString('hex') === '504b0304') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // DOCX (zip)
      if (b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'application/msword' // legacy DOC (OLE)
      return null
    }
    const detected = detectBinaryType(fileBuffer)
    // Legacy .doc is detectable, but the extraction pipeline has no OLE reader
    // (lib/document.ts handles PDF/DOCX/TXT and throws on anything else).
    // Accepting it meant the upload succeeded and analysis then failed with an
    // opaque "Unsupported file type" — reject up front with a fix instead.
    if (detected === 'application/msword') {
      return reply.status(415).send({
        detail: 'Legacy .doc files are not supported. Open the file in Word, save it as .docx, and upload again.',
      })
    }
    if (detected) {
      mimeType = detected // trust the bytes, not the client
    } else if ((mimeType === 'text/plain' || mimeType === '') && fileBuffer.length > 0) {
      mimeType = 'text/plain'
    } else {
      return reply.status(415).send({
        detail: 'Unsupported or mismatched file type. Allowed: PDF, DOCX, TXT.',
      })
    }

    // Clean filename → readable title
    const cleanFilename = filename
      .replace(/\.[^.]+$/, '')
      .replace(/^\d{10,}[-_]/, '')
      .replace(/[_\s-]?[0-9a-f]{8}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{10,}/gi, '')
      .replace(/\b(EX[-_]\d+\.?\d*|8-K|10-K|10-Q|S-1|Form\s*\w+)\b/gi, '')
      .replace(/\b\d{8}\b/g, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    // Store in S3 first (needed for contract record)
    const s3Key = `${orgId}/contracts/${Date.now()}-${filename}`
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
    }))

    // Create contract + version in DB — respond immediately to FE
    // plainText/htmlContent will be populated by the parse-document worker
    const contract = await prisma.contract.create({
      data: {
        orgId,
        ownerId: userId,
        title: title || cleanFilename || filename.replace(/\.[^.]+$/, ''),
        type,
        status: 'DRAFT',
        analysisStatus: 'PENDING',  // parse worker sets ANALYZING when it starts
        counterpartyName: counterpartyName || undefined,
        parentContractId: parentContractId || undefined,
        relationshipType: relationshipType || undefined,
        versions: {
          create: {
            versionNumber: 1,
            htmlContent: '',   // populated by parse worker
            plainText:   '',   // populated by parse worker
            s3Key,
            mimeType,
            fileSize: fileBuffer.byteLength,
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

    // Queue Service 1: parse-document → will chain to extract-ai → chunk-and-index
    queueParseDocument({
      contractId: contract.id,
      versionId:  contract.versions[0].id,
      s3Key,
      mimeType,
      orgId,
      filename,
    })

    // Lightweight ES index with what we have now (will be re-indexed after parse with full text)
    indexContract(contract.id, {
      orgId,
      title: contract.title,
      type: contract.type,
      status: contract.status,
      counterpartyName: contract.counterpartyName ?? undefined,
      plainText: '',
      tags: contract.tags,
      createdAt: contract.createdAt.toISOString(),
    }).catch(err => app.log.warn({ err }, 'ES initial index failed'))

    await createAuditEvent({
      orgId,
      userId,
      action: AuditAction.CONTRACT_UPLOADED,
      resourceType: 'contract',
      resourceId: contract.id,
      metadata: { filename, mimeType, fileSize: fileBuffer.byteLength },
      ipAddress: req.ip,
    })
    fireWebhook(orgId, 'contract.uploaded', {
      contractId: contract.id, title: contract.title, filename,
      mimeType, fileSize: fileBuffer.byteLength,
    })

    return reply.status(201).send(contract)
  })

  // ── Detail ───────────────────────────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: true,
        versions: { orderBy: { versionNumber: 'desc' } },
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_VIEWED,
      resourceType: 'contract',
      resourceId: id,
    })

    return reply.send(contract)
  })

  // ── Presigned download URL ───────────────────────────────────────────────
  //
  // A.5 — serves the CANONICAL artifact for a version:
  //   - renderedPdfKey if present (Gotenberg-rendered PDF from edited HTML)
  //   - else s3Key      (original uploaded file or template-generated source)
  //
  // Callers can pass ?artifact=source to explicitly force the source file
  // (useful for diff-against-original views). Default is canonical.
  app.get('/:id/download', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { versionId, artifact = 'canonical' } = req.query as {
      versionId?: string
      artifact?: 'canonical' | 'source'
    }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    let version = versionId
      ? await prisma.contractVersion.findFirst({ where: { id: versionId, contractId: id } })
      : contract.versions[0]

    // Pick the artifact key: canonical = renderedPdfKey (if present) else s3Key.
    const canonicalKey = (v: typeof version) =>
      artifact === 'source' ? v?.s3Key : (v?.renderedPdfKey ?? v?.s3Key)

    // If the selected version has no usable key, fall back to the most recent
    // version that does.
    if (!canonicalKey(version) && !versionId) {
      version = await prisma.contractVersion.findFirst({
        where: {
          contractId: id,
          OR: artifact === 'source'
            ? [{ s3Key: { not: null } }]
            : [{ renderedPdfKey: { not: null } }, { s3Key: { not: null } }],
        },
        orderBy: { versionNumber: 'desc' },
      })
    }

    const key = canonicalKey(version)
    if (!key) return reply.status(404).send({ detail: 'No file stored for this version' })

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 3600 },
    )

    return reply.send({
      url,
      expiresIn: 3600,
      artifact: artifact === 'source' ? 'source' : (version?.renderedPdfKey ? 'rendered' : 'source'),
    })
  })

  // ── Versions ─────────────────────────────────────────────────────────────
  app.get('/:id/versions', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const versions = await prisma.contractVersion.findMany({
      where: { contractId: id },
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true, versionNumber: true, mimeType: true, fileSize: true,
        changeNote: true, changeSummary: true, createdById: true, createdAt: true,
      },
    })

    // Resolve the author for display. Without this the Compare view shows
    // "Unknown" against every version — it reads `createdByName ?? authorName`
    // and nothing emitted either. `createdById` is not always a user id
    // (`portal:<shareLinkId>`, `email:<addr>`), so this needs the same ladder
    // the DOCX export uses for w:author, and both stay consistent by sharing it.
    const authors = await resolveRevisionAuthors(versions.map(v => v.createdById))

    return reply.send({
      data: versions.map(v => ({ ...v, createdByName: authors.get(v.createdById) ?? null })),
    })
  })

  // ── Upload new version ───────────────────────────────────────────────────
  app.post('/:id/versions', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sub: userId, orgId } = req.user

    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let mimeType = 'application/pdf'
    let filename = 'contract.pdf'
    let changeNote = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
        mimeType = part.mimetype
        filename = part.filename
      } else {
        if ((part as any).fieldname === 'changeNote') changeNote = (part as any).value
      }
    }

    if (!fileBuffer) return reply.status(400).send({ detail: 'No file uploaded' })

    const s3Key = `${orgId}/contracts/${id}/${Date.now()}-${filename}`
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
    }))

    const lastVersion = await prisma.contractVersion.findFirst({
      where: { contractId: id },
      orderBy: { versionNumber: 'desc' },
    })

    const version = await prisma.contractVersion.create({
      data: {
        contractId: id,
        versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
        htmlContent: '',   // populated by parse worker
        plainText:   '',   // populated by parse worker
        s3Key,
        mimeType,
        fileSize: fileBuffer.byteLength,
        changeNote,
        createdById: userId,
      },
    })

    await prisma.contract.update({
      where: { id },
      data: { currentVersionId: version.id, updatedAt: new Date() },
    })

    // Reset analysis state and queue the full pipeline (parse → classify → extract → embed)
    await prisma.contract.update({
      where: { id },
      data: { analysisStatus: 'PENDING' },
    })

    queueParseDocument({
      contractId: id,
      versionId:  version.id,
      s3Key,
      mimeType,
      orgId,
      filename,
    })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.VERSION_CREATED,
      resourceType: 'contract',
      resourceId: id,
      metadata: { versionNumber: version.versionNumber },
    })

    return reply.status(201).send(version)
  })

  // ── Save editor HTML as a new text version (no file upload) ─────────────
  app.post('/:id/html-version', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sub: userId, orgId } = req.user
    const { htmlContent, changeNote = 'Edited in browser' } = req.body as { htmlContent: string; changeNote?: string }

    if (!htmlContent?.trim()) return reply.status(400).send({ detail: 'htmlContent is required' })

    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const lastVersion = await prisma.contractVersion.findFirst({
      where: { contractId: id },
      orderBy: { versionNumber: 'desc' },
    })

    const plainText = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

    const version = await prisma.contractVersion.create({
      data: {
        contractId: id,
        versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
        htmlContent,
        plainText,
        s3Key: null,
        mimeType: 'text/html',
        fileSize: Buffer.byteLength(htmlContent),
        changeNote,
        createdById: userId,
      },
    })

    // A.5 — render a canonical PDF from this HTML and attach it to the
    // version so approvers, signers, and counterparties see the latest
    // edits. Fire-and-forget: a slow Gotenberg call must not block the save.
    // The version exists without renderedPdfKey until Gotenberg finishes.
    void (async () => {
      try {
        const { s3Key: pdfKey } = await renderHtmlToPdfAndStore({
          html: htmlContent,
          keyPrefix: `${orgId}/contracts/${id}/rendered`,
          filename: `v${version.versionNumber}.pdf`,
        })
        await prisma.contractVersion.update({
          where: { id: version.id },
          data:  { renderedPdfKey: pdfKey, renderedAt: new Date() },
        })
        app.log.info({ contractId: id, versionId: version.id, pdfKey }, 'A.5: rendered canonical PDF')
      } catch (err) {
        app.log.warn({ err, contractId: id, versionId: version.id }, 'A.5: Gotenberg render failed — canonical will fall back to source')
      }
    })()

    await prisma.contract.update({
      where: { id },
      data: { currentVersionId: version.id, updatedAt: new Date() },
    })

    return reply.status(201).send(version)
  })

  // ── Store clause segments (called by Review Agent) ───────────────────────
  app.post('/:id/versions/:versionId/clauses', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    const { orgId } = req.user

    // Internal service calls use orgId='system'
    const contract = orgId === 'system'
      ? await prisma.contract.findFirst({ where: { id, deletedAt: null } })
      : await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const version = await prisma.contractVersion.findFirst({ where: { id: versionId, contractId: id } })
    if (!version) return reply.status(404).send({ detail: 'Version not found' })

    const { clauseSegments, clauseFlags } = req.body as {
      clauseSegments?: Array<{
        clauseType: string
        content: string
        sortOrder: number
        interpretation?: string
        riskRating?: string
        sectionRef?: string
      }>
      clauseFlags?: Record<string, boolean>
    }

    if (clauseSegments?.length) {
      await storeClauseSegments(versionId, clauseSegments)
      queueEmbedContract(versionId)
    }

    if (clauseFlags) {
      await prisma.contractVersion.update({
        where: { id: versionId },
        data: { clauseFlags },
      })
    }

    return reply.status(201).send({ stored: clauseSegments?.length ?? 0 })
  })

  // ── Alternative-language proposals for one clause ───────────────────────
  // User-facing counterpart to internal-ai's /tools/redline_propose. That route
  // sits behind the x-internal-secret hook, so the proposer could only ever be
  // reached when the chat agent chose to call it — the review drawer had no way
  // to ask for a suggestion, and showed a hardcoded placeholder instead.
  // Both paths share lib/clause-propose so they can't drift apart.
  app.post('/:id/clauses/:clauseId/suggest', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, clauseId } = req.params as { id: string; clauseId: string }
    const { orgId } = req.user
    const { instructions } = (req.body ?? {}) as { instructions?: string }

    const result = await proposeClauseAlternatives({ contractId: id, orgId, clauseId, instructions })
    if (!result.ok) {
      return reply.status(result.status).send({ detail: result.detail, upstream: result.upstream })
    }
    return reply.send(result.data)
  })

  // ── Apply proposed language to one clause ───────────────────────────────
  // User-facing counterpart to internal-ai's /tools/redline_apply. That route is
  // internal-only AND the UI path to it went through the agent thread, which
  // hard-fails without an existing conversation — so a reviewer looking at
  // proposed language had no way to apply it. Shares lib/clause-apply.
  app.post('/:id/clauses/:clauseId/apply', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, clauseId } = req.params as { id: string; clauseId: string }
    const { orgId, sub: userId } = req.user
    const body = (req.body ?? {}) as {
      proposedText?:        string
      aggression?:          string
      rationale?:           string
      changes?:             Array<{ before: string; after: string; reason?: string }>
      allowAppendFallback?: boolean
    }
    // This writes into the contract body, so validate rather than trust the
    // cast. Bounds mirror RedlineApplySchema on the internal route — both paths
    // reach the same splice, so they must not accept different things.
    const rawText = typeof body.proposedText === 'string' ? body.proposedText : ''
    if (!rawText.trim()) {
      return reply.status(400).send({ detail: 'proposedText is required' })
    }
    if (rawText.length > 20_000) {
      return reply.status(400).send({ detail: 'proposedText exceeds the 20,000 character limit' })
    }
    // Emptiness is judged on the trimmed value, but the UNTRIMMED string is
    // spliced — the internal route splices verbatim, and trimming here would
    // make the two paths write different bytes for the same input.
    const proposedText = rawText

    const AGGRESSION = ['least', 'moderate', 'aggressive']
    if (body.aggression !== undefined && !AGGRESSION.includes(body.aggression)) {
      return reply.status(400).send({ detail: `aggression must be one of: ${AGGRESSION.join(', ')}` })
    }
    if (typeof body.rationale === 'string' && body.rationale.length > 2_000) {
      return reply.status(400).send({ detail: 'rationale exceeds the 2,000 character limit' })
    }
    // aggression and rationale both land in changeNote and metadata, so cap
    // them here rather than letting unbounded text into the version record.
    const changes = Array.isArray(body.changes)
      ? body.changes.slice(0, 40).map(c => ({
          before: String(c?.before ?? '').slice(0, 5_000),
          after:  String(c?.after  ?? '').slice(0, 5_000),
          reason: c?.reason ? String(c.reason).slice(0, 500) : undefined,
        }))
      : undefined

    const result = await applyClauseProposal({
      orgId, userId, contractId: id, clauseId,
      proposedText,
      aggression: body.aggression,
      rationale:  body.rationale,
      changes,
      allowAppendFallback: body.allowAppendFallback === true,
    })
    // Forward the machine-readable code so the client can tell "the clause
    // moved, offer to append" apart from a generic failure.
    if (!result.ok) {
      return reply.status(result.status).send({ detail: result.detail, code: result.code })
    }

    // Best-effort: the version is already written and currentVersionId flipped,
    // so a failed audit write must not turn a successful apply into a 500.
    createAuditEvent({
      orgId, userId,
      action:       AuditAction.VERSION_CREATED,
      resourceType: 'contract',
      resourceId:   id,
      metadata: {
        via: 'clause_apply', clauseId,
        newVersionNumber: result.data.newVersionNumber,
        spliced: result.data.spliced,
      },
    }).catch(() => {})

    return reply.send(result.data)
  })

  // ── List clauses for current version ────────────────────────────────────
  app.get('/:id/clauses', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { currentVersionId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    // B.5.6 — fall back to the latest *extracted* version if the current
    // version has no clauses yet (happens when a user saves a new version
    // from the editor before re-analysis runs). Otherwise the rail/drawer
    // look empty until extraction catches up.
    let versionId = contract.currentVersionId
    if (versionId) {
      const count = await prisma.contractClause.count({ where: { versionId, isSubChunk: false } })
      if (count === 0) {
        const fallback = await prisma.contractVersion.findFirst({
          where: {
            contractId: id,
            clauses: { some: { isSubChunk: false } },
          },
          orderBy: { versionNumber: 'desc' },
          select: { id: true },
        })
        if (fallback) versionId = fallback.id
      }
    }
    if (!versionId) return reply.send({ data: [] })

    const clauses = await prisma.contractClause.findMany({
      where: { versionId, isSubChunk: false },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, clauseType: true, content: true,
        interpretation: true, riskRating: true, sectionRef: true,
        sortOrder: true,
        reviewState: true, reviewedAt: true, reviewedById: true,
      },
    })

    return reply.send({ data: clauses })
  })

  // ── B.5.7 — per-clause review state ────────────────────────────────────
  // Drives the Focused Review drawer's Accept / Reject / Mark-Reviewed
  // actions and the "N of M reviewed" progress counter in the rail.
  app.patch('/clauses/:clauseId/review-state', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { clauseId } = req.params as { clauseId: string }
    const { sub: userId, orgId } = req.user
    const body = req.body as { state?: string }
    const state = body.state
    if (state !== 'unreviewed' && state !== 'reviewed' && state !== 'resolved') {
      return reply.status(400).send({ detail: 'state must be unreviewed | reviewed | resolved' })
    }

    // Scope check: ensure the clause belongs to a contract in this org.
    const clause = await prisma.contractClause.findUnique({
      where: { id: clauseId },
      select: { version: { select: { contract: { select: { orgId: true, id: true } } } } },
    })
    if (!clause || clause.version.contract.orgId !== orgId) {
      return reply.status(404).send({ detail: 'Clause not found' })
    }

    const updated = await prisma.contractClause.update({
      where: { id: clauseId },
      data: {
        reviewState: state,
        reviewedAt: state === 'unreviewed' ? null : new Date(),
        reviewedById: state === 'unreviewed' ? null : userId,
      },
      select: { id: true, reviewState: true, reviewedAt: true, reviewedById: true },
    })

    return reply.send(updated)
  })

  // ── Activity timeline ────────────────────────────────────────────────────
  app.get('/:id/timeline', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const events = await prisma.auditEvent.findMany({
      where: { orgId, resourceType: 'contract', resourceId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return reply.send({ data: events })
  })

  // ── Update metadata ──────────────────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = UpdateContractSchema.parse(req.body)

    // Internal service calls use orgId='system' — find by id only
    const where = orgId === 'system'
      ? { id, deletedAt: null }
      : { id, orgId, deletedAt: null }

    const existing = await prisma.contract.findFirst({ where })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    // Validate status transitions
    if (body.status && body.status !== existing.status) {
      const VALID_TRANSITIONS: Record<string, string[]> = {
        DRAFT:              ['PENDING_REVIEW', 'PENDING_APPROVAL'],
        PENDING_REVIEW:     ['DRAFT', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL'],
        UNDER_NEGOTIATION:  ['PENDING_REVIEW', 'PENDING_APPROVAL'],
        PENDING_APPROVAL:   ['APPROVED', 'REJECTED'],
        APPROVED:           ['EXECUTED', 'PENDING_SIGNATURE'],
        EXECUTED:           ['ARCHIVED'],
        EXPIRED:            ['ARCHIVED'],
        REJECTED:           ['DRAFT'],
      }
      const allowed = VALID_TRANSITIONS[existing.status] ?? []
      if (!allowed.includes(body.status)) {
        return reply.status(409).send({
          detail: `Cannot transition from ${existing.status} to ${body.status}`,
        })
      }
    }

    // Use the contract's real orgId (internal calls come in with orgId='system')
    const effectiveOrgId = existing.orgId

    const updated = await prisma.contract.update({ where: { id }, data: body as Prisma.ContractUncheckedUpdateInput })

    // Re-index if searchable fields changed. indexContract is a full-document
    // overwrite (elasticsearch.ts), so we must carry the existing full text and
    // the other searchable fields through — otherwise a metadata-only PATCH
    // (e.g. a title edit) would wipe plainText and blank the BM25 body. (Wave 3.1)
    if (body.title || body.status || body.counterpartyName || body.tags) {
      const currentVersion = existing.currentVersionId
        ? await prisma.contractVersion.findUnique({
            where: { id: existing.currentVersionId },
            select: { plainText: true },
          })
        : null
      indexContract(id, {
        orgId: effectiveOrgId,
        title: updated.title,
        type: updated.type,
        status: updated.status,
        counterpartyName: updated.counterpartyName ?? undefined,
        jurisdiction: updated.jurisdiction ?? undefined,
        plainText: currentVersion?.plainText ?? '',
        summary: updated.summary ?? undefined,
        tags: updated.tags,
        riskScore: updated.riskScore ?? undefined,
        effectiveDate: updated.effectiveDate?.toISOString(),
        expiryDate: updated.expiryDate?.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        keyTerms: updated.keyTerms as Record<string, unknown>,
        metadata: updated.metadata as Record<string, unknown>,
      }).catch(() => {})
    }

    await createAuditEvent({
      orgId: effectiveOrgId,
      userId: userId === 'system' ? undefined : userId,
      action: body.status && body.status !== existing.status
        ? AuditAction.CONTRACT_STATUS_CHANGED
        : AuditAction.CONTRACT_UPDATED,
      resourceType: 'contract',
      resourceId: id,
      metadata: body.status && body.status !== existing.status
        ? { from: existing.status, to: body.status }
        : { changes: Object.keys(body) },
    })

    return reply.send(updated)
  })

  // ── Re-trigger AI analysis ───────────────────────────────────────────────
  app.post('/:id/analyze', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const version = contract.versions[0]

    // If no version exists, re-queue draft agent (using stored context or contract fields as fallback)
    if (!version) {
      const { sub: userId } = req.user
      const meta = (contract.metadata ?? {}) as Record<string, unknown>
      const draftCtx = meta._draftContext as Record<string, unknown> | undefined

      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'DRAFTING', analysisError: null },
      })
      queueDraftContract({
        contractId:        id,
        orgId,
        userId,
        requestTitle:      (draftCtx?.requestTitle as string) ?? contract.title,
        requestDescription: (draftCtx?.requestDescription as string) ?? contract.title,
        contractType:      (draftCtx?.contractType as string) ?? contract.type,
        counterpartyName:  (draftCtx?.counterpartyName as string) ?? contract.counterpartyName ?? undefined,
        estimatedValue:    (draftCtx?.estimatedValue as number) ?? (contract.value != null ? Number(contract.value) : undefined),
      })
      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'DRAFTING', mode: 'draft' })
    }

    const { full } = req.query as { full?: string }

    if ((full === 'true' || !version.plainText) && version.s3Key) {
      // Full reprocess — re-parse from S3 and run the entire pipeline

      // Derive filename from mimeType (extractDocument uses it for format routing)
      const filename = version.mimeType === 'application/pdf' ? 'contract.pdf'
        : version.mimeType?.includes('wordprocessingml') ? 'contract.docx'
        : 'contract.txt'

      // Reset AI metadata so the UI shows fresh in-progress state.
      // Do NOT clear plainText/htmlContent — stale queued jobs read from the DB
      // and would fail with "No plainText" if we clear it before parse finishes.
      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'PENDING', keyTerms: {}, riskScore: null, summary: null, fieldConfidence: {} },
      })

      queueParseDocument({
        contractId: id,
        versionId:  version.id,
        s3Key:      version.s3Key,
        mimeType:   version.mimeType ?? 'application/pdf',
        orgId,
        filename,
      })

      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'PENDING', mode: 'full' })

    } else {
      // Smart resume — re-classify + re-extract (keeps parsed text, re-runs AI from scratch)
      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'CLASSIFYING' },
      })

      queueClassifyDocument({ contractId: id, versionId: version.id, orgId })

      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'CLASSIFYING', mode: 'smart' })
    }
  })

  // ── Cancel analysis (reset stuck in-progress status to FAILED) ───────────
  app.post('/:id/cancel-analysis', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    await prisma.contract.update({
      where: { id },
      data: { analysisStatus: 'FAILED', analysisError: 'Analysis cancelled by user.' },
    })

    return reply.send({ status: 'cancelled', contractId: id, analysisStatus: 'FAILED' })
  })

  // ── Retype (correct contract type → re-extract with corrected type context) ──
  app.post('/:id/retype', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { contractType } = req.body as { contractType: string }

    if (!contractType) return reply.status(400).send({ detail: 'contractType is required' })

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    if (!contract.versions[0]?.plainText) {
      return reply.status(422).send({ detail: 'No extracted text available.' })
    }

    // Update type immediately so UI shows it
    await prisma.contract.update({
      where: { id },
      data: { type: contractType, analysisStatus: 'ANALYZING' },
    })

    queueExtractAi({
      contractId: id,
      versionId:  contract.versions[0].id,
      orgId,
      contractType,
      triggeredBy: 'retype',
    })

    return reply.send({ status: 'queued', contractId: id, contractType, analysisStatus: 'ANALYZING' })
  })

  // ── Internal: trigger chunk-and-index (called by agents after clauses stored) ─
  app.post('/:id/versions/:versionId/chunk', async (req, reply) => {
    // Internal-only — validated via x-internal-secret header
    const secret = req.headers['x-internal-secret']
    if (secret !== process.env.INTERNAL_SERVICE_SECRET) {
      return reply.status(401).send({ detail: 'Unauthorized' })
    }
    const { id, versionId } = req.params as { id: string; versionId: string }

    const contract = await prisma.contract.findFirst({ where: { id, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    queueChunkAndIndex({ contractId: id, versionId, orgId: contract.orgId })

    return reply.status(202).send({ status: 'queued' })
  })

  // ── Contract Q&A (RAG) ───────────────────────────────────────────────────
  app.post('/:id/ask', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { question, limit = 8 } = req.body as { question: string; limit?: number }

    if (!question?.trim()) return reply.status(400).send({ detail: 'question is required' })

    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const clauseMatches = await searchClauses(question, orgId, limit, id)

    if (!clauseMatches.length) {
      return reply.send({ answer: null, sources: [], message: 'No relevant clauses found — try re-uploading to extract text' })
    }

    const agentRes = await fetch(
      `${process.env.AGENTS_URL ?? 'http://localhost:8000'}/agent/ask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, orgId, contractId: id, clauseMatches }),
      },
    ).catch(() => null)

    if (!agentRes?.ok) {
      return reply.send({ answer: null, sources: clauseMatches, message: 'Agent unavailable — showing relevant clauses' })
    }

    const agentData = await agentRes.json()
    return reply.send({ ...agentData, sources: clauseMatches })
  })

  // ── Precedent contracts (B.5.11) ─────────────────────────────────────────
  //
  // "Show me similar signed contracts so I can sanity-check this one."
  // Approvers (docs/26 §6.6) don't trust AI blindly — they trust past
  // decisions. We compute contract-level similarity as the average of
  // clause embeddings (pgvector AVG() on vector columns) and return the
  // top-3 signed peers of the same contract type, plus a "how does our
  // risk compare" signal.
  //
  // Performance: for a few dozen contracts this is a single query; if we
  // ever have thousands, we'll materialize the roll-up into a column.
  // Not worth the extra write-path complexity at V1 scale.
  app.get('/:id/precedents', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, type: true, riskScore: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    // Query-contract avg embedding (from all clauses across all its versions).
    const selfAvg = await prisma.$queryRaw<Array<{ avg_vec: string | null }>>`
      SELECT AVG(cc.embedding)::text AS avg_vec
      FROM   contract_clauses cc
      JOIN   contract_versions cv ON cv.id = cc."versionId"
      WHERE  cv."contractId" = ${id}
             AND cc.embedding IS NOT NULL
             AND cc."isSubChunk" = FALSE
    `

    const avgVecText = selfAvg[0]?.avg_vec
    if (!avgVecText) {
      return reply.send({
        data:               [],
        message:            'No embeddings yet for this contract — precedents unavailable',
        selfRiskScore:      contract.riskScore,
        peerAvgRiskScore:   null,
        riskDeltaLabel:     null,
      })
    }

    // Top-3 signed peers of the same type by cosine similarity on avg
    // clause embedding. Excludes this contract and unsigned drafts.
    const peers = await prisma.$queryRaw<Array<{
      contract_id:   string
      title:         string
      contract_type: string
      value:         number | null
      counterparty:  string | null
      signed_at:     Date | null
      risk_score:    number | null
      similarity:    number
    }>>`
      WITH peer_avg AS (
        SELECT c.id            AS contract_id,
               c.title,
               c.type          AS contract_type,
               c.value,
               c."counterpartyName" AS counterparty,
               c."updatedAt"   AS signed_at,
               c."riskScore"   AS risk_score,
               AVG(cc.embedding) AS avg_embedding
        FROM   contracts c
        JOIN   contract_versions cv ON cv."contractId" = c.id
        JOIN   contract_clauses cc  ON cc."versionId"  = cv.id
        WHERE  c."orgId"       = ${orgId}
               AND c.id        <> ${id}
               AND c."deletedAt" IS NULL
               AND c.status IN ('APPROVED','EXECUTED')
               AND c.type      = ${contract.type}
               AND cc.embedding IS NOT NULL
               AND cc."isSubChunk" = FALSE
        GROUP  BY c.id, c.title, c.type, c.value, c."counterpartyName", c."updatedAt", c."riskScore"
      )
      SELECT contract_id, title, contract_type, value, counterparty,
             signed_at, risk_score,
             1 - (avg_embedding <=> ${avgVecText}::vector) AS similarity
      FROM   peer_avg
      ORDER  BY avg_embedding <=> ${avgVecText}::vector
      LIMIT  3
    `

    const peerRiskScores = peers.map(p => p.risk_score).filter((x): x is number => x != null)
    const peerAvgRiskScore = peerRiskScores.length
      ? peerRiskScores.reduce((a, b) => a + b, 0) / peerRiskScores.length
      : null

    // "20% higher risk than peer avg" label
    let riskDeltaLabel: string | null = null
    if (contract.riskScore != null && peerAvgRiskScore != null) {
      const diff = contract.riskScore - peerAvgRiskScore
      const pct = Math.round((Math.abs(diff) / Math.max(0.01, peerAvgRiskScore)) * 100)
      if (pct >= 10) {
        riskDeltaLabel = diff > 0
          ? `${pct}% higher risk than peer avg`
          : `${pct}% lower risk than peer avg`
      } else {
        riskDeltaLabel = 'In line with peer avg'
      }
    }

    return reply.send({
      data: peers.map(p => ({
        contractId:   p.contract_id,
        title:        p.title,
        type:         p.contract_type,
        value:        p.value,
        counterparty: p.counterparty,
        signedAt:     p.signed_at,
        riskScore:    p.risk_score,
        similarity:   Number(p.similarity),
      })),
      selfRiskScore:    contract.riskScore,
      peerAvgRiskScore,
      riskDeltaLabel,
    })
  })

  // ── Soft delete ──────────────────────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('delete', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    const existing = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    await prisma.contract.update({ where: { id }, data: { deletedAt: new Date() } })
    deleteContractFromIndex(id).catch(() => {})

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_DELETED,
      resourceType: 'contract',
      resourceId: id,
    })

    return reply.status(204).send()
  })

  // ── Contract Family ────────────────────────────────────────────────────────
  app.get('/:id/family', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true,
        parentContractId: true,
        relationshipType: true,
        parentContract: {
          select: { id: true, title: true, type: true, status: true, relationshipType: true },
        },
        amendments: {
          where: { deletedAt: null },
          select: { id: true, title: true, type: true, status: true, relationshipType: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    // Siblings: other children of the same parent (excluding this contract)
    const siblings = contract.parentContractId
      ? await prisma.contract.findMany({
          where: {
            parentContractId: contract.parentContractId,
            id: { not: id },
            orgId,
            deletedAt: null,
          },
          select: { id: true, title: true, type: true, status: true, relationshipType: true },
        })
      : []

    return reply.send({
      parent:   contract.parentContract ?? null,
      children: contract.amendments,
      siblings,
    })
  })

  // ── GET /:id/compliance-export (P9 Step 6) ──────────────────────────────
  // Bundles the contract's full lifecycle into one auditor-ready PDF:
  // cover page, signers + signature timestamps, audit trail, signed PDF.
  app.get('/:id/compliance-export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    try {
      const bytes = await generateCompliancePackage({ contractId: id, orgId })
      const safeTitle = (await prisma.contract.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { title: true },
      }))?.title?.replace(/[^\w.\-]+/g, '_').slice(0, 100) ?? 'compliance'
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="compliance-${safeTitle}-${new Date().toISOString().slice(0, 10)}.pdf"`)
        .send(Buffer.from(bytes))
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'contract_not_found') {
        return reply.status(404).send({ detail: 'Contract not found' })
      }
      req.log.error({ err }, '[compliance-export] failed')
      return reply.status(500).send({ detail: 'Compliance export failed', error: msg.slice(0, 200) })
    }
  })

  // ── POST /:id/amendments (P8 Step 8) ─────────────────────────────────────
  // Create an amendment / SOW / order-form / renewal as a *new* draft
  // contract that links back to this one as its parent. Pulls forward the
  // parent's counterparty and (if not overridden) type to save typing.
  // The amendment lands in DRAFT status so the user can edit / draft via
  // the agent / upload a file before signing.
  app.post('/:id/amendments', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { sub: userId, orgId } = req.user
    const body = (req.body ?? {}) as {
      title?:            string
      relationshipType?: string
      type?:             string
      description?:      string
      effectiveDate?:    string
      expiryDate?:       string
      value?:            number | string
      currency?:         string
    }

    const parent = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true, title: true, type: true, status: true,
        counterpartyId: true, counterpartyName: true,
        currency: true, matterId: true,
      },
    })
    if (!parent) return reply.status(404).send({ detail: 'Parent contract not found' })

    const relationshipType = (body.relationshipType ?? 'amendment').toLowerCase()
    const ALLOWED = ['amendment', 'sow', 'order_form', 'renewal', 'exhibit_only']
    if (!ALLOWED.includes(relationshipType)) {
      return reply.status(400).send({ detail: `relationshipType must be one of ${ALLOWED.join(', ')}` })
    }

    const title = (body.title?.trim()) || `${parent.title} — ${relationshipType.replace(/_/g, ' ')}`
    // Default type by relationship: amendments inherit parent type;
    // SOWs/order-forms get their own type so users can set it later.
    const type = body.type ?? (relationshipType === 'amendment' ? parent.type : 'OTHER')

    const value = body.value != null && body.value !== ''
      ? Number(body.value)
      : null

    // Production audit fix (2026-04-30): without an explicit analysisStatus
    // the row defaulted to PENDING, which the UI interprets as "the parse
    // worker is about to pick this up" — but no worker is enqueued for an
    // amendment (no file uploaded, no template materialised). Result: the
    // contract page sat at "Processing starting…" forever. An empty
    // amendment draft has nothing to analyse, so mark it DONE up-front;
    // the user's upload / paste flow will re-queue parse if/when a real
    // document attaches. We also create an empty initial ContractVersion
    // so the editor + risks panels have a row to write into.
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    const created = await prisma.contract.create({
      data: {
        orgId, ownerId: userId,
        title,
        type,
        status: 'DRAFT',
        analysisStatus: 'DONE',
        parentContractId: parent.id,
        relationshipType,
        counterpartyId:   parent.counterpartyId,
        counterpartyName: parent.counterpartyName,
        currency:         body.currency ?? parent.currency ?? 'USD',
        value:            value != null && !isNaN(value) ? value : null,
        effectiveDate:    body.effectiveDate ? new Date(body.effectiveDate) : undefined,
        expiryDate:       body.expiryDate ? new Date(body.expiryDate) : undefined,
        matterId:         parent.matterId ?? undefined,
        metadata:         body.description ? { amendmentDescription: body.description } : {},
        versions: {
          create: {
            versionNumber: 1,
            htmlContent:   body.description
              ? `<p>${escapeHtml(body.description)}</p>`
              : '<p></p>',
            plainText:     body.description ?? '',
            changeNote:    `Initial ${relationshipType} draft`,
            createdById:   userId,
          },
        },
      },
      include: { versions: true },
    })
    // Set currentVersionId now that the version row has an id.
    if (created.versions[0]) {
      await prisma.contract.update({
        where: { id: created.id },
        data:  { currentVersionId: created.versions[0].id },
      })
    }

    // P81 audit (2026-05-02). Index amendments in ES so they
    // surface in portfolio_search when users ask about the changed
    // contract family. Was previously skipped — every "find me the
    // amendment that adjusted SLAs" query missed.
    indexContract(created.id, {
      orgId,
      title:            created.title,
      type:             created.type,
      status:           created.status,
      counterpartyName: created.counterpartyName ?? undefined,
      plainText:        body.description ?? '',
      tags:             [],
      createdAt:        created.createdAt.toISOString(),
      effectiveDate:    created.effectiveDate?.toISOString(),
      expiryDate:       created.expiryDate?.toISOString(),
    }).catch(err => app.log.warn({ err }, 'ES index on amendment failed'))

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_CREATED,
      resourceType: 'contract', resourceId: created.id,
      metadata: { relationshipType, parentContractId: parent.id, source: 'amendment_flow' },
      ipAddress: req.ip,
    })

    return reply.status(201).send({
      id:               created.id,
      title:            created.title,
      type:             created.type,
      status:           created.status,
      parentContractId: parent.id,
      relationshipType,
    })
  })

  // ── Attach exhibit / schedule (non-AI) ─────────────────────────────────────
  app.post('/:id/attach', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    const existing = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, attachments: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let mimeType = 'application/pdf'
    let filename = 'attachment.pdf'
    let label = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
        mimeType = part.mimetype
        filename = part.filename
      } else {
        const val = (part as any).value as string
        if (part.fieldname === 'label') label = val
      }
    }

    if (!fileBuffer) return reply.status(400).send({ detail: 'No file uploaded' })

    const s3Key = `${orgId}/contracts/${id}/attachments/${Date.now()}-${filename}`
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
    }))

    const current = (existing.attachments as any[]) ?? []
    const updated = [
      ...current,
      { filename, s3Key, mimeType, size: fileBuffer.byteLength, label: label || filename },
    ]

    await prisma.contract.update({
      where: { id },
      data: { attachments: updated },
    })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_UPDATED,
      resourceType: 'contract',
      resourceId: id,
      metadata: { action: 'attach', filename, mimeType, size: fileBuffer.byteLength },
      ipAddress: req.ip,
    })

    return reply.send({ attachments: updated })
  })

  // ── Delete attachment by index ─────────────────────────────────────────────
  app.delete('/:id/attachments/:index', { preHandler: requirePermission('delete', 'contract') }, async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string }
    const { orgId } = req.user
    const idx = parseInt(index, 10)

    const existing = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, attachments: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    const current = (existing.attachments as any[]) ?? []
    if (idx < 0 || idx >= current.length) {
      return reply.status(400).send({ detail: 'Attachment index out of range' })
    }

    const updated = current.filter((_, i) => i !== idx)
    await prisma.contract.update({ where: { id }, data: { attachments: updated } })

    return reply.send({ attachments: updated })
  })

  // ── Download attachment ────────────────────────────────────────────────────
  app.get('/:id/attachments/:index/download', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string }
    const { orgId } = req.user
    const idx = parseInt(index, 10)

    const existing = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { attachments: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    const current = (existing.attachments as any[]) ?? []
    const attachment = current[idx]
    if (!attachment) return reply.status(404).send({ detail: 'Attachment not found' })

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: attachment.s3Key,
        ResponseContentDisposition: `attachment; filename="${attachment.filename}"`,
      }),
      { expiresIn: 300 },
    )

    return reply.send({ url, filename: attachment.filename })
  })

  // ── Binder split ──────────────────────────────────────────────────────────
  // POST /:id/split — queue a split-binder job; returns 202 immediately
  app.post('/:id/split', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const { splits } = req.body as {
      splits: Array<{ pageStart: number; pageEnd: number; title?: string; type?: string }>
    }

    if (!splits || splits.length < 2) {
      return reply.status(400).send({ detail: 'Need at least 2 splits' })
    }

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    // Queue the split job — worker handles S3 download, slicing, child creation
    queueSplitBinder({ contractId: id, orgId, userId, splits })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_UPDATED,
      resourceType: 'contract',
      resourceId: id,
      metadata: { action: 'binder_split_queued', splitCount: splits.length },
      ipAddress: req.ip,
    })

    return reply.status(202).send({ queued: true })
  })

  // ── Export (PDF / DOCX via Gotenberg) ───────────────────────────────────
  app.post('/export', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { html, format = 'pdf', filename = 'contract' } = req.body as {
      html: string
      format?: 'pdf' | 'docx'
      filename?: string
    }

    if (!html?.trim()) {
      return reply.status(400).send({ detail: 'html is required' })
    }

    const GOTENBERG_URL = process.env.GOTENBERG_URL ?? 'http://localhost:3001'

    if (format === 'pdf') {
      // Wrap bare HTML in a minimal document if needed
      const fullHtml = html.trimStart().startsWith('<!DOCTYPE') ? html : `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; font-size: 12pt; line-height: 1.6; margin: 2.5cm; color: #1a1a1a; }
  h1 { font-size: 18pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; }
</style>
</head><body>${html}</body></html>`

      const formData = new FormData()
      formData.append('files', new Blob([fullHtml], { type: 'text/html' }), 'index.html')

      const upstream = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
        method: 'POST',
        body: formData,
      }).catch(() => null)

      if (!upstream?.ok) {
        const errText = upstream ? await upstream.text() : 'Gotenberg unavailable'
        app.log.error({ errText }, 'Gotenberg PDF conversion failed')
        return reply.status(502).send({ detail: 'PDF generation failed' })
      }

      const pdfBuffer = Buffer.from(await upstream.arrayBuffer())
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="${filename}.pdf"`)
      return reply.send(pdfBuffer)
    }

    if (format === 'docx') {
      // Gotenberg LibreOffice route: convert HTML → DOCX
      const formData = new FormData()
      formData.append('files', new Blob([html], { type: 'text/html' }), 'index.html')

      const upstream = await fetch(`${GOTENBERG_URL}/forms/libreoffice/convert`, {
        method: 'POST',
        body: formData,
      }).catch(() => null)

      if (!upstream?.ok) {
        const errText = upstream ? await upstream.text() : 'Gotenberg unavailable'
        app.log.error({ errText }, 'Gotenberg DOCX conversion failed')
        return reply.status(502).send({ detail: 'DOCX generation failed' })
      }

      const docxBuffer = Buffer.from(await upstream.arrayBuffer())
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      reply.header('Content-Disposition', `attachment; filename="${filename}.docx"`)
      return reply.send(docxBuffer)
    }

    return reply.status(400).send({ detail: 'format must be pdf or docx' })
  })


  // ── Version diff ───────────────────────────────────────────────────────────
  app.get('/:id/versions/:v1Id/diff/:v2Id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId, v1Id, v2Id } = req.params as { id: string; v1Id: string; v2Id: string }

    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    // Confirm both versions belong to THIS contract before touching the cache.
    // VersionDiffCache is keyed on [v1Id, v2Id] with no contract component, so
    // serving a cache hit first let a caller pass their own contractId together
    // with two version ids from another org's contract and read back that org's
    // rendered diff HTML.
    const [v1, v2] = await Promise.all([
      prisma.contractVersion.findFirst({ where: { id: v1Id, contractId } }),
      prisma.contractVersion.findFirst({ where: { id: v2Id, contractId } }),
    ])
    if (!v1 || !v2) return reply.status(404).send({ error: 'Version not found' })

    const cached = await prisma.versionDiffCache.findUnique({ where: { v1Id_v2Id: { v1Id, v2Id } } })
    if (cached) return reply.send({ diffHtml: cached.diffHtml, stats: cached.stats, v1Id, v2Id })

    // A version whose text has not been extracted yet (freshly uploaded, or a
    // counterparty turn still moving through the parse pipeline) has
    // htmlContent ''. Diffing against '' renders the entire other version as
    // one giant deletion — worthless — and it then got written into the cache
    // below, which nothing evicts, so the garbage was served permanently.
    // Refuse instead; the caller can retry once extraction lands.
    const pendingVersionIds = [
      ...(v1.htmlContent?.trim() ? [] : [v1Id]),
      ...(v2.htmlContent?.trim() ? [] : [v2Id]),
    ]
    if (pendingVersionIds.length > 0) {
      return reply.status(409).send({
        error:  'Version still processing',
        detail: 'This version is still being extracted. The comparison will be available once processing finishes.',
        pendingVersionIds,
      })
    }

    const diffHtml: string = htmldiff(v1.htmlContent, v2.htmlContent)

    // Count insertions / deletions from <ins> and <del> tags
    const insertions = (diffHtml.match(/<ins[\s>]/g) ?? []).length
    const deletions  = (diffHtml.match(/<del[\s>]/g) ?? []).length
    const stats = { insertions, deletions }

    await prisma.versionDiffCache.create({ data: { contractId, v1Id, v2Id, diffHtml, stats } })

    return reply.send({ diffHtml, stats, v1Id, v2Id })
  })


  // ── GET /:id/versions/:v1Id/redline-docx/:v2Id (Phase 4) ──────────────────
  // A Word document with native tracked changes between two versions, so the
  // markup can be reviewed with Word's own Accept/Reject and sent on to the
  // counterparty.
  //
  // 'view' rather than 'export': PermissionAction.EXPORT exists but no route
  // in this codebase enforces it, so using it here would narrow access for
  // view-but-not-export roles and require a system-role permission refresh.
  app.get('/:id/versions/:v1Id/redline-docx/:v2Id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId, v1Id, v2Id } = req.params as { id: string; v1Id: string; v2Id: string }
    try {
      const { bytes, title } = await generateRedlineDocx({ contractId, orgId, v1Id, v2Id })
      const safeTitle = title.replace(/[^\w.\-]+/g, '_').slice(0, 100) || 'contract'
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header('content-disposition', `attachment; filename="redline-${safeTitle}-${new Date().toISOString().slice(0, 10)}.docx"`)
        .send(Buffer.from(bytes))
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'contract_not_found') return reply.status(404).send({ detail: 'Contract not found' })
      if (msg === 'version_not_found')  return reply.status(404).send({ detail: 'Version not found' })
      // Mirrors the diff route: a version still being extracted is a retry,
      // not an error, and an empty DOCX would be worse than saying so.
      if (msg === 'version_pending') {
        return reply.status(409).send({
          error:  'Version still processing',
          detail: 'This version is still being extracted. The redline will be available once processing finishes.',
        })
      }
      req.log.error({ err }, '[redline-docx] failed')
      return reply.status(500).send({ detail: 'Redline export failed', error: msg.slice(0, 200) })
    }
  })


  // ── Redline analysis trigger ───────────────────────────────────────────────
  // ── POST /:id/redline-against-playbook (Phase 3) ──────────────────────────
  // Kicks off a whole-document redline: check -> batch propose -> STAGE.
  // 202 + a status key in contract.metadata, which is how every long AI job
  // here reports and what the detail page already polls at 4s.
  //
  // It stages rather than applies on purpose. Writing the markup into the
  // contract before a lawyer has seen it is an unreviewed edit, not a redline.
  app.post('/:id/redline-against-playbook', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const body = (req.body ?? {}) as { aggression?: string }

    const AGGRESSION = ['least', 'moderate', 'aggressive'] as const
    const aggression = (AGGRESSION as readonly string[]).includes(body.aggression ?? '')
      ? body.aggression as typeof AGGRESSION[number]
      : 'moderate'

    const contract = await prisma.contract.findFirst({
      where:  { id: contractId, orgId, deletedAt: null },
      select: { id: true, currentVersionId: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    if (!contract.currentVersionId) {
      return reply.status(400).send({ detail: 'Contract has no current version to redline' })
    }

    const meta = (contract.metadata as Record<string, unknown> | null) ?? {}
    if (meta._playbookRedlineStatus === 'RUNNING' || meta._playbookRedlineStatus === 'QUEUED') {
      return reply.status(409).send({ detail: 'A redline is already running for this contract' })
    }

    // Mark QUEUED before enqueuing so a poll landing between the two sees a
    // run in progress rather than a stale DONE from a previous pass.
    await prisma.contract.update({
      where: { id: contractId },
      data:  {
        metadata: {
          ...meta,
          _playbookRedlineStatus: 'QUEUED',
          _playbookRedlineError:  null,
        } as never,
      },
    })

    queuePlaybookRedline({
      contractId, orgId, userId,
      versionId: contract.currentVersionId,
      aggression,
    })

    return reply.status(202).send({ status: 'QUEUED', contractId, aggression })
  })

  // ── POST /:id/redline-against-playbook/apply ──────────────────────────────
  // Applies the subset the reviewer accepted, as ONE version (Phase 2).
  // Anything not named here is not applied — a change the reviewer did not
  // accept must never reach the document.
  app.post('/:id/redline-against-playbook/apply', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const body = (req.body ?? {}) as { acceptedClauseIds?: unknown }

    const accepted = Array.isArray(body.acceptedClauseIds)
      ? body.acceptedClauseIds.filter((x): x is string => typeof x === 'string')
      : []
    if (accepted.length === 0) {
      return reply.status(400).send({ detail: 'acceptedClauseIds is required' })
    }

    const contract = await prisma.contract.findFirst({
      where:  { id: contractId, orgId, deletedAt: null },
      select: { id: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const meta = (contract.metadata as Record<string, unknown> | null) ?? {}
    const staged = meta._playbookRedline as
      { proposals?: Array<{ clauseId: string; proposedText?: string; rationale?: string }> } | undefined
    if (!staged?.proposals?.length) {
      return reply.status(409).send({ detail: 'No staged redline to apply', code: 'NO_STAGED_REDLINE' })
    }

    // Only ever apply text that was actually staged. Taking proposedText from
    // the request would let a client apply language nobody reviewed.
    const byId = new Map(staged.proposals.filter(p => p.proposedText).map(p => [p.clauseId, p]))
    const changes = accepted
      .map(id => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map(p => ({ clauseId: p.clauseId, proposedText: p.proposedText!, rationale: p.rationale }))

    if (changes.length === 0) {
      return reply.status(409).send({
        detail: 'None of the accepted clauses are in the staged redline',
        code:   'NOT_STAGED',
      })
    }

    const result = await applyClauseBatch({
      orgId, userId, contractId, changes,
      rationale: 'accepted from playbook redline',
    })
    if (!result.ok) {
      return reply.status(result.status).send({ detail: result.detail, code: result.code })
    }

    // Record which ones the reviewer took, so a second visit does not re-offer
    // changes already in the document.
    await prisma.contract.update({
      where: { id: contractId },
      data:  {
        metadata: {
          ...meta,
          _playbookRedlineStatus: 'APPLIED',
          _playbookRedline: {
            ...(staged as object),
            acceptedClauseIds: accepted,
            appliedAt: new Date().toISOString(),
          },
        } as never,
      },
    })

    return reply.send(result.data)
  })

  // ── GET /:id/playbook-review ──────────────────────────────────────────────
  // The automatic review from the parse pipeline has been written to
  // contract.metadata._playbookReview since it shipped, and nothing ever read
  // it — a repo-wide grep found the write and no reader. Exposing it means the
  // redline surface can show what the org already paid to compute.
  app.get('/:id/playbook-review', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id: contractId } = req.params as { id: string }

    const contract = await prisma.contract.findFirst({
      where:  { id: contractId, orgId, deletedAt: null },
      select: { metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const review = (contract.metadata as Record<string, unknown> | null)?._playbookReview
    if (!review) {
      return reply.status(404).send({ detail: 'No playbook review has been run for this contract' })
    }
    return reply.send(review)
  })

  app.post('/:id/redline', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { v1Id, v2Id } = req.body as { v1Id: string; v2Id: string }

    if (!v1Id || !v2Id) return reply.status(400).send({ error: 'v1Id and v2Id are required' })

    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId, deletedAt: null } })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })

    // Mark as analyzing
    await prisma.contract.update({
      where: { id: contractId },
      data: { metadata: { ...(contract.metadata as object), _redlineStatus: 'ANALYZING' } },
    })

    queueRedlineAnalysis({ contractId, v1Id, v2Id, orgId, userId, contractType: contract.type })

    return reply.status(202).send({ status: 'ANALYZING' })
  })


  // ── Submit contract for approval — Phase 06 ───────────────────────────────
  app.post('/:id/submit-approval', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { workflowDefinitionId, comment } = req.body as {
      workflowDefinitionId?: string
      comment?:              string
    }

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId, deletedAt: null },
    })
    if (!contract) return reply.status(404).send({ error: 'Contract not found' })
    if (!['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION'].includes(contract.status)) {
      return reply.status(409).send({ error: `Cannot submit a contract with status ${contract.status} for approval` })
    }

    // Prevent duplicate in-flight approval instances
    const existingInstance = await prisma.approvalInstance.findFirst({
      where: { contractId, status: { in: ['PENDING', 'ESCALATED'] } },
    })
    if (existingInstance) {
      return reply.status(409).send({ error: 'Contract already has an active approval workflow', instanceId: existingInstance.id })
    }

    // Find workflow definition
    let workflow = workflowDefinitionId
      ? await prisma.workflowDefinition.findFirst({ where: { id: workflowDefinitionId, orgId, deletedAt: null, isActive: true } })
      : null

    if (!workflow) {
      // Auto-select: find a workflow that matches this contract type / value
      const candidates = await prisma.workflowDefinition.findMany({
        where: { orgId, isActive: true, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
      for (const candidate of candidates) {
        const rules = candidate.triggerRules as Record<string, unknown>
        const types = (rules.contractTypes as string[] | undefined) ?? []
        if (types.length === 0 || types.includes(contract.type)) {
          workflow = candidate
          break
        }
      }
    }

    if (!workflow) {
      return reply.status(422).send({
        error: 'No active approval workflow found for this org. Create one in Approvals → Manage Workflows.',
      })
    }

    const stepDefs: WorkflowStepDef[] = Array.isArray(workflow.steps)
      ? (workflow.steps as unknown as WorkflowStepDef[])
      : []
    if (stepDefs.length === 0) {
      return reply.status(422).send({ error: 'Workflow has no steps configured' })
    }

    const firstStepDef = stepDefs.sort((a, b) => a.order - b.order)[0]
    const triggerRules = (workflow.triggerRules as Record<string, unknown>) ?? {}

    // ── Auto-approval check ──────────────────────────────────────────────────
    const contractValue = contract.value ? Number(contract.value) : null
    if (checkAutoApprove(contract.type, contractValue, triggerRules)) {
      // Instantly approve without creating pending steps
      const instance = await prisma.approvalInstance.create({
        data: {
          orgId,
          contractId,
          workflowDefinitionId: workflow.id,
          status:           'AUTO_APPROVED',
          currentStepOrder: 0,
          submittedById:    userId,
          decidedAt:        new Date(),
          aiSummary:        'Auto-approved based on org rules.',
          approvalRecommendation: 'approve',
        },
      })

      await prisma.contract.update({ where: { id: contractId }, data: { status: 'APPROVED' } })

      createAuditEvent({
        orgId, userId,
        action:       AuditAction.APPROVAL_SUBMITTED,
        resourceType: 'contract',
        resourceId:   contractId,
        metadata:     { instanceId: instance.id, autoApproved: true },
      }).catch(() => {})

      queueNotification({
        orgId, userId,
        type:         'APPROVAL_DECIDED',
        title:        'Contract auto-approved',
        body:         `"${contract.title}" was auto-approved based on your org's rules.`,
        resourceType: 'approval_instance',
        resourceId:   instance.id,
      })

      return reply.status(201).send({ instanceId: instance.id, status: 'AUTO_APPROVED', autoApproved: true })
    }

    // ── Normal flow: create instance + first step(s) ──────────────────────────
    // Wave 3.8 — a `parallel` first step fans out to all its approvers at once;
    // a sequential step resolves to a single approver.
    const firstApproverIds = await resolveApprovers(firstStepDef, orgId, prisma)
    if (firstApproverIds.length === 0) {
      return reply.status(422).send({
        error: `Cannot resolve approver for step "${firstStepDef.name}". Check the workflow configuration.`,
      })
    }

    const escalateAt = new Date(Date.now() + (firstStepDef.dueSoonHours ?? 48) * 60 * 60 * 1000)

    const instance = await prisma.$transaction(async (tx) => {
      const inst = await tx.approvalInstance.create({
        data: {
          orgId,
          contractId,
          workflowDefinitionId: workflow!.id,
          status:           'PENDING',
          currentStepOrder: firstStepDef.order,
          submittedById:    userId,
        },
      })

      const steps = await Promise.all(firstApproverIds.map(approverId =>
        tx.approvalStep.create({
          data: {
            approvalInstanceId: inst.id,
            orgId,
            stepOrder:  firstStepDef.order,
            stepName:   firstStepDef.name,
            approverId,
            status:     'PENDING',
            escalateAt,
          },
        }),
      ))

      await tx.contract.update({ where: { id: contractId }, data: { status: 'PENDING_APPROVAL' } })

      return { inst, steps }
    })

    // Queue an escalation timer per concurrent approver step.
    const delayMs = (firstStepDef.dueSoonHours ?? 48) * 60 * 60 * 1000
    await Promise.all(instance.steps.map(async (step) => {
      const escalationJob = await queueEscalation_({ instanceId: instance.inst.id, stepId: step.id, orgId, escalateTo: firstStepDef.escalateTo }, delayMs)
      await prisma.approvalStep.update({ where: { id: step.id }, data: { escalationJobId: escalationJob.id?.toString() } })
    }))

    // Queue AI summary generation
    const latestVersion = await prisma.contractVersion.findFirst({
      where:   { contractId },
      orderBy: { versionNumber: 'desc' },
    })
    if (latestVersion) {
      queueApprovalSummary({
        instanceId:  instance.inst.id,
        contractId,
        versionId:   latestVersion.id,
        orgId,
        approverIds: firstApproverIds,
      })
    }

    // Notify every first-step approver.
    const approvers = await prisma.user.findMany({
      where: { id: { in: firstApproverIds } },
      select: { id: true, email: true },
    })
    const emailById = new Map(approvers.map(u => [u.id, u.email]))
    instance.steps.forEach((step) => {
      queueNotification({
        orgId,
        userId:       step.approverId,
        type:         'APPROVAL_REQUEST',
        title:        'Contract awaiting your approval',
        body:         `"${contract.title}" has been submitted for approval (${firstStepDef.name}).`,
        resourceType: 'approval_step',
        resourceId:   step.id,
        email:        emailById.get(step.approverId) ?? undefined,
      })
    })

    createAuditEvent({
      orgId, userId,
      action:       AuditAction.APPROVAL_SUBMITTED,
      resourceType: 'contract',
      resourceId:   contractId,
      metadata:     { instanceId: instance.inst.id, workflowId: workflow.id, approverCount: firstApproverIds.length },
    }).catch(() => {})

    // Phase 10 — Slack/webhook subscribers get an actionable card with
    // Approve/Reject buttons (slack-formatter adds them for type=slack). The
    // card points at the first approver/step of the (possibly parallel) batch.
    fireWebhook(orgId, 'approval.submitted', {
      contractId,
      title:      contract.title,
      type:       contract.type,
      value:      contract.value != null ? Number(contract.value) : null,
      currency:   contract.currency,
      instanceId: instance.inst.id,
      stepId:     instance.steps[0].id,
      stepName:   firstStepDef.name,
      approverId: instance.steps[0].approverId,
    }).catch(() => {})

    return reply.status(201).send({
      instanceId:           instance.inst.id,
      contractId,
      status:               'PENDING',
      autoApproved:         false,
      workflowDefinitionId: workflow.id,
      currentStepOrder:     firstStepDef.order,
      steps: instance.steps.map(step => ({
        id:          step.id,
        stepOrder:   firstStepDef.order,
        stepName:    firstStepDef.name,
        approverId:  step.approverId,
        status:      'PENDING',
        escalateAt,
      })),
    })
  })

  // ── POST /:id/extract-obligations (P5.1 / P8 Step 2) ──────────────────────
  // Triggers the obligations LLM pass on the current version's plaintext.
  // Auto-fires on signature.completed (P8 Step 2); also exposed manually
  // via the "Extract obligations" rail button.
  app.post('/:id/extract-obligations', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    try {
      const result = await extractObligationsForContract({
        orgId, contractId: id, userId: req.user.sub,
      })
      if (result.skippedReason === 'no version') {
        return reply.status(400).send({ detail: 'No version to extract from' })
      }
      if (result.skippedReason === 'no plaintext') {
        return reply.status(400).send({ detail: 'No plaintext on current version' })
      }
      if (result.error?.startsWith('contract not found')) {
        return reply.status(404).send({ detail: 'Contract not found' })
      }
      if (result.error?.startsWith('agents service error')) {
        return reply.status(502).send({ detail: 'obligations extractor failed', upstream: result.error })
      }
      const fresh = await prisma.obligation.findMany({
        where: { contractId: id }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      })
      return reply.send({
        ok:          result.ok,
        obligations: fresh,
        summary:     result.summary,
        error:       result.error,
      })
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        return reply.status(429).send({
          detail: `Daily AI cost cap reached ($${err.usedUsd.toFixed(2)} of $${err.capUsd.toFixed(2)}). Try again tomorrow or raise the cap in Admin → AI Config.`,
          retryAfter: 86400,
        })
      }
      throw err
    }
  })

  // ── GET /:id/obligations (P8 Step 1) ──────────────────────────────────────
  // List obligations for one contract (used by the rail section + agent).
  app.get('/:id/obligations', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const items = await prisma.obligation.findMany({
      where: { contractId: id },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    })
    const md = (contract.metadata ?? {}) as Record<string, unknown>
    return reply.send({
      data: items,
      summary:     (md.obligationsSummary as string | null) ?? null,
      extractedAt: (md.obligationsExtractedAt as string | null) ?? null,
    })
  })

  // ── POST /:id/compliance-check (Phase 10 — Compliance Agent) ─────────────
  // Runs GDPR / HIPAA / SOX / CCPA regulatory clause checks on the current
  // version's plaintext. Persists the report onto Contract.metadata._compliance.
  app.post('/:id/compliance-check', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = (req.body ?? {}) as { frameworks?: string[] }
    if (body.frameworks !== undefined) {
      if (!Array.isArray(body.frameworks)
        || body.frameworks.some(f => !(COMPLIANCE_FRAMEWORKS as readonly string[]).includes(f))) {
        return reply.status(400).send({
          detail: `frameworks must be a subset of: ${COMPLIANCE_FRAMEWORKS.join(', ')}`,
        })
      }
    }
    try {
      const result = await runComplianceCheck({
        orgId, contractId: id, userId: req.user.sub, frameworks: body.frameworks,
      })
      if (result.skippedReason === 'no version') {
        return reply.status(400).send({ detail: 'No version to check' })
      }
      if (result.skippedReason === 'no plaintext') {
        return reply.status(400).send({ detail: 'No plaintext on current version' })
      }
      if (result.error?.startsWith('contract not found')) {
        return reply.status(404).send({ detail: 'Contract not found' })
      }
      if (result.error?.startsWith('agents service error')) {
        return reply.status(502).send({ detail: 'compliance agent failed', upstream: result.error })
      }
      if (!result.ok || !result.report) {
        return reply.status(502).send({ detail: 'compliance agent failed', upstream: result.error })
      }
      return reply.send({ ok: true, report: result.report })
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        return reply.status(429).send({
          detail: `Daily AI cost cap reached ($${err.usedUsd.toFixed(2)} of $${err.capUsd.toFixed(2)}). Try again tomorrow or raise the cap in Admin → AI Config.`,
          retryAfter: 86400,
        })
      }
      throw err
    }
  })

  // ── GET /:id/compliance (Phase 10) ────────────────────────────────────────
  // Returns the last persisted compliance report (or null when never run).
  app.get('/:id/compliance', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const md = (contract.metadata ?? {}) as Record<string, unknown>
    return reply.send({ report: (md._compliance as Record<string, unknown> | undefined) ?? null })
  })

  // ── POST /:id/renewal-advice (P5.3 — Wave H.3) ──────────────────────────
  // Asks the renewal-advisor LLM for a decisive recommendation on a
  // contract whose expiry is inside the 90-day window. Persists the
  // result onto Contract.metadata.renewalAdvice so the rail section +
  // the agent tool can read it cheaply.
  app.post('/:id/renewal-advice', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true, type: true, title: true, expiryDate: true, value: true,
        currency: true, counterpartyName: true, metadata: true,
        currentVersionId: true,
      },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const versionId = contract.currentVersionId ?? (await prisma.contractVersion.findFirst({
      where: { contractId: contract.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    }))?.id
    if (!versionId) return reply.status(400).send({ detail: 'No version to analyse' })

    const version = await prisma.contractVersion.findUnique({
      where: { id: versionId },
      select: { plainText: true },
    })
    const rawText2 = version?.plainText ?? ''
    if (!rawText2) return reply.status(400).send({ detail: 'No plaintext on current version' })

    const md = (contract.metadata ?? {}) as Record<string, unknown>
    const obligations = Array.isArray(md.obligations) ? md.obligations : []
    const valueSummary = contract.value
      ? `${contract.currency ?? 'USD'} ${contract.value.toString()}`
      : undefined

    // P7.5.2 — gate behind cost cap.
    try {
      await assertCostCapNotExceeded(orgId)
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        return reply.status(429).send({
          detail: `Daily AI cost cap reached ($${err.usedUsd.toFixed(2)} of $${err.capUsd.toFixed(2)}). Try again tomorrow or raise the cap in Admin → AI Config.`,
          retryAfter: 86400,
        })
      }
      throw err
    }

    // P7.5.1 — same PII policy + audit on this LLM-bound surface.
    const { text, mode: piiMode2, total: piiTotal2 } = await applyPiiPolicy(orgId, rawText2, {
      surface: 'renewal_advice',
      contractId: contract.id,
      userId: req.user.sub,
    })

    const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8000'
    const pyRes = await fetch(`${agentsUrl}/renewal_advice`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
        'x-pii-mode': piiMode2,
        'x-pii-redaction-count': String(piiTotal2),
      },
      body: JSON.stringify({
        plainText:     text,
        contractType:  contract.type,
        counterparty:  contract.counterpartyName ?? undefined,
        expiryDate:    contract.expiryDate ? contract.expiryDate.toISOString().slice(0, 10) : undefined,
        valueSummary,
        obligations:   obligations.slice(0, 10),
        orgId,   // Wave 3.5 — lets the agents service resolve the org's BYOK key
      }),
    })
    if (!pyRes.ok) {
      const err = await pyRes.text()
      return reply.status(502).send({ detail: 'renewal advisor failed', upstream: err.slice(0, 300) })
    }
    const parsed = await pyRes.json() as Record<string, unknown>

    // Record estimated cost against the cap, and the call against the admin
    // usage panel. provider/model are what the agents service actually ran.
    recordUsage(orgId, estimateCostUsd(text.length), {
      provider: String(parsed.provider ?? 'unknown'),
      model:    String(parsed.model ?? 'unknown'),
      tier:     'default',
      toolName: 'renewal_advice',
      inputChars: text.length,
    }).catch((e) => {
      req.log.warn({ err: e }, '[costCap] recordUsage(renewal_advice) failed')
    })

    const nextMeta: Record<string, unknown> = {
      ...md,
      renewalAdvice: {
        ...parsed,
        generatedAt: new Date().toISOString(),
      },
    }
    await prisma.contract.update({
      where: { id },
      data:  { metadata: nextMeta as never },
    })

    return reply.send({
      ok:       !parsed.error,
      advice:   parsed,
      error:    parsed.error ?? null,
    })
  })

  // ── POST /:id/renewal-decision (P5.3) ────────────────────────────────────
  // Records the owner's decision ("renew"/"renegotiate"/"let_expire"/"pause")
  // so the renewal scanner stops pinging this contract.
  app.post('/:id/renewal-decision', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = req.body as { decision?: string; note?: string } | undefined
    const decision = body?.decision
    if (!decision || !['renew', 'renegotiate', 'let_expire', 'pause', 'unknown'].includes(decision)) {
      return reply.status(400).send({ detail: 'invalid decision' })
    }

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const md = (contract.metadata ?? {}) as Record<string, unknown>
    const nextMeta: Record<string, unknown> = {
      ...md,
      renewalDecision:   decision,
      renewalDecisionAt: new Date().toISOString(),
      renewalDecisionNote: body?.note ?? null,
    }
    await prisma.contract.update({ where: { id }, data: { metadata: nextMeta as never } })

    return reply.send({ ok: true, decision })
  })
}

// Local alias to avoid naming collision with the imported queueEscalation
async function queueEscalation_(payload: Parameters<typeof import('../lib/queue.js').queueEscalation>[0], delayMs: number) {
  const { queueEscalation } = await import('../lib/queue.js')
  return queueEscalation(payload, delayMs)
}
