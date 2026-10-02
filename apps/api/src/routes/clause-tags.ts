/**
 * Clauses people tag and correct (docs/39 E1) — see lib/clause-tags.ts.
 *
 *   POST  /api/v1/contracts/:id/clauses/tag             { clauseType, text, occurrence? }
 *   PATCH /api/v1/contracts/clauses/:clauseId/type      { clauseType }
 *   POST  /api/v1/contracts/clauses/:clauseId/dismiss   ("not a clause")
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { isClauseType } from '../lib/clause-types.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { tagClause, retypeClause, dismissClause } from '../lib/clause-tags.js'

// docs/39 E3 — a built-in type or one of the organization's own.
const ClauseType = z.string().min(1).max(80)
const unknownType = (reply: FastifyReply) => reply.status(422).send({ detail: 'Unknown clause type' })

const scopeOf = (req: FastifyRequest) => ({
  orgId: req.user.orgId, userId: req.user.sub, ownOnly: req.permissionScope === 'own', ipAddress: req.ip,
})

function send<T extends object>(reply: FastifyReply, r: ({ ok: true } & T) | { ok: false; status: number; detail: string }) {
  if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
  const { ok: _ok, ...rest } = r
  return reply.send(rest)
}

export async function clauseTagRoutes(app: FastifyInstance) {
  // X7 — own scope may only change clauses on contracts it owns.
  guardOwnScopeContractRoutes(app)

  app.post('/:id/clauses/tag', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({
      clauseType: ClauseType,
      text: z.string().trim().min(2).max(20_000),
      occurrence: z.number().int().min(0).max(10_000).optional(),
    }).parse(req.body)
    if (!await isClauseType(req.user.orgId, body.clauseType)) return unknownType(reply)
    return send(reply, await tagClause(scopeOf(req), { contractId: id, ...body }))
  })

  app.patch('/clauses/:clauseId/type', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { clauseId } = req.params as { clauseId: string }
    const { clauseType } = z.object({ clauseType: ClauseType }).parse(req.body)
    if (!await isClauseType(req.user.orgId, clauseType)) return unknownType(reply)
    return send(reply, await retypeClause(scopeOf(req), { clauseId, clauseType }))
  })

  app.post('/clauses/:clauseId/dismiss', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { clauseId } = req.params as { clauseId: string }
    return send(reply, await dismissClause(scopeOf(req), { clauseId }))
  })
}
