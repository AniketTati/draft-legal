/**
 * docs/41 P0.6 — a contract's approval, from the contract.
 *
 *   GET /api/v1/contracts/:id/approval   the latest request for approval, its
 *       steps with approver names, the outcome and the reason it was returned,
 *       the earlier requests, and the step waiting on the caller, if any
 *
 * The contract page asked `GET /approvals?contractId=`, a route that never
 * existed, so its approval timeline, the rail's approval section and the
 * "waiting on" strip were always empty; a Reject left no visible trace on
 * the contract. This is the one place the page reads approval state from.
 */
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { guardOwnScopeContractRoutes } from '../lib/own-scope-guard.js'
import { recommendationGuard, guardedLabel } from '../lib/recommendation-guard.js'

/** What became of a request for approval, in the words the page uses. */
export function approvalOutcome(status: string): 'pending' | 'approved' | 'auto_approved' | 'returned' | 'cancelled' {
  if (status === 'APPROVED') return 'approved'
  if (status === 'AUTO_APPROVED') return 'auto_approved'
  if (status === 'REJECTED') return 'returned'
  if (status === 'CANCELLED') return 'cancelled'
  return 'pending'
}

export async function contractApprovalRoutes(app: FastifyInstance) {
  // X7 — own-scope callers may only reach their own contracts by id.
  guardOwnScopeContractRoutes(app)

  app.get('/:id/approval', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const contract = await prisma.contract.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, title: true, type: true, status: true },
    })
    if (!contract) return reply.status(404).send({ detail: 'Contract not found' })

    const instances = await prisma.approvalInstance.findMany({
      where: { orgId, contractId: id },
      include: { steps: { orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }] }, definition: { select: { name: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 20,
    })
    if (!instances.length) return reply.send({ current: null, history: [], awaitingMe: null })

    const people = [...new Set(instances.flatMap(i => [i.submittedById, ...i.steps.map(s => s.approverId)]))]
    const users = await prisma.user.findMany({ where: { id: { in: people }, orgId }, select: { id: true, name: true, email: true } })
    const nameOf = (uid: string) => { const u = users.find(x => x.id === uid); return u?.name || u?.email || 'Someone' }

    const latest = instances[0]
    const open = latest.status === 'PENDING' || latest.status === 'ESCALATED'
    // The recommendation as shown: held back while open when a check fails (P0.2).
    const guard = open ? await recommendationGuard(id, orgId) : null

    const view = (i: (typeof instances)[number]) => {
      const returning = i.steps.find(s => s.decision === 'REJECTED')
      const pending = i.steps.filter(s => s.status === 'PENDING' && s.stepOrder === i.currentStepOrder)
      const isLatest = i.id === latest.id
      return {
        id: i.id,
        status: i.status,
        outcome: approvalOutcome(i.status),
        workflowName: i.definition?.name ?? null,
        submittedAt: i.submittedAt,
        decidedAt: i.decidedAt,
        submittedBy: { id: i.submittedById, name: nameOf(i.submittedById) },
        currentStepOrder: i.currentStepOrder,
        currentStepName: pending[0]?.stepName ?? null,
        waitingOn: pending.map(s => ({ id: s.approverId, name: nameOf(s.approverId) })),
        returnedBy: returning ? { id: returning.approverId, name: nameOf(returning.approverId) } : null,
        reason: returning?.comment ?? null,
        aiSummary: i.aiSummary,
        keyRisks: i.keyRisks,
        nonStandardTerms: i.nonStandardTerms,
        approvalRecommendation: isLatest && guard ? guardedLabel(i.approvalRecommendation, guard) : i.approvalRecommendation,
        recommendationReasons: isLatest && guard ? guard.recommendation.reasons.map(r => r.text) : [],
        steps: i.steps.map(s => ({
          id: s.id, stepOrder: s.stepOrder, stepName: s.stepName,
          approverId: s.approverId, approverName: nameOf(s.approverId),
          status: s.status, decision: s.decision, comment: s.comment,
          delegatedToId: s.delegatedToId, decidedAt: s.decidedAt, escalateAt: s.escalateAt,
        })),
      }
    }

    const current = view(latest)
    // The step the caller can decide now: theirs, pending, at the current order.
    const mine = open ? latest.steps.find(s => s.approverId === userId && s.status === 'PENDING' && s.stepOrder === latest.currentStepOrder) : undefined
    const awaitingMe = mine ? {
      stepId: mine.id,
      instanceId: latest.id,
      stepName: mine.stepName,
      contract: { id: contract.id, title: contract.title, type: contract.type },
      instance: {
        id: latest.id,
        status: latest.status,
        submittedAt: latest.submittedAt,
        submittedByName: current.submittedBy.name,
        aiSummary: latest.aiSummary,
        keyRisks: latest.keyRisks,
        nonStandardTerms: latest.nonStandardTerms,
        approvalRecommendation: current.approvalRecommendation,
        recommendationReasons: current.recommendationReasons,
      },
    } : null

    return reply.send({ current, history: instances.slice(1).map(view), awaitingMe })
  })
}
