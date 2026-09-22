/**
 * Matters routes (P4.1 / docs/30 D.7.1)
 *
 * A Matter groups contracts + requests + agent threads under one
 * negotiation. Surfaces as first-class nav unit; answers the
 * procurement-RFP "do you support matters?" question with yes.
 *
 * Endpoints:
 *   GET    /api/v1/matters             — list org's matters (filterable)
 *   GET    /api/v1/matters/:id         — detail + children counts
 *   POST   /api/v1/matters             — create
 *   PATCH  /api/v1/matters/:id         — update (rename, status, owner)
 *   DELETE /api/v1/matters/:id         — soft-delete (children unlinked,
 *                                         matterId → null on contracts /
 *                                         requests / threads)
 *
 * Design reference: Ironclad Matters, Harvey Vault Projects,
 * Legal Files matter-centric model.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { prisma } from '../lib/prisma.js'

// Wave 1.7 — matters group contracts; there is no dedicated MATTER permission
// resource, so matter operations are gated on the corresponding CONTRACT
// permission (view to read, create to add, edit to change/attach, delete to
// remove). Previously the whole router was requireAuth-only, so a VIEWER could
// create, delete, and re-parent matters.

const MATTER_STATUSES = ['OPEN', 'CLOSED', 'ARCHIVED'] as const

const CreateMatterSchema = z.object({
  name:             z.string().min(1).max(200),
  description:      z.string().max(5_000).optional(),
  status:           z.enum(MATTER_STATUSES).default('OPEN'),
  counterpartyId:   z.string().optional(),
  counterpartyName: z.string().max(200).optional(),
  tags:             z.array(z.string().max(40)).max(20).default([]),
})

const UpdateMatterSchema = CreateMatterSchema.partial().extend({
  ownerId: z.string().optional(),
})

export async function matterRoutes(app: FastifyInstance) {

  // ── GET /api/v1/matters ────────────────────────────────────────────────
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    // X7 — counts cover only what the caller can open (as GET /:id does).
    const own = req.permissionScope === 'own'
    const requestScope = await permissionScopeFor(req, 'view', 'request')
    const q = z.object({
      status:  z.enum([...MATTER_STATUSES, 'all']).default('all'),
      ownerId: z.string().optional(),
      counterpartyName: z.string().optional(),
      limit:   z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)

    const where: Record<string, unknown> = { orgId, deletedAt: null }
    if (q.status !== 'all')       where.status = q.status
    if (q.ownerId)                where.ownerId = q.ownerId
    if (q.counterpartyName)       where.counterpartyName = {
      contains: q.counterpartyName, mode: 'insensitive',
    }

    const matters = await prisma.matter.findMany({
      where: where as never,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: q.limit,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        counterparty: { select: { id: true, name: true } },
        _count: {
          select: {
            contracts: own ? { where: { ownerId: req.user.sub } } : true,
            requests:  requestScope === 'own' ? { where: { requestedById: req.user.sub } } : requestScope ? true : { where: { id: { in: [] as string[] } } },
            threads:   own ? { where: { userId: req.user.sub } } : true,
          },
        },
      },
    })
    return reply.send({
      items: matters.map(m => ({
        id:               m.id,
        name:             m.name,
        description:      m.description,
        status:           m.status,
        counterpartyId:   m.counterpartyId,
        counterpartyName: m.counterpartyName ?? m.counterparty?.name ?? null,
        ownerId:          m.ownerId,
        ownerName:        m.owner?.name ?? null,
        tags:             m.tags,
        contractCount:    m._count.contracts,
        requestCount:     m._count.requests,
        threadCount:      m._count.threads,
        createdAt:        m.createdAt,
        updatedAt:        m.updatedAt,
        closedAt:         m.closedAt,
      })),
      total: matters.length,
    })
  })

  // ── GET /api/v1/matters/:id ────────────────────────────────────────────
  app.get('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    // Requests follow their own permission (view:request): own-scope callers
    // see the ones they raised; a role without it sees none.
    const requestScope = await permissionScopeFor(req, 'view', 'request')
    const matter = await prisma.matter.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
        counterparty: { select: { id: true, name: true, website: true } },
        // X7 — an own-scope caller sees only their own contracts in the matter,
        // and only their own chat threads (a thread id is a way into its content).
        contracts: {
          where: { deletedAt: null, ...(req.permissionScope === 'own' ? { ownerId: req.user.sub } : {}) },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true, title: true, type: true, status: true,
            value: true, currency: true, riskScore: true,
            counterpartyName: true, effectiveDate: true, expiryDate: true,
            updatedAt: true,
          },
        },
        requests: {
          where: {
            deletedAt: null,
            ...(requestScope === 'own' ? { requestedById: req.user.sub } : requestScope ? {} : { id: { in: [] as string[] } }),
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, requestNumber: true, title: true, type: true,
            status: true, priority: true, counterpartyName: true,
            requestedById: true, assignedToId: true, createdAt: true,
          },
        },
        threads: {
          where: { archivedAt: null, ...(req.permissionScope === 'own' ? { userId: req.user.sub } : {}) },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true, title: true, scopeType: true, scopeId: true,
            userId: true, updatedAt: true,
          },
        },
      },
    })
    if (!matter) return reply.status(404).send({ detail: 'Matter not found' })
    return reply.send(matter)
  })

  // ── POST /api/v1/matters ───────────────────────────────────────────────
  app.post('/', { preHandler: requirePermission('create', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    let body
    try { body = CreateMatterSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }
    const matter = await prisma.matter.create({
      data: {
        orgId,
        name:             body.name,
        description:      body.description,
        status:           body.status,
        counterpartyId:   body.counterpartyId,
        counterpartyName: body.counterpartyName,
        tags:             body.tags,
        ownerId:          userId,
        createdById:      userId,
      },
    })
    return reply.status(201).send(matter)
  })

  // ── PATCH /api/v1/matters/:id ──────────────────────────────────────────
  app.patch('/:id', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    let patch
    try { patch = UpdateMatterSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }
    const existing = await prisma.matter.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Matter not found' })

    // If transitioning to CLOSED / ARCHIVED, stamp closedAt.
    const closedAt = (patch.status === 'CLOSED' || patch.status === 'ARCHIVED') && existing.status === 'OPEN'
      ? new Date()
      : undefined

    const updated = await prisma.matter.update({
      where: { id },
      data: {
        ...patch,
        ...(closedAt ? { closedAt } : {}),
      },
    })
    return reply.send(updated)
  })

  // ── DELETE /api/v1/matters/:id ─────────────────────────────────────────
  app.delete('/:id', { preHandler: requirePermission('delete', 'contract') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const existing = await prisma.matter.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return reply.status(404).send({ detail: 'Matter not found' })

    // Soft-delete + unlink children (set matterId back to null so the
    // contracts/requests/threads don't dangle).
    await prisma.$transaction([
      prisma.contract.updateMany({ where: { matterId: id }, data: { matterId: null } }),
      prisma.contractRequest.updateMany({ where: { matterId: id }, data: { matterId: null } }),
      prisma.agentThread.updateMany({ where: { matterId: id }, data: { matterId: null } }),
      prisma.matter.update({ where: { id }, data: { deletedAt: new Date() } }),
    ])
    return reply.status(204).send()
  })

  // ── POST /api/v1/matters/:id/attach — link a contract/request/thread ──
  app.post('/:id/attach', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    // X7 — an own-scope editor attaches only what it owns.
    const own = req.permissionScope === 'own'
    const { id } = req.params as { id: string }
    const body = z.object({
      kind: z.enum(['contract', 'request', 'thread']),
      entityId: z.string().min(1),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ detail: 'Invalid body', issues: body.error.issues })
    }
    const matter = await prisma.matter.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!matter) return reply.status(404).send({ detail: 'Matter not found' })

    // Wave 1.3 — CRITICAL: scope the target entity by orgId. Previously this
    // updated ANY contract/request/thread by raw id with no org check, so a
    // user in org A could pull an org B record (whose id leaked via logs /
    // webhooks / a screenshot) into their matter and read its metadata via
    // GET /matters/:id. updateMany + count guards cross-org isolation.
    let result: { count: number }
    if (body.data.kind === 'contract') {
      result = await prisma.contract.updateMany({
        where: { id: body.data.entityId, orgId, deletedAt: null, ...(own ? { ownerId: userId } : {}) },
        data:  { matterId: id },
      })
    } else if (body.data.kind === 'request') {
      result = await prisma.contractRequest.updateMany({
        where: { id: body.data.entityId, orgId, deletedAt: null, ...(own ? { requestedById: userId } : {}) },
        data:  { matterId: id },
      })
    } else {
      result = await prisma.agentThread.updateMany({
        where: { id: body.data.entityId, orgId, ...(own ? { userId } : {}) },
        data:  { matterId: id },
      })
    }
    if (result.count === 0) {
      return reply.status(404).send({ detail: `${body.data.kind} not found in your organization` })
    }
    return reply.send({ ok: true, matterId: id, kind: body.data.kind, entityId: body.data.entityId })
  })
}
