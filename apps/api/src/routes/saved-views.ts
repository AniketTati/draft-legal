/**
 * Saved views (docs/39 D3) — a named contracts list: its filters (field
 * filters too), columns and sort. Private to whoever saved it, or shared with
 * everyone in the org; only its owner (or someone who configures contracts)
 * changes or deletes it.
 *
 *   GET    /api/v1/saved-views?page=contracts   the caller's views and the shared ones
 *   POST   /api/v1/saved-views
 *   PATCH  /api/v1/saved-views/:id
 *   DELETE /api/v1/saved-views/:id
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { FieldFilterSchema } from './contract-query.js'

const PAGES = ['contracts'] as const
const MAX_PER_OWNER = 50

/** What a view holds: the list's state, as the page keeps it. */
const ViewQuerySchema = z.object({
  filters: z.object({
    type: z.string().max(64).optional(),
    status: z.string().max(64).optional(),
    jurisdiction: z.string().max(200).optional(),
    riskBand: z.enum(['high', 'medium', 'low']).optional(),
    clauseFlags: z.record(z.boolean()).optional(),
    expiryDateTo: z.string().max(40).optional(),
    counterpartyId: z.string().max(64).optional(),
    otdBand: z.enum(['below_target', 'meeting_target']).optional(),
    uptimeBand: z.enum(['three_nines', 'four_nines']).optional(),
  }).strict().default({}),
  // The counterparty's name, for its chip and for contracts from before the link.
  filterLabel: z.string().max(300).optional(),
  fieldFilters: z.array(FieldFilterSchema).max(20).default([]),
  columns: z.array(z.string().min(1).max(64)).max(24).default([]),
  sort: z.object({ key: z.string().min(1).max(64), dir: z.enum(['asc', 'desc']) }).nullable().default(null),
  q: z.string().max(200).optional(),
})

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  page: z.enum(PAGES).default('contracts'),
  shared: z.boolean().default(false),
  query: ViewQuerySchema,
})

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shared: z.boolean().optional(),
  query: ViewQuerySchema.optional(),
})

type Row = { id: string; ownerId: string; name: string; page: string; shared: boolean; query: unknown; createdAt: Date; updatedAt: Date }

const present = (r: Row, userId: string) => ({ ...r, mine: r.ownerId === userId })

/** Its owner may change a view; so may someone who configures contracts (a shared view left by someone gone). */
async function mayChange(req: FastifyRequest, view: Row): Promise<boolean> {
  return view.ownerId === req.user.sub || !!await permissionScopeFor(req, 'configure', 'contract')
}

export async function savedViewRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { page = 'contracts' } = req.query as { page?: string }
    const { orgId, sub: userId } = req.user
    const rows = await prisma.savedView.findMany({
      where: { orgId, page, OR: [{ ownerId: userId }, { shared: true }] },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    })
    return reply.send({ views: rows.map(r => present(r, userId)) })
  })

  app.post('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const body = CreateSchema.parse(req.body)
    const { orgId, sub: userId } = req.user
    if (await prisma.savedView.count({ where: { orgId, ownerId: userId } }) >= MAX_PER_OWNER) {
      return reply.status(409).send({ detail: `You have ${MAX_PER_OWNER} saved views. Delete one to save another.` })
    }
    const view = await prisma.savedView.create({
      data: { orgId, ownerId: userId, name: body.name, page: body.page, shared: body.shared, query: body.query as object },
    })
    return reply.status(201).send({ view: present(view, userId) })
  })

  app.patch('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateSchema.parse(req.body)
    const view = await prisma.savedView.findFirst({ where: { id, orgId: req.user.orgId } })
    // Someone else's private view doesn't exist, as far as the caller knows.
    if (!view || (!view.shared && view.ownerId !== req.user.sub)) return reply.status(404).send({ detail: 'View not found' })
    if (!await mayChange(req, view)) return reply.status(403).send({ detail: 'Only the person who saved this view can change it' })
    const updated = await prisma.savedView.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.shared !== undefined && { shared: body.shared }),
        ...(body.query !== undefined && { query: body.query as object }),
      },
    })
    return reply.send({ view: present(updated, req.user.sub) })
  })

  app.delete('/:id', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const view = await prisma.savedView.findFirst({ where: { id, orgId: req.user.orgId } })
    if (!view || (!view.shared && view.ownerId !== req.user.sub)) return reply.status(404).send({ detail: 'View not found' })
    if (!await mayChange(req, view)) return reply.status(403).send({ detail: 'Only the person who saved this view can delete it' })
    await prisma.savedView.delete({ where: { id } })
    return reply.status(204).send()
  })
}
