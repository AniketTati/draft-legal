import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { createAuditEvent } from '../lib/audit.js'
import { s3, S3_BUCKET } from '../lib/storage.js'
import { CreateRequestSchema, UpdateRequestSchema, AuditAction, requestTransitionRefusal } from '@clm/types'
import { transition } from '../lib/lifecycle.js'
import { queueClassifyRequest, queueParseDocument, queueDraftContract, queueNotification } from '../lib/queue.js'
import { requestTerms } from '../lib/draft-save.js'
import { z } from 'zod'
import { chooseTemplate } from '../lib/draft-plan.js'
import { planFromRequest, type RequestDraftContext } from '../lib/request-draft.js'
import { draftSource } from '../lib/template-snapshot.js'

/** docs/41 Part 1 — what a requester picked for the draft: a template, and clause choices. */
interface DraftChoices { templateId?: string; slots?: Record<string, string> }
const draftChoicesOf = (metadata: unknown): DraftChoices => ((metadata ?? {}) as { _draftChoices?: DraftChoices })._draftChoices ?? {}

const DraftChoicesSchema = z.object({
  templateId: z.string().max(64).nullable().optional(),
  /** familyId → variant id; null clears a choice. */
  slots: z.record(z.string().max(64), z.string().max(64).nullable()).optional(),
})

/** The drafting context a request gives, before and at convert. */
function requestContext(request: { title: string; description: string | null; type: string; counterpartyName: string | null; estimatedValue: unknown; metadata: unknown }): RequestDraftContext {
  const meta = (request.metadata ?? {}) as Record<string, unknown>
  const aiTerms = (meta._aiClassification as { extractedTerms?: Record<string, unknown> } | undefined)?.extractedTerms
  const choices = draftChoicesOf(request.metadata)
  const terms = requestTerms(aiTerms)
  return {
    requestTitle: request.title,
    requestDescription: request.description ?? (meta.description as string | undefined) ?? request.title,
    contractType: request.type,
    counterpartyName: request.counterpartyName ?? undefined,
    estimatedValue: request.estimatedValue != null ? Number(request.estimatedValue) : undefined,
    ...(Object.keys(terms).length && { extractedTerms: terms }),
    ...(choices.templateId && { templateId: choices.templateId }),
    ...(choices.slots && Object.keys(choices.slots).length && { slotChoices: choices.slots }),
  }
}
import { indexContract } from '../lib/elasticsearch.js'
import { checkUpload, PDF_OR_DOCX } from '../lib/file-type.js'
import { guardOwnScopeRoutes, ownScopeGuard } from '../lib/own-scope-guard.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'

export async function requestRoutes(app: FastifyInstance) {
  // X7 — the list honoured `own` (requestedById) but GET/PATCH/convert by id
  // did not, so a SALES_REP could read any request in the org.
  guardOwnScopeRoutes(app, /\/:id(\/|$)/, ownScopeGuard(
    async (req, id) => (await prisma.contractRequest.count({ where: { id, orgId: req.user.orgId, requestedById: req.user.sub } })) > 0,
    'Request not found',
  ))

  // GET /api/v1/requests
  app.get('/', { preHandler: requirePermission('view', 'request') }, async (req, reply) => {
    const query = req.query as { status?: string; cursor?: string; limit?: string; search?: string }
    const { orgId } = req.user
    const limit = Number(query.limit ?? 25)

    const where = {
      orgId,
      deletedAt: null,
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' as const } },
          { counterpartyName: { contains: query.search, mode: 'insensitive' as const } },
          { requestNumber: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }),
    }

    // Scope enforcement: restrict to own requests for users with 'own' scope
    if (req.permissionScope === 'own') {
      (where as any).requestedById = req.user.sub
    }

    const [requests, total] = await Promise.all([
      prisma.contractRequest.findMany({
        where,
        take: limit + 1,
        ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.contractRequest.count({ where }),
    ])

    const hasMore = requests.length > limit
    const data = hasMore ? requests.slice(0, limit) : requests

    return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : undefined, hasMore, total })
  })

  // GET /api/v1/requests/counts — { SUBMITTED: 3, IN_REVIEW: 2, … }
  //
  // B.6.16 — the Requests page uses this to render counts inline on
  // each tab so users know which queue has work before clicking. One
  // groupBy aggregate; no correlated subqueries.
  app.get('/counts', { preHandler: requirePermission('view', 'request') }, async (req, reply) => {
    const { orgId } = req.user
    const where: { orgId: string; deletedAt: null; requestedById?: string } = {
      orgId,
      deletedAt: null,
    }
    if (req.permissionScope === 'own') where.requestedById = req.user.sub
    const rows = await prisma.contractRequest.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    })
    const counts: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      counts[r.status] = r._count._all
      total += r._count._all
    }
    return reply.send({ counts, total })
  })

  // POST /api/v1/requests — accepts multipart (optional file attachment) or JSON
  app.post('/', { preHandler: requirePermission('create', 'request') }, async (req, reply) => {
    const { sub: requestedById, orgId } = req.user

    let body: ReturnType<typeof CreateRequestSchema.parse>
    const attachments: Array<{ filename: string; s3Key: string; mimeType: string; size: number }> = []

    const contentType = req.headers['content-type'] ?? ''
    if (contentType.includes('multipart/form-data')) {
      // Parse multipart — fields first, then optional file
      const parts = req.parts()
      const fields: Record<string, string> = {}
      let fileBuffer: Buffer | null = null
      let filename = ''
      let mimeType = ''

      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = part.value as string
        } else if (part.type === 'file') {
          fileBuffer = await part.toBuffer()
          // S3 — validate the bytes, not the declared mimetype.
          const checked = checkUpload(fileBuffer, part.mimetype, PDF_OR_DOCX)
          if (!checked.ok) return reply.status(checked.status).send({ detail: checked.detail })
          filename = part.filename
          mimeType = checked.mimeType
        }
      }

      // Parse JSON body field if sent as JSON string
      let rawBody: unknown
      if (fields.body) {
        try {
          rawBody = JSON.parse(fields.body)
        } catch {
          return reply.status(400).send({ detail: 'Invalid JSON in body field' })
        }
      } else {
        rawBody = fields
      }
      body = CreateRequestSchema.parse(rawBody)

      // Upload file to S3 if provided
      if (fileBuffer && filename) {
        const tempId = Date.now()
        const s3Key = `${orgId}/requests/${tempId}-${filename}`
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: mimeType,
        }))
        attachments.push({ filename, s3Key, mimeType, size: fileBuffer.length })
      }
    } else {
      body = CreateRequestSchema.parse(req.body)
    }

    // Auto-generate request number: REQ-YYYYMMDD-NNN
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const countToday = await prisma.contractRequest.count({
      where: { orgId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    })
    const requestNumber = `REQ-${today}-${String(countToday + 1).padStart(3, '0')}`

    // P7.4.14 / F-56 — counterpartyId comes off the typeahead. Strip it
    // off `body` because ContractRequest has no column for it yet, and
    // stash it under metadata so the rest of the system can read it.
    const { counterpartyId, ...bodyForDb } = body as typeof body & { counterpartyId?: string }
    const metadata: Record<string, unknown> = {
      ...((body.metadata ?? {}) as Record<string, unknown>),
      ...(counterpartyId ? { counterpartyId } : {}),
    }

    const request = await prisma.contractRequest.create({
      data: {
        ...bodyForDb,
        orgId,
        requestedById,
        requestNumber,
        metadata: metadata as Prisma.InputJsonValue,
        attachments: attachments.length > 0 ? attachments : undefined,
      } as Prisma.ContractRequestUncheckedCreateInput,
    })

    // Rename S3 key to use real request ID (for clean paths)
    if (attachments.length > 0) {
      const updated: typeof attachments = []
      for (const att of attachments) {
        const newKey = `${orgId}/requests/${request.id}/${att.filename}`
        // Fire-and-forget copy + delete would require GetObject+Put; simpler: just store tempKey as-is
        updated.push({ ...att })
      }
      await prisma.contractRequest.update({
        where: { id: request.id },
        data: { attachments: updated },
      })
    }

    await createAuditEvent({
      orgId,
      userId: requestedById,
      action: AuditAction.REQUEST_CREATED,
      resourceType: 'contract_request',
      resourceId: request.id,
    })

    // Queue AI classification in background
    queueClassifyRequest({ requestId: request.id, orgId })

    return reply.status(201).send(request)
  })

  // GET /api/v1/requests/:id
  app.get('/:id', { preHandler: requirePermission('view', 'request') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const request = await prisma.contractRequest.findFirst({
      where: { id, orgId, deletedAt: null },
    })

    if (!request) return reply.status(404).send({ detail: 'Request not found' })
    return reply.send(request)
  })

  // PATCH /api/v1/requests/:id
  app.patch('/:id', { preHandler: requirePermission('edit', 'request') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = UpdateRequestSchema.parse(req.body)

    const existing = await prisma.contractRequest.findFirst({
      where: { id, orgId, deletedAt: null },
    })

    if (!existing) return reply.status(404).send({ detail: 'Request not found' })
    // docs/41 Part 4 — "Decline request": a reason is required and kept;
    // the request's own moves are checked (accepting is drafting it).
    if (body.status && body.status !== existing.status) {
      const refusal = requestTransitionRefusal(existing.status, body.status, body.rejectionReason)
      if (refusal) return reply.status(409).send({ detail: refusal })
    }
    const { rejectionReason, ...rest } = body
    const declining = body.status === 'REJECTED' && existing.status !== 'REJECTED'
    const reopening = !!body.status && body.status !== 'REJECTED' && existing.status === 'REJECTED'

    const updated = await prisma.contractRequest.update({
      where: { id },
      data: { ...rest, ...(declining && { rejectionReason: rejectionReason?.trim() }), ...(reopening && { rejectionReason: null }) },
    })

    await createAuditEvent({
      orgId,
      userId,
      action: body.status
        ? AuditAction.REQUEST_STATUS_CHANGED
        : AuditAction.REQUEST_ASSIGNED,
      resourceType: 'contract_request',
      resourceId: id,
      metadata: { changes: rest, ...(body.status && { from: existing.status, to: body.status }), ...(declining && { reason: rejectionReason?.trim() }) },
    })
    if (declining && existing.requestedById !== userId) {
      queueNotification({
        orgId, userId: existing.requestedById, type: 'REQUEST_DECLINED', title: 'Request declined',
        body: `Your request "${existing.title}" was declined: “${rejectionReason?.trim()}”`,
        resourceType: 'contract_request', resourceId: id,
      })
    }

    return reply.send(updated)
  })

  // GET /api/v1/requests/:id/draft-plan — docs/41 Part 1: what drafting this
  // request would use, before it is drafted: the template (and how it was
  // chosen), each clause choice decided and why, and the ones left to make.
  // Deterministic and free: no LLM is asked.
  app.get('/:id/draft-plan', { preHandler: requirePermission('view', 'request') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const request = await prisma.contractRequest.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!request) return reply.status(404).send({ detail: 'Request not found' })
    const hasDocument = Array.isArray(request.attachments) && request.attachments.length > 0
    const ctx = requestContext(request)
    const [{ choice, plan }, templates] = await Promise.all([
      planFromRequest(orgId, ctx),
      prisma.template.findMany({
        where: { orgId, deletedAt: null, isPublished: true, OR: [{ contractType: request.type }, { contractType: null }] },
        select: { id: true, name: true, contractType: true, isDefaultForType: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    ])
    return reply.send({
      // A request with its own document is read, not drafted from a template.
      drafted: !hasDocument,
      choices: draftChoicesOf(request.metadata),
      templates,
      template: choice.ok ? { id: choice.template.id, name: choice.template.name, decidedBy: choice.decidedBy } : null,
      templateProblem: choice.ok ? null : { code: choice.error, detail: choice.detail },
      slots: plan?.ok ? plan.slots : [],
      openChoices: plan?.ok ? plan.slots.filter(s => s.decidedBy === 'unresolved').length : 0,
    })
  })

  // PUT /api/v1/requests/:id/draft-choices — the template and clause variants
  // the requester picked; drafting uses them before any rule.
  app.put('/:id/draft-choices', { preHandler: requirePermission('edit', 'request') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const body = DraftChoicesSchema.parse(req.body ?? {})
    const request = await prisma.contractRequest.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!request) return reply.status(404).send({ detail: 'Request not found' })
    if (request.status === 'ACCEPTED' || request.status === 'COMPLETED') {
      return reply.status(409).send({ detail: 'This request has already been drafted.' })
    }
    const current = draftChoicesOf(request.metadata)
    const next: DraftChoices = { ...current }
    if (body.templateId !== undefined) {
      if (body.templateId) {
        const t = await prisma.template.findFirst({ where: { id: body.templateId, orgId, deletedAt: null, isPublished: true }, select: { id: true } })
        if (!t) return reply.status(404).send({ detail: 'Template not found' })
        next.templateId = t.id
      } else delete next.templateId
      // Clause choices belong to a template's slots; a new template starts clean.
      if (next.templateId !== current.templateId) next.slots = {}
    }
    if (body.slots) {
      // Each choice must be an approved variant of a family a slot of the
      // chosen template uses, as the template was published.
      const choice = await chooseTemplate({ orgId, templateId: next.templateId, contractType: request.type })
      const source = choice.ok ? await draftSource(orgId, choice.template) : null
      const slots = { ...(next.slots ?? {}) }
      for (const [familyId, variantId] of Object.entries(body.slots)) {
        if (variantId === null) { delete slots[familyId]; continue }
        const slot = source?.snapshot.sections.find(s => s.slot?.family.id === familyId)?.slot
        if (!slot?.variants.some(v => v.id === variantId)) {
          return reply.status(422).send({ detail: 'That clause option isn’t one this template offers.' })
        }
        slots[familyId] = variantId
      }
      next.slots = slots
    }
    await prisma.$executeRaw`UPDATE contract_requests SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_draftChoices}', ${JSON.stringify(next)}::jsonb) WHERE id = ${id} AND "orgId" = ${orgId}`
    await createAuditEvent({
      orgId, userId,
      action: AuditAction.REQUEST_STATUS_CHANGED,
      resourceType: 'contract_request',
      resourceId: id,
      metadata: { draftChoices: next },
    })
    return reply.send({ choices: next })
  })

  // POST /api/v1/requests/:id/convert — accept request and create a Contract
  app.post('/:id/convert', { preHandler: requirePermission('edit', 'request') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user

    // X21 — converting creates a contract (and queues an AI draft), so it
    // needs create:contract too: a key or role with only request rights could
    // create contracts here that POST /contracts refuses it.
    if (!await permissionScopeFor(req, 'create', 'contract')) {
      return reply.status(403).send({ type: 'https://httpstatuses.com/403', title: 'Forbidden', status: 403, detail: 'Missing permission: create:contract' })
    }

    const request = await prisma.contractRequest.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!request) return reply.status(404).send({ detail: 'Request not found' })
    if (request.status === 'ACCEPTED' || request.status === 'COMPLETED') {
      return reply.status(400).send({ detail: 'Request already converted' })
    }
    if (request.status === 'REJECTED') {
      return reply.status(409).send({ detail: 'This request was declined. Reopen it before drafting from it.' })
    }

    const attachments = (request.attachments as Array<{ filename: string; s3Key: string; mimeType: string; size: number }>) ?? []

    const hasAttachments = attachments.length > 0

    // Draft context — stored in metadata so retry can re-queue without the
    // original request. `description` (a column) is what the requester asked
    // for; docs/41 P0.4 — the intake classifier's terms (governing law,
    // duration…) go with it, and (Part 1) the template and clause choices the
    // requester picked.
    const draftContext = !hasAttachments ? requestContext(request) : undefined
    if (draftContext) {
      // docs/41 Part 1 — the template is chosen by rule; when the rule can't
      // (several published, none the default) the requester picks first.
      const choice = await chooseTemplate({ orgId, templateId: draftContext.templateId, contractType: draftContext.contractType })
      if (!choice.ok && choice.error === 'TEMPLATE_CHOICE_NEEDED') {
        return reply.status(409).send({ code: choice.error, detail: choice.detail, templates: choice.templates })
      }
    }

    // X21 — the contract belongs to whoever asked for it. It went to the
    // converter, so a requester with own scope could never open the contract
    // their request became. The converter keeps it only when the requester is
    // no longer an active member.
    const requester = await prisma.user.findFirst({
      where: { id: request.requestedById, orgId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    })
    // X45 — the converter is a user too: for an API key, the one who made it.
    const ownerId = requester?.id ?? actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)

    // Create the contract from request data
    const contract = await prisma.contract.create({
      data: {
        orgId,
        title:            request.title,
        type:             request.type,
        // docs/41 Part 18 — it starts as the request it was, and is accepted into Draft below.
        status:           'DRAFT',
        stage:            'request',
        stageState:       'in_triage',
        analysisStatus:   hasAttachments ? 'PENDING' : 'DRAFTING',
        counterpartyName: request.counterpartyName ?? undefined,
        value:            request.estimatedValue ?? undefined,
        ownerId,
        createdBy:        userId,
        ...(draftContext && { metadata: { _draftContext: draftContext } as unknown as Prisma.InputJsonValue }),
      },
    })

    if (hasAttachments) {
      // Request had a document — parse and analyze it
      const att = attachments[0]
      const version = await prisma.contractVersion.create({
        data: {
          contractId:    contract.id,
          versionNumber: 1,
          s3Key:         att.s3Key,
          mimeType:      att.mimeType,
          createdById:   userId,
          // ContractVersion has no `filename` column; the name travels
          // with the parse job below and is derived from s3Key for display.
        },
      })
      // docs/41 P0.1 — the contract stands on its document (it had no current
      // version, so the page and the playbook redline had nothing to read).
      await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })
      queueParseDocument({
        contractId: contract.id,
        versionId:  version.id,
        s3Key:      att.s3Key,
        mimeType:   att.mimeType,
        filename:   att.filename,
        orgId,
      })
    } else {
      // No document — trigger AI drafting from request context
      queueDraftContract({
        contractId:        contract.id,
        orgId,
        userId,
        ...draftContext!,
      })
    }

    // Index into ES so the new contract is searchable immediately. plainText is
    // empty for now; the attachment path re-indexes with full text once parsing
    // finishes (see parse.worker.ts). Fire-and-forget — never block the response.
    indexContract(contract.id, {
      orgId,
      title:            contract.title,
      type:             contract.type,
      status:           contract.status,
      counterpartyName: contract.counterpartyName ?? undefined,
      plainText:        '',
      tags:             contract.tags,
      createdAt:        contract.createdAt.toISOString(),
    }).catch(err => req.log.warn({ err }, 'ES index on request-convert failed'))

    // Mark request as accepted
    await prisma.contractRequest.update({
      where: { id },
      data:  { status: 'ACCEPTED' },
    })
    // Request → Draft, on the record (the banner's first step).
    await transition({
      orgId, contractId: contract.id, to: { stage: 'draft', state: 'drafting' }, source: 'import', userId,
      reason: 'the request was accepted', extra: { requestId: id },
    })

    await createAuditEvent({
      orgId, userId,
      action: AuditAction.CONTRACT_CREATED,
      resourceType: 'contract',
      resourceId: contract.id,
      metadata: { fromRequestId: id },
    })
    await createAuditEvent({
      orgId, userId,
      action: AuditAction.REQUEST_STATUS_CHANGED,
      resourceType: 'contract_request',
      resourceId: id,
      metadata: { status: 'ACCEPTED', contractId: contract.id },
    })

    return reply.status(201).send({ contractId: contract.id })
  })
}
