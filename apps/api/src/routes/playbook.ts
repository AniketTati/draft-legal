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
})

const UpdatePositionSchema = CreatePositionSchema.partial().omit({ clauseCategoryId: true })

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function playbookRoutes(app: FastifyInstance) {
  // ── List all playbook positions for the org ───────────────────────────────
  app.get('/positions', { preHandler: requirePermission('view', 'playbook') }, async (req, reply) => {
    const { orgId } = req.user
    const query = req.query as {
      clauseCategoryId?: string
      positionType?: string
      contractType?: string
    }

    const where: any = {
      orgId,
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

    const position = await prisma.playbookPosition.create({
      data: { orgId, createdById: userId, ...body },
      include: { clauseCategory: { select: { id: true, name: true } } },
    })

    return reply.status(201).send(position)
  })

  // ── Update position ───────────────────────────────────────────────────────
  app.patch('/positions/:id', { preHandler: requirePermission('edit', 'playbook') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = UpdatePositionSchema.parse(req.body)

    const existing = await prisma.playbookPosition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Position not found' })

    const updated = await prisma.playbookPosition.update({
      where: { id },
      data: body,
      include: { clauseCategory: { select: { id: true, name: true } } },
    })

    return reply.send(updated)
  })

  // ── Delete position ───────────────────────────────────────────────────────
  app.delete('/positions/:id', { preHandler: requirePermission('delete', 'playbook') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const existing = await prisma.playbookPosition.findFirst({ where: { id, orgId } })
    if (!existing) return reply.status(404).send({ detail: 'Position not found' })

    await prisma.playbookPosition.delete({ where: { id } })
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

    // Fetch playbook positions for this category
    const positions = await prisma.playbookPosition.findMany({
      where: {
        orgId,
        clauseCategoryId,
        ...(contractType
          ? {
              OR: [
                { contractTypes: { isEmpty: true } },
                { contractTypes: { has: contractType } },
              ],
            }
          : {}),
      },
      orderBy: { sortOrder: 'asc' },
    })

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
      const agentRes = await fetch(`${agentUrl}/compare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
        body: JSON.stringify({ clauseText, positions }),
      })

      if (!agentRes.ok) {
        const err = await agentRes.text()
        app.log.error({ err }, 'Agent compare failed')
        return reply.status(502).send({ detail: 'Agent service error' })
      }

      const result = await agentRes.json()
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
