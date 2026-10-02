/**
 * docs/41 Part 14 — a contract's renewal: where it stands, the decision and
 * what it starts (lib/renewal-decisions.ts), and the notice marked sent.
 *
 *   GET  /contracts/:id/renewal                       the terms, deadline, window, decision and choices
 *   POST /contracts/:id/renewal-decision              { decision, reason? } → the decision and the contract it drafted
 *   POST /contracts/:id/renewal-decision/notice-sent  { sentAt? } → when the notice of non-renewal went out
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { decideRenewal, markNoticeSent, renewalState } from '../lib/renewal-decisions.js'

const DecisionBody = z.object({
  decision: z.string().min(1).max(40),
  // `note` is the field's older name.
  reason: z.string().max(2000).nullish(),
  note: z.string().max(2000).nullish(),
})

const NoticeBody = z.object({ sentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullish() })

export async function contractRenewalRoutes(app: FastifyInstance) {
  guardOwnScopeContractRoutes(app)

  app.get('/:id/renewal', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub } = req.user
    const state = await renewalState(orgId, id, { ownerId: req.permissionScope === 'own' ? sub : undefined })
    if (!state) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send(state)
  })

  app.post('/:id/renewal-decision', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub } = req.user
    const body = DecisionBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Say which decision: renew, renegotiate, let_lapse or terminate.' })
    // X45 — what an API key drafts belongs to the user who made the key.
    const ownerId = actingUserId(req.user)
    if (!ownerId) return reply.status(422).send(NO_ACTING_USER)
    const r = await decideRenewal({
      orgId, contractId: id, userId: ownerId, ownerId, decision: body.data.decision,
      reason: body.data.reason ?? body.data.note ?? null, ownOnly: req.permissionScope === 'own' && !!sub,
      ipAddress: req.ip, log: app.log,
    })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.status(r.unchanged ? 200 : 201).send({
      ok: true, decision: r.decision.decision, decisionId: r.decision.id, unchanged: r.unchanged,
      decidedInTime: r.decision.decidedInTime, actionContract: r.actionContract,
    })
  })

  app.post('/:id/renewal-decision/notice-sent', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = NoticeBody.safeParse(req.body ?? {})
    if (!body.success) return reply.status(400).send({ detail: 'Give the date the notice was sent as YYYY-MM-DD.' })
    const userId = actingUserId(req.user)
    if (!userId) return reply.status(422).send(NO_ACTING_USER)
    const r = await markNoticeSent({
      orgId, contractId: id, userId, sentAt: body.data.sentAt ? new Date(body.data.sentAt.slice(0, 10)) : null,
      ownOnly: req.permissionScope === 'own', ipAddress: req.ip,
    })
    if (!r.ok) return reply.status(r.status).send({ detail: r.detail })
    return reply.send({ ok: true, noticeSentAt: r.decision.noticeSentAt?.toISOString().slice(0, 10), noticeSentInTime: r.decision.noticeSentInTime })
  })
}
