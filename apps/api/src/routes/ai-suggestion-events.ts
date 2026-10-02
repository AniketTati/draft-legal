/**
 * docs/41 Part 16 — POST /ai-suggestion-events: the web's batch of AI
 * suggestion outcomes (Ask AI, Counter, insert standard, redline, fix-all).
 * Each event names a contract of the caller's org that the caller can see.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { ownContractWhere } from '../lib/own-scope-guard.js'
import { AI_FEATURES, AI_OUTCOMES, recordAiSuggestions } from '../lib/ai-suggestion-events.js'

const Body = z.object({
  events: z.array(z.object({
    contractId: z.string().min(1).max(64),
    versionId: z.string().min(1).max(64).nullable().optional(),
    feature: z.enum(AI_FEATURES),
    outcome: z.enum(AI_OUTCOMES),
    suggestionId: z.string().min(1).max(128).nullable().optional(),
  })).min(1).max(100),
})

export async function aiSuggestionEventRoutes(app: FastifyInstance) {
  app.post('/', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const parsed = Body.safeParse(req.body ?? {})
    if (!parsed.success) return reply.status(400).send({ detail: 'Send 1 to 100 events, each with a contract, a feature and an outcome.' })
    const { events } = parsed.data
    const ids = [...new Set(events.map(e => e.contractId))]
    const visible = await prisma.contract.findMany({ where: { id: { in: ids }, orgId, deletedAt: null, ...ownContractWhere(req) }, select: { id: true } })
    // A contract outside the org (or one an own-scope caller doesn't own) is not found, the whole batch refused.
    if (visible.length !== ids.length) return reply.status(404).send({ detail: 'Contract not found' })
    // A version must be the contract's own.
    const versionIds = [...new Set(events.map(e => e.versionId).filter((v): v is string => !!v))]
    if (versionIds.length) {
      const versions = await prisma.contractVersion.findMany({ where: { id: { in: versionIds }, contractId: { in: ids } }, select: { id: true, contractId: true } })
      const of = new Map(versions.map(v => [v.id, v.contractId]))
      if (events.some(e => e.versionId && of.get(e.versionId) !== e.contractId)) return reply.status(400).send({ detail: 'A version is not of its contract.' })
    }
    const recorded = await recordAiSuggestions(events.map(e => ({ ...e, orgId, userId })))
    return reply.status(201).send({ recorded })
  })
}
