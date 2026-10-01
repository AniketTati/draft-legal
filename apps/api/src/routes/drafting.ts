/**
 * Defined terms of a version (docs/41 Part 10) — see lib/defined-terms.ts.
 *
 *   GET /api/v1/contracts/:id/defined-terms?versionId=   → { versionId, glossary, issues }
 *
 * Worked out from the version's text on each call: deterministic and fast, so
 * a version edited since analysis is never shown stale findings.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { definedTermsForVersion } from '../lib/drafting-findings.js'

export async function draftingRoutes(app: FastifyInstance) {
  // X7 — own scope reads only the contracts it owns.
  guardOwnScopeContractRoutes(app)

  app.get('/:id/defined-terms', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { versionId } = z.object({ versionId: z.string().min(1).max(64).optional() }).parse(req.query)
    const result = await definedTermsForVersion(req.user.orgId, id, versionId)
    if (!result) return reply.status(404).send({ detail: 'Contract or version not found' })
    return reply.send(result)
  })
}
