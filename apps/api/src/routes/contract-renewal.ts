/**
 * docs/41 Part 14 — a contract's renewal: where it stands, the decision and
 * what it starts (lib/renewal-decisions.ts), and the notice marked sent.
 *
 *   GET  /contracts/:id/renewal                       the terms, deadline, window, decision and choices
 *   POST /contracts/:id/renewal-decision              { decision, reason? } → the decision and the contract it drafted
 *   POST /contracts/:id/renewal-decision/notice-sent  { sentAt? } → when the notice of non-renewal went out
 *   GET|POST /contracts/:id/watchers, DELETE /contracts/:id/watchers/:userId
 *                                                     people who get its renewal reminders besides the owner
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { actingUserId, NO_ACTING_USER } from '../lib/acting-user.js'
import { decideRenewal, markNoticeSent, renewalState } from '../lib/renewal-decisions.js'
import { prisma } from '../lib/prisma.js'
import { createAuditEvent } from '../lib/audit.js'
import { AuditAction } from '@clm/types'

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

  // ── Watchers (docs/41 Part 14) ──────────────────────────────────────────
  const listWatchers = async (orgId: string, contractId: string) => {
    const rows = await prisma.contractWatcher.findMany({ where: { orgId, contractId }, orderBy: { createdAt: 'asc' }, select: { userId: true, createdAt: true } })
    const users = await prisma.user.findMany({ where: { orgId, id: { in: rows.map(r => r.userId) } }, select: { id: true, name: true, email: true } })
    return rows.flatMap(r => {
      const u = users.find(x => x.id === r.userId)
      return u ? [{ userId: u.id, name: u.name, email: u.email, since: r.createdAt }] : []
    })
  }
  const contractIn = (orgId: string, id: string) =>
    prisma.contract.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } })

  app.get('/:id/watchers', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!await contractIn(req.user.orgId, id)) return reply.status(404).send({ detail: 'Contract not found' })
    return reply.send({ data: await listWatchers(req.user.orgId, id) })
  })

  app.post('/:id/watchers', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user
    const body = z.object({ userId: z.string().min(1).max(64).optional() }).safeParse(req.body ?? {})
    // No userId: watch it yourself.
    const userId = body.success ? body.data.userId ?? actingUserId(req.user) : null
    if (!userId) return reply.status(400).send({ detail: 'Say who should watch this contract.' })
    if (!await contractIn(orgId, id)) return reply.status(404).send({ detail: 'Contract not found' })
    const user = await prisma.user.findFirst({ where: { id: userId, orgId, deletedAt: null, status: { not: 'DEACTIVATED' } }, select: { id: true } })
    if (!user) return reply.status(404).send({ detail: 'That person isn’t in your organization.' })
    await prisma.contractWatcher.upsert({
      where: { contractId_userId: { contractId: id, userId } },
      create: { orgId, contractId: id, userId },
      update: {},
    })
    await createAuditEvent({ orgId, userId: actingUserId(req.user) ?? undefined, action: AuditAction.CONTRACT_WATCHER_ADDED, resourceType: 'contract', resourceId: id, metadata: { watcherId: userId }, ipAddress: req.ip })
    return reply.status(201).send({ data: await listWatchers(orgId, id) })
  })

  app.delete('/:id/watchers/:userId', { preHandler: requirePermission('edit', 'contract') }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string }
    const { orgId } = req.user
    if (!await contractIn(orgId, id)) return reply.status(404).send({ detail: 'Contract not found' })
    const r = await prisma.contractWatcher.deleteMany({ where: { orgId, contractId: id, userId } })
    if (r.count) await createAuditEvent({ orgId, userId: actingUserId(req.user) ?? undefined, action: AuditAction.CONTRACT_WATCHER_REMOVED, resourceType: 'contract', resourceId: id, metadata: { watcherId: userId }, ipAddress: req.ip })
    return reply.send({ data: await listWatchers(orgId, id) })
  })
}
