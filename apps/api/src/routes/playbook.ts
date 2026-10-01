/**
 * Playbook API — Phase 4.1
 *
 * Manage playbook positions per clause category.
 * A playbook defines what the org prefers, accepts, can fall back to, or walks away from
 * for each clause type in negotiations.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { randomUUID } from 'node:crypto'
import { redactJson, restorePii, sliceOutsideTokens } from '../lib/pii-policy.js'
import { modelFetch } from '../lib/model-boundary.js'
import { defaultPlaybookId, bumpPlaybookVersion, resolvePlaybook, positionWhere } from '../lib/playbooks.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

const POSITION_TYPES = ['preferred', 'acceptable', 'fallback', 'walkaway'] as const

// ─── Schemas ────────────────────────────────────────────────────────────────

const CreatePositionSchema = z.object({
  clauseCategoryId: z.string().min(1),
  positionType: z.enum(POSITION_TYPES),
  content: z.string().default(''),
  notes: z.string().max(2048).optional(),
  riskThreshold: z.number().min(0).max(1).default(0.5),
  contractTypes: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
  // docs/41 P1 — the playbook it goes into; the org's default when omitted.
  playbookId: z.string().min(1).optional(),
})

const UpdatePositionSchema = CreatePositionSchema.partial().omit({ clauseCategoryId: true })

const PlaybookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  contractTypes: z.array(z.string().min(1).max(64)).max(50).default([]),
  isDefaultForType: z.boolean().default(false),
})

/**
 * docs/41 P1 — one default per type. Making a playbook the default takes the
 * default away from any other covering the same types: an all-types one
 * from the other all-types defaults, a typed one from defaults naming any of
 * its types (an all-types default stays the fallback for the rest).
 */
async function claimDefault(orgId: string, playbookId: string, contractTypes: string[]): Promise<void> {
  const others = await prisma.playbook.findMany({
    where: { orgId, deletedAt: null, isDefaultForType: true, id: { not: playbookId } },
    select: { id: true, contractTypes: true },
  })
  const clash = others.filter(o => contractTypes.length === 0
    ? o.contractTypes.length === 0
    : o.contractTypes.some(t => contractTypes.includes(t)))
  if (clash.length) await prisma.playbook.updateMany({ where: { id: { in: clash.map(c => c.id) } }, data: { isDefaultForType: false } })
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function playbookRoutes(app: FastifyInstance) {
  // ── List all playbook positions for the org ───────────────────────────────
  app.get('/positions', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const query = req.query as {
      clauseCategoryId?: string
      positionType?: string
      contractType?: string
      playbookId?: string
    }

    const where: any = {
      orgId,
      ...(query.playbookId && { playbookId: query.playbookId }),
      ...(query.clauseCategoryId && { clauseCategoryId: query.clauseCategoryId }),
      ...(query.positionType && { positionType: query.positionType }),
      ...(query.contractType && {
        OR: [
          { contractTypes: { isEmpty: true } },
          { contractTypes: { has: query.contractType } },
        ],
      }),
    }

    const positions = await prisma.playbookPosition.findMany({
      where,
      include: {
        clauseCategory: { select: { id: true, name: true, parentCategoryId: true } },
      },
      orderBy: [{ clauseCategoryId: 'asc' }, { sortOrder: 'asc' }],
    })

    // Group by clause category
    const grouped: Record<string, any> = {}
    for (const pos of positions) {
      const catId = pos.clauseCategoryId
      if (!grouped[catId]) {
        grouped[catId] = {
          category: pos.clauseCategory,
          positions: [],
        }
      }
      grouped[catId].positions.push(pos)
    }

    return reply.send({ data: positions, grouped: Object.values(grouped) })
  })

  // ── Get a single position ─────────────────────────────────────────────────
  app.get('/positions/:id', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const position = await prisma.playbookPosition.findFirst({
      where: { id, orgId },
      include: { clauseCategory: true },
    })

    if (!position) return reply.status(404).send({ detail: 'Position not found' })
    return reply.send(position)
  })

  // ── Create position ───────────────────────────────────────────────────────
  app.post('/positions', { preHandler: requirePermission('create', 'playbook') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const body = CreatePositionSchema.parse(req.body)

    // Verify the category belongs to this org
    const category = await prisma.clauseCategory.findFirst({
      where: { id: body.clauseCategoryId, orgId },
    })
    if (!category) return reply.status(404).send({ detail: 'Clause category not found' })

    let playbookId = body.playbookId
    if (playbookId) {
      if (!await prisma.playbook.findFirst({ where: { id: playbookId, orgId, deletedAt: null }, select: { id: true } })) {
        return reply.status(404).send({ detail: 'Playbook not found' })
      }
    } else {
      playbookId = await defaultPlaybookId(orgId, userId)
    }

    const position = await prisma.playbookPosition.create({
      data: { orgId, createdById: userId, ...body, playbookId },
      include: { clauseCategory: { select: { id: true, name: true } } },
    })
    await bumpPlaybookVersion(playbookId)

    return reply.status(201).send(position)
  })

  // ── Update position ───────────────────────────────────────────────────────
  app.patch('/positions/:id', { preHandler: requirePermission('edit', 'playbook') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdatePositionSchema.parse(req.body)

    const existing = await prisma.playbookPosition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Position not found' })
    if (body.playbookId && !await prisma.playbook.findFirst({ where: { id: body.playbookId, orgId, deletedAt: null }, select: { id: true } })) {
      return reply.status(404).send({ detail: 'Playbook not found' })
    }

    const updated = await prisma.playbookPosition.update({
      where: { id },
      data: body,
      include: { clauseCategory: { select: { id: true, name: true } } },
    })
    await bumpPlaybookVersion(existing.playbookId)
    if (body.playbookId && body.playbookId !== existing.playbookId) await bumpPlaybookVersion(body.playbookId)

    return reply.send(updated)
  })

  // ── Delete position ───────────────────────────────────────────────────────
  app.delete('/positions/:id', { preHandler: requirePermission('delete', 'playbook') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.playbookPosition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Position not found' })

    await prisma.playbookPosition.delete({ where: { id } })
    await bumpPlaybookVersion(existing.playbookId)
    return reply.status(204).send()
  })

  // ── Playbooks (docs/41 P1, Part 3) ───────────────────────────────────────
  // A named set of positions for the contract types it covers, with one
  // default per type. Which one a contract uses is lib/playbooks.ts.
  app.get('/playbooks', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const [playbooks, counts, unfiled] = await Promise.all([
      prisma.playbook.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      prisma.playbookPosition.groupBy({ by: ['playbookId'], where: { orgId }, _count: { _all: true } }),
      prisma.playbookPosition.count({ where: { orgId, playbookId: null } }),
    ])
    const countOf = new Map(counts.map(c => [c.playbookId, c._count._all]))
    return reply.send({
      data: playbooks.map(p => ({ ...p, positionCount: countOf.get(p.id) ?? 0 })),
      unfiledPositions: unfiled,
    })
  })

  app.post('/playbooks', { preHandler: requirePermission('create', 'playbook') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const parsed = PlaybookSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ detail: 'Invalid playbook', issues: parsed.error.issues })
    const created = await prisma.playbook.create({ data: { orgId, createdById: userId, ...parsed.data, description: parsed.data.description ?? null } })
    if (created.isDefaultForType) await claimDefault(orgId, created.id, created.contractTypes)
    createAuditEvent({ orgId, userId, action: AuditAction.PLAYBOOK_CHANGED, resourceType: 'playbook', resourceId: created.id, metadata: { created: true, name: created.name } }).catch(() => {})
    return reply.status(201).send(created)
  })

  app.patch('/playbooks/:id', { preHandler: requirePermission('edit', 'playbook') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const { id } = req.params as { id: string }
    const parsed = PlaybookSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ detail: 'Invalid playbook', issues: parsed.error.issues })
    const existing = await prisma.playbook.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Playbook not found' })
    const updated = await prisma.playbook.update({ where: { id }, data: parsed.data })
    if (updated.isDefaultForType) await claimDefault(orgId, updated.id, updated.contractTypes)
    createAuditEvent({ orgId, userId, action: AuditAction.PLAYBOOK_CHANGED, resourceType: 'playbook', resourceId: id, metadata: { changed: Object.keys(parsed.data) } }).catch(() => {})
    return reply.send(updated)
  })

  app.delete('/playbooks/:id', { preHandler: requirePermission('delete', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const { id } = req.params as { id: string }
    const existing = await prisma.playbook.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!existing) return reply.status(404).send({ detail: 'Playbook not found' })
    // Its positions would be orphaned silently: they are moved or deleted first.
    if (await prisma.playbookPosition.count({ where: { orgId, playbookId: id } }) > 0) {
      return reply.status(409).send({ code: 'HAS_POSITIONS', detail: 'Move or delete this playbook’s positions first.' })
    }
    await prisma.playbook.update({ where: { id }, data: { deletedAt: new Date(), isDefaultForType: false } })
    await prisma.contract.updateMany({ where: { orgId, playbookId: id }, data: { playbookId: null } })
    return reply.status(204).send()
  })

  // ── Test clause against playbook ──────────────────────────────────────────
  // Sends clause text to the agent service for comparison against playbook positions
  app.post('/test', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const { clauseText, clauseCategoryId, contractType } = req.body as {
      clauseText: string
      clauseCategoryId: string
      contractType?: string
    }

    if (!clauseText?.trim()) {
      return reply.status(400).send({ detail: 'clauseText is required' })
    }

    // Fetch playbook positions for this category: of the playbook a contract
    // of this type is reviewed against (docs/41 P1), when a type is given.
    const scoped = contractType ? positionWhere(orgId, await resolvePlaybook(orgId, { type: contractType }), contractType) : { orgId }
    const positions = scoped ? await prisma.playbookPosition.findMany({
      where: { AND: [scoped, { clauseCategoryId }] },
      orderBy: { sortOrder: 'asc' },
    }) : []

    if (!positions.length) {
      return reply.status(404).send({ detail: 'No playbook positions found for this category' })
    }

    // Call the agent service for comparison
    try {
      // AGENTS_URL, not AGENT_SERVICE_URL: the latter is set by no env file,
      // no deploy manifest and no example, so in Cloud Run this fell back to
      // localhost — which is not the agents service there. The catch below
      // turns that into a 200 with no AI comparison, so it degraded silently.
      const agentUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
      // X27 — the clause being tested (typically pasted from a contract) goes
      // to the model under the org's PII policy; the comparison comes back
      // with the values.
      const scope = randomUUID()
      const agentRes = await modelFetch(`${agentUrl}/compare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
        // Cut to the agents service's 2,000-character limit without splitting a token.
        body: JSON.stringify({ clauseText: sliceOutsideTokens(await redactJson(orgId, clauseText, { surface: 'playbook_test', roundTrip: scope }), 0, 2000), positions }),
      }, { orgId, surface: 'playbook_test' })

      if (!agentRes.ok) {
        const err = await agentRes.text()
        app.log.error({ err }, 'Agent compare failed')
        return reply.status(502).send({ detail: 'Agent service error' })
      }

      const result = restorePii(await agentRes.json(), clauseText, scope)
      return reply.send(result)
    } catch (err) {
      app.log.error({ err }, 'Agent service unreachable')
      // Fallback: return positions with no AI comparison
      return reply.send({
        positions,
        comparison: null,
        warning: 'Agent service unavailable — returning positions without AI comparison',
      })
    }
  })
}
