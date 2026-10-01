import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { computeVersionDiff, htmlDiff, DiffTooLargeError } from '../lib/diff.js'
import { prisma } from '../lib/prisma.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { renderHtmlToPdf, renderHtmlToPdfAndStore } from '../lib/gotenberg.js'
import { RenderRefusedError } from '../lib/render-html.js'
import { requirePermission } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { extractObligationsForContract } from '../lib/obligation-extract.js'
import { generateRedlineDocx, generatePlainDocx } from '../lib/docx-export.js'
import { resolveRevisionAuthors } from '../lib/revision-author.js'
import { lockOf, lockedBody } from '../lib/external-edit.js'
import { runComplianceCheck, COMPLIANCE_FRAMEWORKS } from '../lib/compliance-check.js'
import { generateCompliancePackage } from '../lib/compliance-export.js'
import { buildCsv, parseCsv } from '../lib/csv.js'
import { fireWebhook } from '../lib/webhook-events.js'
import { applyPiiPolicy } from '../lib/pii-policy.js'
import { assertCostCapNotExceeded, recordCost, estimateCostUsd, CostCapExceededError, recordUsage } from '../lib/costCap.js'
import { indexContract, deleteContractFromIndex, reindexContract } from '../lib/elasticsearch.js'
import { proposeClauseAlternatives } from '../lib/clause-propose.js'
import { applyClauseProposal, escapeHtml as escapeText } from '../lib/clause-apply.js'
import { restorePii, unresolvedPiiTokens, redactJson, withWholeTokens, valueLeftInMarkup, getOrgPiiMode, plainSpacesHtml, htmlTextForms, sliceOutsideTokens } from '../lib/pii-policy.js'
import { storeClauseSegments, searchClauses, effectiveVersionsSql } from '../lib/embeddings.js'
import { clauseVersionId } from '../lib/clause-version.js'
import { afterEdit } from '../lib/version-refresh.js'
import { standingVersion } from '../lib/standing-version.js'
import { queueParseDocument, queueClassifyDocument, queueChunkAndIndex, queueSplitBinder, queueEmbedContract, queueRedlineAnalysis, queueApprovalSummary, queueNotification, queueDraftContract, queuePlaybookRedline, queueExtractTypeFields, queueReadExhibit } from '../lib/queue.js'
import { applyClauseBatch } from '../lib/clause-apply.js'
import { checkAutoApprove, resolveApprovers, type WorkflowStepDef } from '../lib/workflow-engine.js'
import { checkUpload, servableContentType, CONTRACT_DOCUMENT_TYPES, ATTACHMENT_TYPES } from '../lib/file-type.js'
import { SPLIT_REQUIRES_PDF, previousSplitChildren, resplitBlocker } from '../lib/binder-split.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { manualRefusal, manualSource, manualTarget } from '../lib/contract-status.js'
import { NOT_ANALYSED, analysisState } from '../lib/analysis-trigger.js'
import { startRun, failOpenRuns } from '../lib/analysis-runs.js'
import { contractPlaybook } from '../lib/playbooks.js'
import { initialStage, positionOf, transition } from '../lib/lifecycle.js'
import { onApprovalChange } from '../lib/approval-reset.js'
import { submitForApproval } from '../lib/approval-flow.js'
import { recommendationGuard } from '../lib/recommendation-guard.js'
import { openChoices } from '../lib/open-choices.js'
import { htmlToText } from '../lib/html-text.js'
import { guardOwnScopeContractRoutes, ownContractWhere } from '../lib/own-scope-guard.js'
import {
  applyExtraction, extractedFieldsFromPatch, personFieldsFromPatch, setFieldValues,
  STORE_OWNED_PATCH_KEYS, STORE_OWNED_METADATA_KEYS, type ExtractionMode,
} from '../lib/field-store.js'
import { recordRun } from '../lib/field-runs.js'
import { typeFieldsMark } from '../lib/type-fields-read.js'
import { versionTrackedViews } from '../lib/tracked-changes.js'
import { readExhibits, attachmentsOf, EXHIBIT_READABLE } from '../lib/exhibits.js'
import { scanPagesOf, poorPageReader } from '../lib/scan-quality.js'
import {
  CreateContractSchema,
  UpdateContractSchema,
  ContractFilterSchema,
  AuditAction,
  normalizeRiskScore,
  pickWorkflow,
  typeFieldsFor,
  ContractType,
  readContractType,
} from '@clm/types'
import { modelFetch } from '../lib/model-boundary.js'

// riskScore is served as 0-100 (RiskScoreSchema in @clm/types) whatever scale
// the row happens to hold, so a client never has to guess which one it got.
// Writes are normalised too, so this only rescales rows that pre-date that.
function withNormalizedRisk<T extends { riskScore: number | null }>(row: T) {
  return { ...row, riskScore: normalizeRiskScore(row.riskScore) }
}

/**
 * X27 — each form of a version's text a value can be found in: the redline
 * diff tokenizes the values of all of them, and the analysis written from it
 * is restored against the same.
 */
function versionForms(v: { plainText: string; htmlContent: string }): string[] {
  return [v.plainText, ...htmlTextForms(v.htmlContent)]
}

/** X33 — how much of each version's text the agents service's version list carries (the approval prompt reads 8,000). */
const AGENT_TEXT_EXCERPT = 20_000

/**
 * X47 — whether a saved HTML body is the document already stored. Line
 * breaks between tags don't count: the extractor writes them and the editor
 * never does. Any other difference is an edit, a single space included.
 */
function sameDocumentHtml(stored: string, saved: string): boolean {
  const norm = (html: string) => html.replace(/>\s*\n\s*</g, '><').trim()
  return norm(stored) === norm(saved)
}

export async function contractRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)
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

    // Risk band, 0-100. Writes are normalised at the boundary now, so this is a
    // plain range rather than the dual-scale OR it used to be — that OR made
    // every bound mean two different things and quietly widened the band.
    // Rows written before normalisation may still hold a 0-1 fraction and will
    // under-match until scripts/backfill-risk-score-scale.ts has been run.
    if (query.riskScoreMin !== undefined || query.riskScoreMax !== undefined) {
      andClauses.push({
        riskScore: {
          ...(query.riskScoreMin !== undefined && { gte: query.riskScoreMin }),
          ...(query.riskScoreMax !== undefined && { lte: query.riskScoreMax }),
        },
      })
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
        // `id` is the tiebreaker, not decoration: createdAt is TIMESTAMP(3) and
        // CURRENT_TIMESTAMP is transaction-constant, so a bulk-seeded or
        // bulk-imported batch shares one millisecond. Cursor paging on a
        // non-unique sort key lets the second page repeat or skip rows, which
        // now that the repository actually pages ("Load more") would show up as
        // duplicated contracts.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.contract.count({ where }),
    ])

    const hasMore = contracts.length > query.limit
    const data = hasMore ? contracts.slice(0, query.limit) : contracts
    const nextCursor = hasMore ? data[data.length - 1].id : undefined

    return reply.send({ data: data.map(withNormalizedRisk), cursor: nextCursor, hasMore, total })
  })

  // ── POST /bulk-import — CSV bulk import (P10D) ──────────────────────
  // Multipart upload of a CSV with these columns (header required):
  //   title (req), type, status, counterpartyName, value, currency,
  //   effectiveDate, expiryDate, jurisdiction
  // Each row creates a Contract row with ownerId = current user.
  // Returns a summary with per-row success/failure for the UI to render.
  app.post('/bulk-import', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    // X45 — an API key's rows belong to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

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
      // docs/39 A16 — the app's one type list, read as people write it ("DPA",
      // "Vendor"): this route kept its own, which stored types nothing else
      // knows and read DATA_PROCESSING, VENDOR_AGREEMENT, SLA as OTHER.
      const type = readContractType(get('type'))?.type ?? 'OTHER'
      const rawStatus = get('status').toUpperCase() || 'DRAFT'
      const status = ALLOWED_STATUS.has(rawStatus) ? rawStatus : 'DRAFT'
      // X24 follow-up — approval statuses are the approval workflow's to set,
      // on import as by hand: a row marked APPROVED had no approval behind it.
      if (['PENDING_APPROVAL', 'APPROVED', 'PENDING_SIGNATURE'].includes(status)) {
        results.push({ row: rowNo, ok: false, title, error: `${status} is set by the approval workflow, not by import. Import the row as DRAFT (or EXECUTED if it is signed) and submit it for approval.` })
        continue
      }
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
            orgId, ownerId, createdBy: req.user.sub,   // X45 — for a key, the key; the owner is its maker
            title, type,
            // docs/41 Part 18 — the stage the status stands for.
            ...initialStage(status),
            counterpartyName: cp,
            value: value as never,
            currency: (get('currency') || 'USD').toUpperCase(),
            effectiveDate: safeDate(eff),
            expiryDate:    safeDate(exp),
            jurisdiction:  jur,
            tags:          ['bulk-import'],
            // P27 audit (2026-05-02). Bulk-import has no file → no
            // parse pipeline → no worker advances analysisStatus past
            // PENDING. docs/41 P0.1 — and nothing was analysed, so it
            // says so rather than DONE.
            analysisStatus: NOT_ANALYSED,
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
    // X7 — an own-scope caller exports only their own contracts.
    if (req.permissionScope === 'own') where.ownerId = req.user.sub
    // 0-100 bands, matching riskBand() in the web app so an exported row lands
    // in the same band the user saw on screen. These read 0.67/0.34 before,
    // which on real 0-100 data put the entire portfolio in "high".
    if (q.riskBand === 'high')   where.riskScore = { gte: 67 }
    if (q.riskBand === 'medium') where.riskScore = { gte: 34, lt: 67 }
    if (q.riskBand === 'low')    where.riskScore = { lt: 34 }
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
      normalizeRiskScore(c.riskScore) ?? '',
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
    const { orgId } = req.user
    // X26 follow-up — as for PATCH: `_` metadata keys are server state (a
    // forged _compliance or _playbookReview showed on the rail as real).
    const reserved = req.user.sub === 'system' ? [] : Object.keys(body.metadata ?? {}).filter(k => k.startsWith('_'))
    if (reserved.length) {
      return reply.status(400).send({ detail: `Metadata keys starting with "_" are set by the server: ${reserved.join(', ')}` })
    }
    // X45 — an API key's contract belongs to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

    // P27 audit (2026-05-02). Blank-create has no file → no parse
    // pipeline → no worker will ever advance analysisStatus past
    // PENDING. The contract page polls and sits at "Processing
    // starting…" forever. docs/41 P0.1 — NOT_ANALYSED, not DONE: the row
    // is usable, and says truthfully that nothing has been read (DONE made
    // an unread contract look analysed and clean). Uploads set PENDING.
    const contract = await prisma.contract.create({
      data: { ...body, orgId, ownerId, analysisStatus: NOT_ANALYSED } as Prisma.ContractUncheckedCreateInput,
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
      riskScore:        normalizeRiskScore(contract.riskScore) ?? undefined,
      effectiveDate:    contract.effectiveDate?.toISOString(),
      expiryDate:       contract.expiryDate?.toISOString(),
      createdAt:        contract.createdAt.toISOString(),
      keyTerms:         contract.keyTerms as Record<string, unknown>,
      metadata:         contract.metadata as Record<string, unknown>,
    }).catch(err => app.log.warn({ err }, 'ES index on blank-create failed'))

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
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
    // X45 — an API key's upload belongs to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let mimeType = 'application/pdf'
    let filename = 'contract.pdf'
    let title = ''
    let type = 'OTHER'
    let counterpartyName = ''
    let parentContractId: string | undefined
    let relationshipType: string | undefined
    // docs/39 G4 — a copy already signed: in force from upload (as bulk import allows),
    // and read for its obligations once analysed.
    let signed = false

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
        mimeType = part.mimetype
        filename = part.filename
      } else {
        const val = (part as any).value as unknown
        // X20 — form fields are text. A part sent as application/json arrives
        // as an object, which a Prisma where clause reads as a FILTER (so a
        // parent check could match any contract).
        if (typeof val !== 'string') continue
        if (part.fieldname === 'title') title = val
        if (part.fieldname === 'type') type = val
        if (part.fieldname === 'counterpartyName') counterpartyName = val
        if (part.fieldname === 'parentContractId' && val) parentContractId = val
        if (part.fieldname === 'relationshipType' && val) relationshipType = val
        if (part.fieldname === 'signed') signed = val === 'true'
      }
    }

    if (!fileBuffer) return reply.status(400).send({ detail: 'No file uploaded' })

    // X20 — a parent link must name a live contract of this org (one the
    // caller owns, for own scope, as the /:id/amendments guard requires).
    // It was stored unchecked, and the parent's family view then listed this
    // contract — across orgs, too.
    if (parentContractId) {
      const parent = await prisma.contract.count({
        where: { id: parentContractId, orgId, deletedAt: null, ...ownContractWhere(req) },
      })
      if (!parent) return reply.status(404).send({ detail: 'Parent contract not found' })
    }

    // Wave 1.8 — validate the upload by MAGIC BYTES, not the client-declared
    // mimetype (which is spoofable). A user could otherwise store HTML/SVG/
    // executables as a "contract" and have the download endpoint serve them
    // back with an attacker-chosen Content-Type (content-confusion / stored
    // XSS). We sniff the real type and use it; text/plain is allowed only when
    // no binary signature is present. Everything else is rejected.
    const checked = checkUpload(fileBuffer, mimeType, CONTRACT_DOCUMENT_TYPES)
    if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
    mimeType = checked.mimeType // trust the bytes, not the client

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
        ownerId,
        title: title || cleanFilename || filename.replace(/\.[^.]+$/, ''),
        type,
        status: signed ? 'EXECUTED' : 'DRAFT',
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
      metadata: { filename, mimeType, fileSize: fileBuffer.byteLength, ...(signed && { signed: true }) },
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
        // docs/39 A12 — each attachment as read, without its text.
        exhibits: { select: { s3Key: true, pageCount: true, ocrApplied: true, error: true, readAt: true } },
      },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_VIEWED,
      resourceType: 'contract',
      resourceId: id,
    })

    // X27 — the agents service reads the key terms and summary here for the
    // approval summary's prompt: the org's PII policy applies (round-trip
    // tokens, put back when the summary is stored, see approvals.ts).
    // `metadata` stays as it is: redline.py writes it back merged.
    if (req.user.sub === 'system') {
      const current = contract.versions.find(v => v.id === contract.currentVersionId) ?? contract.versions[0]
      const read = await redactJson(contract.orgId, { keyTerms: contract.keyTerms, summary: contract.summary }, {
        surface: 'agents_contract_read', contractId: id, roundTrip: id,
        valuesFrom: [current?.plainText ?? '', contract.keyTerms, contract.summary],
      })
      return reply.send(withNormalizedRisk({ ...contract, ...read }))
    }

    return reply.send(withNormalizedRisk(contract))
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
      // DD4 — the version the contract stands on (an undo moves it back), not
      // the newest: after undoing a redline, the PDF was the undone text.
      : await standingVersion(contract.id, contract.currentVersionId)

    // Pick the artifact key: canonical = renderedPdfKey (if present) else s3Key.
    const canonicalKey = (v: typeof version) =>
      artifact === 'source' ? v?.s3Key : (v?.renderedPdfKey ?? v?.s3Key)

    // If the selected version has no usable key, fall back to the most recent
    // version that does, up to the one the contract stands on.
    if (!canonicalKey(version) && !versionId) {
      version = await prisma.contractVersion.findFirst({
        where: {
          contractId: id,
          ...(version && { versionNumber: { lte: version.versionNumber } }),
          OR: artifact === 'source'
            ? [{ s3Key: { not: null } }]
            : [{ renderedPdfKey: { not: null } }, { s3Key: { not: null } }],
        },
        orderBy: { versionNumber: 'desc' },
      })
    }

    const key = canonicalKey(version)
    if (!key) return reply.status(404).send({ detail: 'No file stored for this version' })

    // Serve as an allowlisted type only: objects stored before upload
    // validation (S3) may carry a client-declared text/html or SVG type.
    const storedType = key === version?.renderedPdfKey ? 'application/pdf' : version?.mimeType
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, ResponseContentType: servableContentType(storedType) }),
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
        // X1 follow-up — the contract page enables its Original (PDF) view,
        // and opens a citation there, only when the latest version has a
        // stored file; without the key here it never did. GET /:id already
        // returns it for every version.
        s3Key: true,
        // A12 — a .doc or an image upload's PDF, which the page shows as its Original.
        renderedPdfKey: true,
        changeNote: true, changeSummary: true, createdById: true, createdAt: true,
      },
    })

    // Resolve the author for display. Without this the Compare view shows
    // "Unknown" against every version — it reads `createdByName ?? authorName`
    // and nothing emitted either. `createdById` is not always a user id
    // (`portal:<shareLinkId>`, `email:<addr>`), so this needs the same ladder
    // the DOCX export uses for w:author, and both stay consistent by sharing it.
    const authors = await resolveRevisionAuthors(versions.map(v => v.createdById))

    // X33 — the approval summary (approval.py) reads a version's text from
    // this list for its prompt, and none was ever here, so every summary was
    // written without the contract. The agents service gets the opening of
    // each version's text, tokenized with the contract scope as /clauses is
    // (PATCH /approvals/:id/summary restores it); users' list is unchanged.
    if (req.user.sub === 'system') {
      const texts = new Map((await prisma.contractVersion.findMany({
        where: { contractId: id }, select: { id: true, plainText: true },
      })).map(v => [v.id, v.plainText]))
      const tokenized = await redactJson(contract.orgId, versions.map(v => texts.get(v.id) ?? ''), {
        surface: 'approval_summary.text', contractId: id, roundTrip: id,
      })
      return reply.send({
        data: versions.map((v, i) => ({
          ...v, createdByName: authors.get(v.createdById) ?? null,
          plainText: sliceOutsideTokens(tokenized[i], 0, AGENT_TEXT_EXCERPT),
        })),
      })
    }

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
    // BB3 — a Google Docs copy is out: publish it back (or discard it) instead.
    const lock = lockOf(contract.externalEdit)
    if (lock) return reply.status(409).send(lockedBody(lock))

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
    // S3 — same content check as /upload: the version is parsed and served back.
    const checked = checkUpload(fileBuffer, mimeType, CONTRACT_DOCUMENT_TYPES)
    if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
    mimeType = checked.mimeType

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
    // X42, docs/41 Part 18 — a new document: approvals given are asked again as their reset rules say.
    await onApprovalChange({ orgId, contractId: id, versionId: version.id, fromVersionId: lastVersion?.id, source: 'edit', userId })

    // Reset analysis state and queue the full pipeline (parse → classify → extract → embed)
    // docs/39 G1 — a new document refreshes the values the AI owns (people's
    // stay, and what the new document says lands as a suggestion), whatever
    // mode an earlier re-analysis left behind.
    const meta = { ...((contract.metadata as Record<string, unknown> | null) ?? {}) }
    delete meta._extractionMode
    await prisma.contract.update({
      where: { id },
      data: { analysisStatus: 'PENDING', metadata: meta as never },
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
    // BB3 — read-only while a Google Docs copy is out.
    const lock = lockOf(contract.externalEdit)
    if (lock) return reply.status(409).send(lockedBody(lock))

    const lastVersion = await prisma.contractVersion.findFirst({
      where: { contractId: id },
      orderBy: { versionNumber: 'desc' },
    })
    // X47 — a save that changes nothing makes nothing. Opening a contract made
    // the web editor report a change, and the page saves every change: each
    // view added a version, moved the current version off the uploaded PDF,
    // rendered a PDF and, since X42, sent an approved contract back to DRAFT.
    // "Nothing" is judged against the version the contract stands on — the
    // latest, unless an undo moved it back, when saving the latest again is
    // a real change.
    const standing = contract.currentVersionId && contract.currentVersionId !== lastVersion?.id
      ? await prisma.contractVersion.findFirst({ where: { id: contract.currentVersionId, contractId: id } })
      : lastVersion
    if (standing && sameDocumentHtml(standing.htmlContent, htmlContent)) {
      return reply.status(200).send(standing)
    }

    const plainText = htmlToText(htmlContent)

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
    // DD2 — the edit keeps the clauses of the version it was made on, and the
    // search index follows the new text.
    await afterEdit({ contractId: id, orgId, versionId: version.id, fromVersionId: standing?.id })
    // X42, docs/41 Part 18 — approvals given are asked again as their reset rules say.
    await onApprovalChange({ orgId, contractId: id, versionId: version.id, fromVersionId: standing?.id, source: 'edit', userId })
    const status = (await prisma.contract.findUnique({ where: { id }, select: { status: true } }))?.status
    // X47 follow-up — the document changed, and perhaps its approval with it:
    // on the record, as any other change to the contract is.
    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_UPDATED,
      resourceType: 'contract',
      resourceId: id,
      metadata: { action: 'document_edited', versionNumber: version.versionNumber, ...(status && status !== contract.status && { statusFrom: contract.status, statusTo: status }) },
      ipAddress: req.ip,
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

    // X23 — the extraction read this version with round-trip tokens in place
    // of personal data (agent.worker.ts callAgents). Its segments are verbatim
    // quotes that become the stored clause text, which later redlines must find
    // in the document: put the values back.
    const restored = restorePii(req.body, version.plainText, contract.id)
    const left = unresolvedPiiTokens(restored, version.plainText).length
    if (left) req.log.warn({ contractId: contract.id, versionId, left }, 'PII tokens left unresolved in extracted clauses')
    const { clauseSegments, clauseFlags } = restored as {
      clauseSegments?: Array<{
        clauseType: string
        content: string
        sortOrder: number
        interpretation?: string
        riskRating?: string
        sectionRef?: string
        // docs/39 A4 — the clause's first and last words (PII restored above).
        startsWith?: string
        endsWith?: string
      }>
      clauseFlags?: Record<string, boolean>
    }

    if (clauseSegments?.length) {
      await storeClauseSegments(versionId, clauseSegments, version.plainText)
      queueEmbedContract(versionId)
    }

    if (clauseFlags) {
      await prisma.contractVersion.update({
        where: { id: versionId },
        data: { clauseFlags },
      })
      // C7 — the flags arrive after the contract was indexed at parse time;
      // re-index so the clause-flag filters and facets can see them.
      reindexContract(id).catch(err => app.log.warn({ err }, 'ES re-index after clause flags failed'))
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
    const versionId = await clauseVersionId(id, contract.currentVersionId)
    if (!versionId) return reply.send({ data: [] })

    const clauses = await prisma.contractClause.findMany({
      where: { versionId, isSubChunk: false },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, clauseType: true, content: true,
        interpretation: true, riskRating: true, sectionRef: true,
        sortOrder: true,
        reviewState: true, reviewedAt: true, reviewedById: true,
        // docs/39 E1 — ai, or user: tagged or corrected by a person.
        source: true,
      },
    })

    // X27 — the agents service reads these for the approval summary, which a
    // model writes: the org's PII policy applies (round-trip tokens, put back
    // when the summary is stored, see approvals.ts).
    if (req.user.sub === 'system') {
      const text = (await prisma.contractVersion.findUnique({ where: { id: versionId }, select: { plainText: true } }))?.plainText ?? ''
      return reply.send({ data: await redactJson(orgId, clauses, {
        surface: 'approval_summary.clauses', contractId: id, roundTrip: id, valuesFrom: [clauses.map(c => c.content), text],
      }) })
    }
    return reply.send({ data: clauses })
  })

  // ── B.5.7 — per-clause review state ────────────────────────────────────
  // Drives the Focused Review drawer's Accept / Reject / Mark-Reviewed
  // actions and the "N of M reviewed" progress counter in the rail.
  // EE1 — Reject is a decision of its own ('rejected'); it was stored as a
  // plain 'reviewed'. 'unreviewed' reopens a decided clause.
  app.patch('/clauses/:clauseId/review-state', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { clauseId } = req.params as { clauseId: string }
    const { sub: userId, orgId } = req.user
    const body = req.body as { state?: string }
    const state = body.state
    if (state !== 'unreviewed' && state !== 'reviewed' && state !== 'resolved' && state !== 'rejected') {
      return reply.status(400).send({ detail: 'state must be unreviewed | reviewed | resolved | rejected' })
    }

    // Scope check: ensure the clause belongs to a contract in this org.
    const clause = await prisma.contractClause.findUnique({
      where: { id: clauseId },
      select: {
        versionId: true, sortOrder: true, clauseType: true, isSubChunk: true,
        version: { select: { contract: { select: { orgId: true, id: true, ownerId: true, currentVersionId: true } } } },
      },
    })
    if (!clause || clause.version.contract.orgId !== orgId
      // X7 — an own-scope editor may only mark clauses on contracts it owns.
      || (req.permissionScope === 'own' && clause.version.contract.ownerId !== userId)) {
      return reply.status(404).send({ detail: 'Clause not found' })
    }

    // DD2 — a clause of a version the contract has moved on from (the page
    // held its id across an edit; the review drawer marks the clause it has
    // just rewritten) marks the same clause in the version the contract
    // stands on: same place, same type.
    const currentVersionId = clause.version.contract.currentVersionId
    const target = currentVersionId && clause.versionId !== currentVersionId && !clause.isSubChunk
      ? await prisma.contractClause.findFirst({
          where: { versionId: currentVersionId, isSubChunk: false, sortOrder: clause.sortOrder, clauseType: clause.clauseType },
          select: { id: true },
        })
      : null
    const data = {
      reviewState: state,
      reviewedAt: state === 'unreviewed' ? null : new Date(),
      reviewedById: state === 'unreviewed' ? null : userId,
    }
    const select = { id: true, reviewState: true, reviewedAt: true, reviewedById: true }
    const updated = await prisma.contractClause.update({ where: { id: clauseId }, data, select })
    const marked = target ? await prisma.contractClause.update({ where: { id: target.id }, data, select }) : null
    // docs/41 Part 4 — a clause marked "Not acceptable" (or acceptable again)
    // is a decision, on the contract's record (it wrote none).
    await createAuditEvent({
      orgId, userId, action: AuditAction.CLAUSE_REVIEWED, resourceType: 'contract', resourceId: clause.version.contract.id,
      metadata: { clauseId: marked?.id ?? clauseId, clauseType: clause.clauseType, state, decision: state === 'rejected' ? 'not_acceptable' : state, versionId: currentVersionId ?? clause.versionId },
    }).catch(err => req.log.warn({ err }, 'clause review not recorded'))
    if (marked) return reply.send({ ...marked, requestedId: clauseId })
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
    // docs/41 P0.6 — who did it, by name (the Activity tab showed user ids).
    const actorIds = [...new Set(events.map(e => e.userId).filter((u): u is string => !!u))]
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds }, orgId }, select: { id: true, name: true, email: true } })
      : []
    const nameOf = new Map(actors.map(a => [a.id, a.name || a.email]))

    return reply.send({ data: events.map(e => ({ ...e, userName: e.userId ? nameOf.get(e.userId) ?? null : null })) })
  })

  // ── Update metadata ──────────────────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    // Internal service calls use orgId='system' — find by id only
    const where = orgId === 'system'
      ? { id, deletedAt: null }
      : { id, orgId, deletedAt: null }

    const existing = await prisma.contract.findFirst({ where })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })

    // X23 — the extraction read the contract with round-trip tokens in place of
    // personal data (agent.worker.ts callAgents); put the values back in what
    // it writes here (summary, key terms and their quotes, findings), against
    // the version it read (?versionId=, from review.py), else the newest one.
    // Before validation: a date still tokenized fails the schema and loses the
    // whole update.
    let raw: unknown = req.body
    if (req.user.sub === 'system' && JSON.stringify(raw ?? null).includes('[PII:')) {
      const { versionId } = req.query as { versionId?: string }
      const version = (versionId && await prisma.contractVersion.findFirst({ where: { id: versionId, contractId: existing.id }, select: { plainText: true } }))
        || (existing.currentVersionId && await prisma.contractVersion.findUnique({ where: { id: existing.currentVersionId }, select: { plainText: true } }))
        || await prisma.contractVersion.findFirst({ where: { contractId: existing.id }, orderBy: { versionNumber: 'desc' }, select: { plainText: true } })
      // A redline analysis quotes both versions it compared (X27).
      const analysis = (raw as { metadata?: { _redlineAnalysis?: { v1Id?: unknown; v2Id?: unknown } } } | null)?.metadata?._redlineAnalysis
      const compared = analysis
        ? await prisma.contractVersion.findMany({
            where: { contractId: existing.id, id: { in: [analysis.v1Id, analysis.v2Id].filter((v): v is string => typeof v === 'string') } },
            select: { plainText: true, htmlContent: true },
          })
        : []
      // A12 — the exhibits it read after the contract's own text.
      const exhibits = (await readExhibits(existing.id)).map(e => e.text)
      const source = [version ? version.plainText : '', ...exhibits, ...compared.flatMap(versionForms)]
      raw = restorePii(raw, source, existing.id)
      const left = unresolvedPiiTokens(raw, source).length
      if (left) req.log.warn({ contractId: existing.id, left }, 'PII placeholders left unresolved in an agents-service update')
      // review.py makes dates full ISO, but it can't for a token; a restored
      // date-only value gets the same treatment here.
      if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>
        for (const k of ['effectiveDate', 'expiryDate']) {
          if (typeof r[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[k] as string)) r[k] = `${r[k]}T00:00:00.000Z`
        }
      }
    }
    const body = UpdateContractSchema.parse(raw)
    const bodyRec = body as Record<string, unknown>
    const requestedKeys = Object.keys(body)
    const isSystem = req.user.sub === 'system'

    // An analysis of a later version (the counterparty's return, a redline)
    // renamed the contract after the other side's document, and could retype
    // it. What the contract is called, what it is and who it's with are set
    // by the first version's analysis or by a person; later analyses leave them.
    // (Who it's with is a field now: the field store keeps it and records what
    // the later analysis read as a suggestion — docs/39 G1.)
    const laterVersion = isSystem && (await prisma.contractVersion.count({ where: { contractId: existing.id } })) > 1
    if (laterVersion) {
      delete bodyRec.title
      delete bodyRec.type
    }

    // X25 — a matter link must name a live matter of the contract's own org.
    // It was stored unchecked, and the other org's matter view listed this
    // contract (and new amendments inherited the foreign matter).
    if (body.matterId) {
      const matter = await prisma.matter.count({ where: { id: body.matterId, orgId: existing.orgId, deletedAt: null } })
      if (!matter) return reply.status(404).send({ detail: 'Matter not found' })
    }

    // Validate status transitions. docs/41 Part 18 — a status names the
    // stage it stands for, and the move is checked as one made by hand (X24:
    // one table with the agent's set_status; approval is the workflow's).
    const from = positionOf(existing)
    const target = body.status && body.status !== existing.status ? manualTarget(body.status) : null
    if (body.status && body.status !== existing.status) {
      if (!target) return reply.status(400).send({ detail: `Unknown status ${body.status}` })
      const refusal = manualRefusal({ stage: from.stage, state: from.stageState }, target)
      if (refusal) return reply.status(409).send({ detail: refusal })
    }

    // X42 — a user changing an approved contract's type, value or currency
    // changes what was approved: the approval's reset rules decide what is
    // asked again (after the write). (The agents service's extraction writes
    // these from the document, whose own changes reset approval where a
    // version is saved.)
    const num = (v: unknown) => (v == null ? null : Number(v))
    const day = (v: unknown) => (v == null || v === '' ? null : new Date(v as string).toISOString().slice(0, 10))
    const changedTerms = req.user.sub === 'system' ? [] : [
      ...(body.type !== undefined && body.type !== existing.type ? ['type'] : []),
      ...(body.value !== undefined && num(body.value) !== num(existing.value) ? ['value'] : []),
      ...(body.currency !== undefined && body.currency !== existing.currency ? ['currency'] : []),
      ...(body.effectiveDate !== undefined && day(body.effectiveDate) !== day(existing.effectiveDate) ? ['effectiveDate'] : []),
      ...(body.expiryDate !== undefined && day(body.expiryDate) !== day(existing.expiryDate) ? ['expiryDate'] : []),
      ...(body.counterpartyName !== undefined && (body.counterpartyName ?? null) !== existing.counterpartyName ? ['counterpartyName'] : []),
      ...(body.jurisdiction !== undefined && (body.jurisdiction ?? null) !== existing.jurisdiction ? ['jurisdiction'] : []),
    ]
    const termsChanged = changedTerms.length > 0 && from.stage === 'approve'
    if (termsChanged && target) {
      return reply.status(409).send({ detail: 'Changing the type, value or currency of a contract in approval asks for its approval again. Change the stage separately.' })
    }

    // Use the contract's real orgId (internal calls come in with orgId='system')
    const effectiveOrgId = existing.orgId

    // X26 follow-up — _splitInto is written by the binder split itself
    // (lib/binder-split.ts), never changed through here, not even by the
    // agents service, whose writes follow a model that read the document.
    // (redline.py writes the whole metadata back, so an unchanged value
    // passes.)
    if (body.metadata && '_splitInto' in body.metadata) {
      const stored = (existing.metadata as Record<string, unknown> | null)?._splitInto ?? null
      if (JSON.stringify(body.metadata._splitInto ?? null) !== JSON.stringify(stored)) {
        return reply.status(400).send({ detail: 'Metadata key "_splitInto" is set by the binder split only' })
      }
    }
    if (body.metadata && !isSystem) {
      // X26 — `_` keys are server state (analysis reports, the binder split's
      // _splitInto). A user who wrote _splitInto made the next re-split
      // soft-delete whatever it named. Only the agents service writes them.
      const reserved = Object.keys(body.metadata).filter(k => k.startsWith('_'))
      if (reserved.length) {
        return reply.status(400).send({ detail: `Metadata keys starting with "_" are set by the server: ${reserved.join(', ')}` })
      }
    }

    // docs/39 B1/G1/B5 — field values go through the field store. Extraction
    // may fill or refresh only what the AI owns: a value a person set or
    // checked keeps, and what the AI read lands beside it as a suggestion
    // (re-analysis used to overwrite corrections wholesale). A person's edit
    // through the API is recorded as theirs, verified, and re-indexes search.
    const customKeys = new Set((await prisma.contractFieldDefinition.findMany({
      where: { orgId: effectiveOrgId, deletedAt: null }, select: { fieldKey: true },
    })).map(d => d.fieldKey))
    let storeWrote = false
    if (isSystem) {
      const extracted = extractedFieldsFromPatch(bodyRec, customKeys)
      if (extracted.length) {
        const storedMeta = (existing.metadata as Record<string, unknown> | null) ?? {}
        const mode: ExtractionMode = storedMeta._extractionMode === 'fill_blanks' ? 'fill_blanks' : 'replace_ai'
        const { versionId } = req.query as { versionId?: string }
        // A9 — a Word file with tracked changes: values keep what's agreed, their changes' proposals beside them.
        const tracked = versionId ? await versionTrackedViews(existing.id, versionId) : null
        // A7 — a scan: a value from a page the OCR engine was unsure of asks to be checked against it.
        const readFrom = versionId ? await prisma.contractVersion.findFirst({ where: { id: versionId, contractId: existing.id }, select: { plainText: true, metadata: true } }) : null
        const pages = readFrom ? scanPagesOf(readFrom.metadata) : null
        const poorPageOf = pages && readFrom ? poorPageReader(readFrom.plainText, pages) : null
        const outcome = await applyExtraction(existing.id, extracted, { mode, versionId: versionId ?? null, protectKeys: laterVersion ? ['counterpartyName'] : [], tracked, poorPageOf })
        // G1 — a re-analysis that changed values the contract already had can be undone for 30 days.
        if (outcome?.changes.length) {
          await recordRun({
            orgId: existing.orgId, kind: 'reanalysis', contractId: existing.id,
            changes: outcome.changes.map(ch => ({ ...ch, contractId: existing.id })),
          }).catch(err => req.log.warn({ err }, '[contracts] re-analysis run not recorded'))
        }
        storeWrote = true
        // The mode a re-analysis asked for applies to this one write.
        body.metadata = { ...(body.metadata ?? {}), _extractionMode: null }
      }
    } else {
      const values = personFieldsFromPatch(bodyRec, customKeys)
      if (values.length) {
        const r = await setFieldValues({
          orgId: effectiveOrgId, contractId: existing.id, userId, values,
          audit: { source: 'api', ipAddress: req.ip },
          // X42 is decided above, with the status check that goes with it.
          skipApprovalReset: true,
        })
        if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
        storeWrote = true
      }
    }
    for (const k of STORE_OWNED_PATCH_KEYS) delete bodyRec[k]
    if (body.metadata) {
      for (const k of STORE_OWNED_METADATA_KEYS) delete body.metadata[k]
      for (const k of customKeys) delete body.metadata[k]
    }

    // C4 — metadata is MERGED into what is stored, never replaced. Several
    // writers own different keys (extraction, compliance, playbook review,
    // binder split, redline); a JSON column update replaces the whole object,
    // so re-analysis used to erase every report it did not itself produce.
    // A null value deletes its key (JSON merge patch, top level).
    const data: Record<string, unknown> = { ...body }
    // The stage moves through lib/lifecycle.ts, after the other changes.
    delete data.status
    if (body.metadata) {
      // The field store may just have rewritten metadata: merge onto what is stored now.
      const base = storeWrote
        ? (await prisma.contract.findUnique({ where: { id: existing.id }, select: { metadata: true } }))?.metadata
        : existing.metadata
      const merged: Record<string, unknown> = { ...((base as Record<string, unknown> | null) ?? {}) }
      for (const [k, v] of Object.entries(body.metadata)) {
        if (v === null) delete merged[k]
        else merged[k] = v
      }
      data.metadata = merged
    }

    let updated = await prisma.contract.update({ where: { id }, data: data as Prisma.ContractUncheckedUpdateInput })
    if (target) {
      const moved = await transition({
        orgId: effectiveOrgId, contractId: id, to: { stage: target.stage, state: target.state },
        source: manualSource({ stage: from.stage, state: from.stageState }, target),
        userId: userId === 'system' ? null : userId, versionId: existing.currentVersionId,
      })
      if (!moved.ok) return reply.status(moved.status).send({ detail: moved.refusal })
      updated = await prisma.contract.findUniqueOrThrow({ where: { id } })
    }
    // X42 — what an approval judged changed: its reset rules decide.
    if (termsChanged) {
      await onApprovalChange({ orgId: effectiveOrgId, contractId: id, fields: changedTerms, source: 'edit', userId: userId === 'system' ? null : userId })
      updated = await prisma.contract.findUniqueOrThrow({ where: { id } })
    }

    // Re-index if searchable fields changed. indexContract is a full-document
    // overwrite (elasticsearch.ts), so we must carry the existing full text and
    // the other searchable fields through — otherwise a metadata-only PATCH
    // (e.g. a title edit) would wipe plainText and blank the BM25 body. (Wave 3.1)
    // docs/39 B5 — a changed field value (dates, value, custom fields) is
    // searchable too: the assistant's portfolio answers read the index.
    if (body.title || body.status || body.tags || storeWrote) {
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
        riskScore: normalizeRiskScore(updated.riskScore) ?? undefined,
        effectiveDate: updated.effectiveDate?.toISOString(),
        expiryDate: updated.expiryDate?.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        keyTerms: updated.keyTerms as Record<string, unknown>,
        metadata: updated.metadata as Record<string, unknown>,
      }).catch(() => {})
    }

    // H2 — advertised to subscribers since P10A, never emitted until now.
    fireWebhook(effectiveOrgId, 'contract.updated', {
      contractId: id, title: updated.title, status: updated.status,
      changes: requestedKeys, source: userId === 'system' ? 'system' : 'user',
    })

    // docs/41 P0.10 — a stage move is recorded as one (lib/lifecycle.ts);
    // anything else as an update.
    if (!target) {
      await createAuditEvent({
        orgId: effectiveOrgId,
        userId: userId === 'system' ? undefined : userId,
        action: AuditAction.CONTRACT_UPDATED,
        resourceType: 'contract',
        resourceId: id,
        metadata: { changes: requestedKeys },
      })
    }

    return reply.send(withNormalizedRisk(updated))
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

    // DD4 — analyse the version the contract stands on, not the newest (an
    // undone redline).
    const version = await standingVersion(contract.id, contract.currentVersionId)

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
        extractedTerms:    draftCtx?.extractedTerms as Record<string, unknown> | undefined,
        templateId:        draftCtx?.templateId as string | undefined,
        slotChoices:       draftCtx?.slotChoices as Record<string, string> | undefined,
      })
      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'DRAFTING', mode: 'draft' })
    }

    const { full } = req.query as { full?: string }
    // docs/41 P1 — a person asked again: a run of its own.
    await startRun({ orgId, contractId: id, versionId: version.id, reason: 'retry' })
    // docs/39 G1 — what the new analysis may write: `replace_ai` refreshes the
    // values the AI owns, `fill_blanks` only fills empty ones. Neither touches
    // a value a person set or checked (the field store keeps those and records
    // what the AI read as a suggestion). The extraction's write reads it once.
    const requested = (req.body as { fields?: unknown } | undefined)?.fields ?? (req.query as { fields?: unknown }).fields
    const fieldsMode: ExtractionMode = requested === 'fill_blanks' ? 'fill_blanks' : 'replace_ai'
    const withMode = { ...((contract.metadata as Record<string, unknown> | null) ?? {}), _extractionMode: fieldsMode }

    if ((full === 'true' || !version.plainText) && version.s3Key) {
      // Full reprocess — re-parse from S3 and run the entire pipeline

      // Derive filename from mimeType (extractDocument uses it for format routing)
      const filename = version.mimeType === 'application/pdf' ? 'contract.pdf'
        : version.mimeType?.includes('wordprocessingml') ? 'contract.docx'
        : 'contract.txt'

      // Reset AI metadata so the UI shows fresh in-progress state.
      // Do NOT clear plainText/htmlContent — stale queued jobs read from the DB
      // and would fail with "No plainText" if we clear it before parse finishes.
      // docs/39 G1 — nor the field values: they emptied keyTerms and
      // fieldConfidence here, so every correction and verification was lost.
      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'PENDING', riskScore: null, summary: null, metadata: withMode as never },
      })

      queueParseDocument({
        contractId: id,
        versionId:  version.id,
        s3Key:      version.s3Key,
        mimeType:   version.mimeType ?? 'application/pdf',
        orgId,
        filename,
      })

      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'PENDING', mode: 'full', fields: fieldsMode })

    } else {
      // Smart resume — re-classify + re-extract (keeps parsed text, re-runs AI from scratch)
      await prisma.contract.update({
        where: { id },
        data: { analysisStatus: 'CLASSIFYING', metadata: withMode as never },
      })

      queueClassifyDocument({ contractId: id, versionId: version.id, orgId })

      return reply.send({ status: 'queued', contractId: id, analysisStatus: 'CLASSIFYING', mode: 'smart', fields: fieldsMode })
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
    await failOpenRuns([id], 'Analysis cancelled by user.')

    return reply.send({ status: 'cancelled', contractId: id, analysisStatus: 'FAILED' })
  })

  // ── Retype (correct contract type → re-extract with corrected type context) ──
  app.post('/:id/retype', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const { contractType, reread } = req.body as { contractType: string; reread?: boolean }

    if (!contractType) return reply.status(400).send({ detail: 'contractType is required' })
    if (!(Object.values(ContractType) as string[]).includes(contractType)) {
      return reply.status(400).send({ detail: `Unknown contract type: ${contractType}` })
    }

    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    // DD4 — the version the contract stands on, not the newest.
    const standing = await standingVersion(contract.id, contract.currentVersionId)
    if (!standing?.plainText) {
      return reply.status(422).send({ detail: 'No extracted text available.' })
    }

    // Update type immediately so UI shows it. X56 — X42's rule: a new type
    // changes what was approved, so an approved contract goes back to DRAFT
    // for approval again, and the change is on the record.
    const retyped = contractType !== contract.type
    // docs/39 A13 — a person's type: a re-analysis keeps it, and an AI's
    // opinion that it's another type is settled. Only the new type's own
    // fields are read (lib/type-fields-read.ts), not the whole contract again
    // — or read again (`reread`), after a read that failed.
    const toRead = (retyped || !!reread) && typeFieldsFor(contractType).length > 0
    const { _typeOpinion: _settled, _typeFieldsRead: _earlier, ...rest } = (contract.metadata as Record<string, unknown> | null) ?? {}
    const md = { ...rest, _typeSource: 'person', ...(toRead && { _typeFieldsRead: typeFieldsMark(contractType) }) }
    await prisma.contract.update({
      where: { id },
      data: { type: contractType, metadata: md as never, ...(toRead && { analysisStatus: 'ANALYZING' }) },
    })
    // X42/X56, docs/41 Part 18 — a new type: the approval's reset rules decide what is asked again.
    const statusMove = async () => {
      await onApprovalChange({ orgId, contractId: id, fields: ['type'], source: 'edit', userId: req.user.sub })
      const now = (await prisma.contract.findUnique({ where: { id }, select: { status: true } }))?.status
      return now && now !== contract.status ? { statusFrom: contract.status, statusTo: now } : {}
    }
    if (retyped) {
      await createAuditEvent({
        orgId, userId: req.user.sub, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: id,
        metadata: { action: 'retype', typeFrom: contract.type, typeTo: contractType, ...(await statusMove()) },
      })
    }
    if (toRead) queueExtractTypeFields({ contractId: id, orgId, contractType })

    return reply.send({ status: toRead ? 'queued' : 'done', contractId: id, contractType, analysisStatus: toRead ? 'ANALYZING' : contract.analysisStatus })
  })

  // ── Internal: trigger chunk-and-index (called by agents after clauses stored) ─
  app.post('/:id/versions/:versionId/chunk', async (req, reply) => {
    // Internal-only — validated via x-internal-secret header. X35: an unset
    // secret refuses everyone (a missing header used to equal it).
    const expected = process.env.INTERNAL_SERVICE_SECRET
    if (!expected || req.headers['x-internal-secret'] !== expected) {
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

    // X27 — the clauses go to the model under the org's PII policy, as
    // round-trip tokens (values found against the whole text of the versions
    // the clauses come from, scoped to this request); the answer comes back
    // to the user with the values.
    const scope = randomUUID()
    const documents = (await prisma.contractVersion.findMany({
      where:  { id: { in: [...new Set(clauseMatches.map(m => m.versionId))] }, contractId: id },
      select: { plainText: true },
    })).map(v => v.plainText)
    const sent = await redactJson(orgId, clauseMatches, {
      surface: 'contract_ask', contractId: id, roundTrip: scope, valuesFrom: [clauseMatches.map(m => m.content), documents],
    })
    const agentRes = await modelFetch(
      `${process.env.AGENTS_URL ?? 'http://localhost:8002'}/agent/ask`,
      {
        method: 'POST',
        // X55 — the agents service refuses any call without the shared secret,
        // so without it every question here answered "Agent unavailable".
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
        body: JSON.stringify({ question, orgId, contractId: id, clauseMatches: sent }),
      },
      { orgId, surface: 'contract_ask', contractId: id, userAuthored: ['question'] },
    ).catch(() => null)

    if (!agentRes?.ok) {
      return reply.send({ answer: null, sources: clauseMatches, message: 'Agent unavailable — showing relevant clauses' })
    }

    const agentData = restorePii(await agentRes.json(), [clauseMatches.map(m => m.content), documents], scope)
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

    const selfRiskScore = normalizeRiskScore(contract.riskScore)

    // Query-contract avg embedding, over its effective version's clauses (X17:
    // it averaged every version's, so superseded text weighed in — C11's rule).
    const selfAvg = await prisma.$queryRaw<Array<{ avg_vec: string | null }>>`
      SELECT AVG(cc.embedding)::text AS avg_vec
      FROM   contract_clauses cc
      JOIN   (${effectiveVersionsSql(orgId, id)}) ev ON ev.id = cc."versionId"
      WHERE  cc.embedding IS NOT NULL
             AND cc."isSubChunk" = FALSE
    `

    const avgVecText = selfAvg[0]?.avg_vec
    if (!avgVecText) {
      return reply.send({
        data:               [],
        message:            'No embeddings yet for this contract — precedents unavailable',
        selfRiskScore,
        peerAvgRiskScore:   null,
        riskDeltaLabel:     null,
      })
    }

    // Top-3 signed peers of the same type by cosine similarity on avg
    // clause embedding. Excludes this contract and unsigned drafts. X7 — an
    // own-scope caller's peers come only from contracts they own.
    const peerOwnerId = req.permissionScope === 'own' ? req.user.sub : null
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
        -- X17: one version per peer, chosen among the candidates only (the
        -- DISTINCT ON would otherwise rank every version in the org).
        JOIN   (${effectiveVersionsSql(orgId, undefined, Prisma.sql`
                  AND c2."deletedAt" IS NULL AND c2."diligenceRoomId" IS NULL
                  AND c2.status IN ('APPROVED','EXECUTED') AND c2.type = ${contract.type}`)}) ev ON ev.id = cv.id
        JOIN   contract_clauses cc  ON cc."versionId"  = cv.id
        WHERE  c."orgId"       = ${orgId}
               AND c.id        <> ${id}
               AND c."deletedAt" IS NULL
               AND c."diligenceRoomId" IS NULL   -- X17: a target's contracts are not our precedents
               AND c.status IN ('APPROVED','EXECUTED')
               AND c.type      = ${contract.type}
               AND (${peerOwnerId}::text IS NULL OR c."ownerId" = ${peerOwnerId}::text)
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

    const peerRiskScores = peers
      .map(p => normalizeRiskScore(p.risk_score))
      .filter((x): x is number => x != null)
    const peerAvgRiskScore = peerRiskScores.length
      ? peerRiskScores.reduce((a, b) => a + b, 0) / peerRiskScores.length
      : null

    // "20% higher risk than peer avg" label
    let riskDeltaLabel: string | null = null
    if (selfRiskScore != null && peerAvgRiskScore != null) {
      const diff = selfRiskScore - peerAvgRiskScore
      // Floor the divisor at one point of the 0-100 scale so a peer group that
      // averages zero risk yields a large-but-finite delta, not a division blowup.
      const pct = Math.round((Math.abs(diff) / Math.max(1, peerAvgRiskScore)) * 100)
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
        riskScore:    normalizeRiskScore(p.risk_score),
        similarity:   Number(p.similarity),
      })),
      selfRiskScore,
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
          select: { id: true, title: true, type: true, status: true, relationshipType: true, ownerId: true, orgId: true, deletedAt: true, metadata: true },
        },
        amendments: {
          where: { deletedAt: null, orgId, ...ownContractWhere(req) },
          select: { id: true, title: true, type: true, status: true, relationshipType: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    // X7 — an own-scope caller sees only the relatives it owns.
    const p = contract.parentContract
    const parent = p && p.orgId === orgId && !p.deletedAt && (req.permissionScope !== 'own' || p.ownerId === req.user.sub)
      ? { id: p.id, title: p.title, type: p.type, status: p.status, relationshipType: p.relationshipType }
      : null

    // Siblings: other children of the same parent (excluding this contract)
    const siblings = contract.parentContractId
      ? await prisma.contract.findMany({
          where: {
            parentContractId: contract.parentContractId,
            id: { not: id },
            orgId,
            deletedAt: null,
            ...ownContractWhere(req),
          },
          select: { id: true, title: true, type: true, status: true, relationshipType: true },
        })
      : []

    // docs/41 P0.9 — carved out of a scanned bundle by the binder split (the
    // parent lists it in _splitInto, lib/binder-split.ts), as opposed to an
    // amendment, an exhibit or a contract linked by hand.
    const splitInto = (p?.metadata as { _splitInto?: unknown } | null)?._splitInto
    const splitFromParent = !!parent && contract.relationshipType === 'exhibit_only'
      && Array.isArray(splitInto) && splitInto.includes(contract.id)

    return reply.send({
      parent,
      children: contract.amendments,
      siblings,
      relationshipType: contract.relationshipType,
      splitFromParent,
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
        currency: true, matterId: true, diligenceRoomId: true,
      },
    })
    if (!parent) return reply.status(404).send({ detail: 'Parent contract not found' })
    // X45 — an API key's amendment belongs to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

    const relationshipType = (body.relationshipType ?? 'amendment').toLowerCase()
    const ALLOWED = ['amendment', 'sow', 'order_form', 'renewal', 'exhibit_only']
    if (!ALLOWED.includes(relationshipType)) {
      return reply.status(400).send({ detail: `relationshipType must be one of ${ALLOWED.join(', ')}` })
    }

    // X25 — inherit the parent's matter only if it is a live matter of this
    // org: a link stored before the fix could name another org's.
    const matterId = parent.matterId && await prisma.matter.count({ where: { id: parent.matterId, orgId, deletedAt: null } })
      ? parent.matterId : null

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
    // amendment draft has nothing to analyse, so it is NOT_ANALYSED up
    // front (docs/41 P0.1: never DONE unread);
    // the user's upload / paste flow will re-queue parse if/when a real
    // document attaches. We also create an empty initial ContractVersion
    // so the editor + risks panels have a row to write into.
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    const created = await prisma.contract.create({
      data: {
        orgId, ownerId,
        title,
        type,
        ...initialStage('DRAFT'),
        analysisStatus: NOT_ANALYSED,
        parentContractId: parent.id,
        relationshipType,
        counterpartyId:   parent.counterpartyId,
        counterpartyName: parent.counterpartyName,
        currency:         body.currency ?? parent.currency ?? 'USD',
        value:            value != null && !isNaN(value) ? value : null,
        effectiveDate:    body.effectiveDate ? new Date(body.effectiveDate) : undefined,
        expiryDate:       body.expiryDate ? new Date(body.expiryDate) : undefined,
        matterId:         matterId ?? undefined,
        // C11 — an amendment to a diligence-room document stays in that room.
        diligenceRoomId:  parent.diligenceRoomId ?? undefined,
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
    // H2 — `amendment.created` was advertised but never emitted. This route
    // creates every related document (amendment, SOW, order form, renewal,
    // exhibit); the event names the relationship so subscribers can filter.
    fireWebhook(orgId, 'amendment.created', {
      contractId: created.id, parentContractId: parent.id, relationshipType,
      title: created.title, type: created.type,
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
    // S3 — attachments are served back by presigned URL with the stored type.
    const checked = checkUpload(fileBuffer, mimeType, ATTACHMENT_TYPES)
    if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
    mimeType = checked.mimeType

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
      { filename, s3Key, mimeType, size: fileBuffer.byteLength, label: label || filename, attachedAt: new Date().toISOString() },
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
    // docs/39 A12 — read as part of the contract.
    queueReadExhibit({ orgId, contractId: id, s3Key })

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
    // docs/39 A12 — no longer part of the contract: its text isn't read with it.
    const removed = current[idx] as { s3Key?: unknown } | undefined
    if (typeof removed?.s3Key === 'string') await prisma.contractExhibit.deleteMany({ where: { contractId: id, orgId, s3Key: removed.s3Key } })

    return reply.send({ attachments: updated })
  })

  // ── docs/39 A12 — read an attachment as part of the contract (one from before attachments were read) ──
  app.post('/:id/attachments/:index/read', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string }
    const { orgId } = req.user
    const existing = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { attachments: true } })
    if (!existing) return reply.status(404).send({ detail: 'Contract not found' })
    const att = attachmentsOf(existing.attachments)[parseInt(index, 10)]
    if (!att) return reply.status(400).send({ detail: 'Attachment index out of range' })
    if (!EXHIBIT_READABLE.has(att.mimeType)) return reply.status(422).send({ detail: 'A spreadsheet isn’t read as part of the contract.' })
    queueReadExhibit({ orgId, contractId: id, s3Key: att.s3Key })
    return reply.status(202).send({ status: 'queued' })
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
        ResponseContentType: servableContentType(attachment.mimeType),
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

    // C10 — say now, not after three failed retries, when the split can't run.
    const original = await prisma.contractVersion.findFirst({
      where: { contractId: id }, orderBy: { createdAt: 'asc' }, select: { mimeType: true },
    })
    if (original?.mimeType && original.mimeType !== 'application/pdf') {
      return reply.status(422).send({ detail: SPLIT_REQUIRES_PDF })
    }
    const blocker = resplitBlocker(await previousSplitChildren(id, orgId))
    if (blocker) return reply.status(409).send({ detail: blocker })

    // Queue the split job — worker handles S3 download, slicing, child creation
    // (and replaces any children from a previous split). X45 — a child's owner
    // is a user, and a key is none: a split a key asks for leaves the children
    // with the binder's owner, as the automatic split does, and records the
    // key as their creator.
    const byKey = req.user.sub.startsWith('apikey:')
    queueSplitBinder({ contractId: id, orgId, userId, splits, ...(byKey ? { ownerId: contract.ownerId } : {}) })

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

    if (format === 'pdf') {
      // X11 — the request body is arbitrary HTML, and this rendered it as
      // given: Gotenberg fetched what it named from inside the network and
      // printed the response into the PDF returned here. It now goes through
      // the one sanitising renderer (this fetch also skipped the Cloud Run
      // auth header and defaulted to the API's own port).
      let pdfBuffer: Buffer
      try { pdfBuffer = await renderHtmlToPdf(html) }
      catch (err) {
        if (err instanceof RenderRefusedError) return reply.status(422).send({ detail: err.message })
        app.log.error({ err }, 'Gotenberg PDF conversion failed')
        return reply.status(502).send({ detail: 'PDF generation failed' })
      }
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="${filename}.pdf"`)
      return reply.send(pdfBuffer)
    }

    if (format === 'docx') {
      // Was: POST the HTML to Gotenberg's /forms/libreoffice/convert -- a
      // document-to-PDF route -- and label the PDF that came back as a Word
      // document. Word refuses to open those. Now produced by the real OOXML
      // writer added for the tracked-changes export.
      try {
        const bytes = await generatePlainDocx(html, { title: filename || 'Contract' })
        reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        reply.header('Content-Disposition', `attachment; filename="${filename}.docx"`)
        return reply.send(Buffer.from(bytes))
      } catch (err) {
        app.log.error({ err }, 'DOCX generation failed')
        return reply.status(502).send({ detail: 'DOCX generation failed' })
      }
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
    const pending = () => reply.status(409).send({
      error:  'Version still processing',
      detail: 'This version is still being extracted. The comparison will be available once processing finishes.',
      pendingVersionIds,
    })
    const tooLarge = () => reply.status(422).send({ error: 'Comparison too large', detail: new DiffTooLargeError().message })

    // X27 — the agents service reads diffs for the redline analysis, which a
    // model writes: the org's PII policy applies (round-trip tokens, put back
    // when the analysis is stored through PATCH /:id). Tokens go into each
    // version BEFORE diffing: htmldiff splits words at '-' and '.', so a value
    // changed between versions came out as `123-45-<del>6789</del>…`, which no
    // replacement over the finished diff could find. Not cached (users' diffs
    // are): the tokens are the agents' alone.
    if (req.user.sub === 'system') {
      if (pendingVersionIds.length > 0) return pending()
      const [h1, h2, t1, t2] = await redactJson(contract.orgId, [plainSpacesHtml(v1.htmlContent), plainSpacesHtml(v2.htmlContent), v1.plainText, v2.plainText], {
        surface: 'redline_diff', contractId, roundTrip: contractId, valuesFrom: [...versionForms(v1), ...versionForms(v2)],
      })
      // The HTML diff, as users get it; the plain text's when the markup
      // splits a value the replacement couldn't reach.
      const para = (t: string) => t.split(/\n+/).map(l => `<p>${escapeText(l)}</p>`).join('')
      const [a, b] = await getOrgPiiMode(contract.orgId) !== 'off' && [h1, h2].some(valueLeftInMarkup)
        ? [para(t1), para(t2)]
        : [h1, h2]
      const diffHtml = await withWholeTokens([a, b], ([x, y]) => htmlDiff(x, y))
        .catch(err => { if (err instanceof DiffTooLargeError) return null; throw err })
      if (diffHtml === null) return tooLarge()
      const stats = { insertions: (diffHtml.match(/<ins[\s>]/g) ?? []).length, deletions: (diffHtml.match(/<del[\s>]/g) ?? []).length }
      return reply.send({ diffHtml, stats, v1Id, v2Id })
    }

    const cached = await prisma.versionDiffCache.findUnique({ where: { v1Id_v2Id: { v1Id, v2Id } } })
    if (cached) return reply.send({ diffHtml: cached.diffHtml, stats: cached.stats, v1Id, v2Id })

    if (pendingVersionIds.length > 0) return pending()

    // X32 — computed on a worker thread, within a time limit.
    const computed = await computeVersionDiff(v1.htmlContent, v2.htmlContent)
      .catch(err => { if (err instanceof DiffTooLargeError) return null; throw err })
    if (!computed) return tooLarge()
    const { diffHtml, stats } = computed

    await prisma.versionDiffCache.create({ data: { contractId, v1Id, v2Id, diffHtml, stats: { ...stats } } })

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
      // X32 — the diff it is built from ran past its time limit.
      if (err instanceof DiffTooLargeError) return reply.status(422).send({ error: 'Comparison too large', detail: msg })
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
      select: { id: true, currentVersionId: true, metadata: true, analysisStatus: true, analysisError: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    // docs/41 P0.7 — the redline reads the clauses the analysis found, of the
    // version the contract stands on. Without them it answered 400 (no
    // current version) with nothing shown, or ran over zero clauses and said
    // "No clause deviated from the playbook".
    const state = analysisState(contract)
    if (!contract.currentVersionId || state.kind !== 'done') {
      return reply.status(409).send({
        code: 'NOT_ANALYSED',
        analysis: state,
        detail: state.kind === 'running' ? 'This contract is still being analysed. The redline can run once it is done.'
          : state.kind === 'stale' ? 'The document changed after it was analysed. Analyse this version first, then run the redline.'
          : state.kind === 'failed' ? 'This contract’s analysis failed. Analyse it again, then run the redline.'
          : 'This contract hasn’t been analysed yet. Analyse it first, then run the redline.',
      })
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
      { proposals?: Array<{ clauseId: string; proposedText?: string; rationale?: string; changes?: Array<{ before: string; after: string; reason?: string }> }> } | undefined
    if (!staged?.proposals?.length) {
      return reply.status(409).send({ detail: 'No staged redline to apply', code: 'NO_STAGED_REDLINE' })
    }

    // Only ever apply text that was actually staged. Taking proposedText from
    // the request would let a client apply language nobody reviewed.
    const byId = new Map(staged.proposals.filter(p => p.proposedText).map(p => [p.clauseId, p]))
    const changes = accepted
      .map(id => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map(p => ({ clauseId: p.clauseId, proposedText: p.proposedText!, rationale: p.rationale, changes: p.changes }))

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
      select: { id: true, metadata: true, type: true, currentVersionId: true, playbookId: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const review = (contract.metadata as Record<string, unknown> | null)?._playbookReview as
      { findings?: Array<Record<string, unknown>>; versionId?: string } | undefined
    if (!review) {
      // V1 — say WHY there is no review: the job skips contracts whose type
      // has no playbook positions (same playbook as handlePlaybookReview).
      const { where: positionScope } = await contractPlaybook(orgId, contract)
      const playbookPositionCount = positionScope ? await prisma.playbookPosition.count({ where: positionScope }) : 0
      return reply.status(404).send({
        detail: playbookPositionCount === 0
          ? `No playbook positions apply to ${contract.type} contracts, so this contract has not been reviewed against a playbook.`
          : 'No playbook review has been run for this contract yet. It runs automatically after extraction.',
        reason: playbookPositionCount === 0 ? 'no_positions' : 'not_run',
        playbookPositionCount,
        contractType: contract.type,
      })
    }

    // V1 — findings in DOCUMENT order (the model returns them in its own
    // order), each joined to its clause's position, section and excerpt so
    // the rail can link to it.
    const findings = Array.isArray(review.findings) ? review.findings : []
    const clauseIds = findings.map(f => f.clauseId).filter((x): x is string => typeof x === 'string')
    const clauses = clauseIds.length
      ? await prisma.contractClause.findMany({
          where:  { id: { in: clauseIds }, version: { contractId } },
          select: { id: true, sortOrder: true, sectionRef: true, content: true, clauseType: true },
        })
      : []
    const byId = new Map(clauses.map(c => [c.id, c]))
    // DD2 — a review of an earlier version, read on the version the contract
    // stands on: each finding follows its clause there (same place, same
    // type), so its link opens the clause as it now reads. The page's clauses
    // are the current version's; the reviewed ones' ids are not among them.
    const now = new Map<string, (typeof clauses)[number]>()
    if (review.versionId && contract.currentVersionId && review.versionId !== contract.currentVersionId) {
      const rows = await prisma.contractClause.findMany({
        where:  { versionId: contract.currentVersionId, isSubChunk: false },
        select: { id: true, sortOrder: true, sectionRef: true, content: true, clauseType: true },
      })
      for (const r of rows) now.set(`${r.sortOrder}|${r.clauseType}`, r)
    }
    const ordered = findings
      .map(f => {
        const reviewed = typeof f.clauseId === 'string' ? byId.get(f.clauseId) : undefined
        const current = reviewed ? now.get(`${reviewed.sortOrder}|${reviewed.clauseType}`) : undefined
        const c = current ?? reviewed
        return {
          ...f,
          ...(current && { clauseId: current.id }),
          sortOrder:  c?.sortOrder ?? null,
          sectionRef: c?.sectionRef ?? null,
          excerpt:    c ? c.content.slice(0, 240) : null,
          // The clause's words changed after the review: its finding may no longer hold.
          ...(current && reviewed && current.content !== reviewed.content && { changedSinceReview: true }),
        }
      })
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER))
    return reply.send({ ...review, findings: ordered })
  })

  // ── GET /:id/playbook (docs/41 P1, Part 3) ─────────────────────────────
  // The playbook this contract is reviewed against, and why: chosen on it,
  // the default for its type, the only one, or "choose one" — never a guess.
  app.get('/:id/playbook', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, type: true, playbookId: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const { resolution, where } = await contractPlaybook(orgId, contract)
    const positionCount = where ? await prisma.playbookPosition.count({ where }) : 0
    return reply.send({ ...resolution, positionCount, contractType: contract.type })
  })

  // ── PUT /:id/playbook — choose this contract's playbook (null: the default again)
  app.put('/:id/playbook', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const { playbookId } = (req.body ?? {}) as { playbookId?: string | null }
    const contract = await prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, type: true, playbookId: true } })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    if (playbookId && !await prisma.playbook.findFirst({ where: { id: playbookId, orgId, deletedAt: null }, select: { id: true } })) {
      return reply.status(404).send({ detail: 'Playbook not found' })
    }
    await prisma.contract.update({ where: { id }, data: { playbookId: playbookId ?? null } })
    createAuditEvent({ orgId, userId, action: AuditAction.PLAYBOOK_CHANGED, resourceType: 'contract', resourceId: id, metadata: { from: contract.playbookId, to: playbookId ?? null } }).catch(() => {})
    const { resolution } = await contractPlaybook(orgId, { ...contract, playbookId: playbookId ?? null })
    return reply.send(resolution)
  })

  // ── GET /:id/checks (docs/41 P0.2/P0.3) ────────────────────────────────────
  // The deterministic checks on the version the contract stands on: what its
  // analysis describes, the presence findings (required clauses not detected,
  // clauses deleted or cut since the version analysed before), and whether
  // the approval recommendation may say "Ready to approve" — with the reasons
  // it may not. No model is called.
  app.get('/:id/checks', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, analysisStatus: true, analysisError: true, currentVersionId: true, metadata: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })
    const [guard, choices] = await Promise.all([recommendationGuard(id, orgId), openChoices(id)])
    return reply.send({
      analysis: analysisState(contract),
      ready: guard.passes,
      reasons: guard.reasons,
      // The clause review's findings: drafting and compliance ones are the Review panel's groups.
      findings: guard.findings.filter(f => f.kind !== 'drafting' && f.kind !== 'compliance'),
      // docs/41 P0.4 — terms the draft left to choose; it can't be sent until they are.
      openChoices: choices,
    })
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
  // docs/41 Parts 4, 6 — one implementation with the assistant's
  // approval_route (lib/approval-flow.ts): a request for approval of the
  // version the contract stands on. A resubmission after a return is a new
  // request; the history keeps both.
  app.post('/:id/submit-approval', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id: contractId } = req.params as { id: string }
    const { workflowDefinitionId, comment } = (req.body ?? {}) as { workflowDefinitionId?: string; comment?: string }
    const r = await submitForApproval({ orgId, contractId, userId, workflowDefinitionId, comment })
    if (!r.ok) return reply.status(r.status).send({ error: r.error, ...(r.instanceId && { instanceId: r.instanceId }) })
    if (r.autoApproved) return reply.status(201).send({ instanceId: r.instanceId, status: 'AUTO_APPROVED', autoApproved: true })
    return reply.status(201).send({
      instanceId:           r.instanceId,
      contractId,
      status:               'PENDING',
      autoApproved:         false,
      workflowDefinitionId: r.workflowDefinitionId,
      currentStepOrder:     r.currentStepOrder,
      steps: r.steps.map(step => ({
        id:             step.id,
        stepOrder:      r.currentStepOrder,
        stepName:       r.stepName,
        approverId:     step.approverId,
        approverRoleId: step.approverRoleId,
        status:         'PENDING',
        escalateAt:     r.escalateAt,
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
      // docs/39 G4 — suggestions and confirmed ones; a dismissed suggestion is gone.
      where: { contractId: id, reviewState: { not: 'DISMISSED' } },
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
      // docs/41 Part 9 — the review's compliance findings, from the new results.
      const { storeComplianceFindings } = await import('../lib/compliance-findings.js')
      await storeComplianceFindings(orgId, id)
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

    const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
    const pyRes = await modelFetch(`${agentsUrl}/renewal_advice`, {
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
    }, { orgId, surface: 'renewal_advice', contractId: contract.id, userId: req.user.sub })
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
