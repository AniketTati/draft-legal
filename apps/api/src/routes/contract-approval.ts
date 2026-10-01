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
import { isNegative, roleIdsOf } from '../lib/workflow-engine.js'

/** What became of a request for approval, in the words the page uses. */
export function approvalOutcome(status: string, outcome?: string | null): 'pending' | 'approved' | 'auto_approved' | 'returned' | 'declined' | 'withdrawn' | 'cancelled' {
  if (status === 'APPROVED') return 'approved'
  if (status === 'AUTO_APPROVED') return 'auto_approved'
  if (status === 'REJECTED') return outcome === 'declined' ? 'declined' : 'returned'
  if (status === 'CANCELLED') return outcome === 'withdrawn' ? 'withdrawn' : 'cancelled'
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
      include: { steps: { where: { kind: 'approval' }, orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }] }, definition: { select: { name: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 20,
    })
    // docs/41 Part 7 — the contract's clause exceptions: asked for, decided, reset.
    const exceptionSteps = await prisma.approvalStep.findMany({
      where: { orgId, contractId: id, kind: 'clause_exception' }, orderBy: { createdAt: 'desc' }, take: 50,
    })
    const exceptionPeople = [...new Set(exceptionSteps.flatMap(s => [s.approverId, s.requestedById]).filter((x): x is string => !!x))]
    const exceptionRoles = [...new Set(exceptionSteps.map(s => s.approverRoleId).filter((x): x is string => !!x))]
    const exRoles = exceptionRoles.length ? await prisma.role.findMany({ where: { id: { in: exceptionRoles } }, select: { id: true, name: true } }) : []
    const exUsers = exceptionPeople.length ? await prisma.user.findMany({ where: { id: { in: exceptionPeople }, orgId }, select: { id: true, name: true, email: true } }) : []
    const exName = (uid: string | null) => { const u = uid ? exUsers.find(x => x.id === uid) : null; return u ? u.name || u.email : null }
    const exceptions = exceptionSteps.map(s => ({
      id: s.id, findingId: s.findingId, clauseType: s.clauseType, title: s.stepName.replace(/^Exception: /, ''), status: s.status,
      requestedBy: exName(s.requestedById), reason: s.requestNote, decidedBy: s.decidedAt ? exName(s.approverId) : null, comment: s.comment,
      // Who it waits on while pending: the clause approver named when it was asked for.
      waitingFor: s.status !== 'PENDING' ? null : s.approverId ? exName(s.approverId) : `anyone with the ${exRoles.find(r => r.id === s.approverRoleId)?.name ?? 'approver'} role`,
      decidedAt: s.decidedAt, createdAt: s.createdAt,
    }))
    if (!instances.length) return reply.send({ current: null, history: [], awaitingMe: null, exceptions })

    const people = [...new Set(instances.flatMap(i => [i.submittedById, ...i.steps.map(s => s.approverId)]).filter((x): x is string => !!x))]
    const users = await prisma.user.findMany({ where: { id: { in: people }, orgId }, select: { id: true, name: true, email: true } })
    const nameOf = (uid: string | null) => { const u = uid ? users.find(x => x.id === uid) : null; return u?.name || u?.email || 'Someone' }
    // A role's pooled step waits on the role (docs/41 Part 6).
    const roleIds = [...new Set(instances.flatMap(i => i.steps.map(s => s.approverRoleId)).filter((x): x is string => !!x))]
    const roles = roleIds.length ? await prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : []
    const waitsOn = (s: { approverId: string | null; approverRoleId: string | null }) => s.approverId
      ? { id: s.approverId, name: nameOf(s.approverId) }
      : { id: null, roleId: s.approverRoleId, name: `Anyone with the ${roles.find(r => r.id === s.approverRoleId)?.name ?? 'approver'} role` }
    const myRoles = await roleIdsOf(userId, prisma)

    const latest = instances[0]
    const open = latest.status === 'PENDING' || latest.status === 'ESCALATED'
    // The recommendation as shown: held back while open when a check fails (P0.2).
    const guard = open ? await recommendationGuard(id, orgId) : null

    const view = (i: (typeof instances)[number]) => {
      const returning = i.steps.find(s => isNegative(s.decision))
      const pending = i.steps.filter(s => s.status === 'PENDING' && s.stepOrder === i.currentStepOrder)
      const isLatest = i.id === latest.id
      return {
        id: i.id,
        status: i.status,
        outcome: approvalOutcome(i.status, i.outcome),
        workflowName: i.definition?.name ?? null,
        submittedAt: i.submittedAt,
        decidedAt: i.decidedAt,
        submittedBy: { id: i.submittedById, name: nameOf(i.submittedById) },
        currentStepOrder: i.currentStepOrder,
        currentStepName: pending[0]?.stepName ?? null,
        waitingOn: pending.map(waitsOn),
        returnedBy: returning ? { id: returning.approverId, name: nameOf(returning.approverId) } : null,
        reason: returning?.comment ?? null,
        // docs/41 Part 4 — a return (changes needed) or a decline (do not proceed), and what it pointed at.
        linkedFindingIds: returning?.linkedFindingIds ?? [],
        linkedClauseIds: returning?.linkedClauseIds ?? [],
        versionId: i.versionId,
        aiSummary: i.aiSummary,
        keyRisks: i.keyRisks,
        nonStandardTerms: i.nonStandardTerms,
        approvalRecommendation: isLatest && guard ? guardedLabel(i.approvalRecommendation, guard) : i.approvalRecommendation,
        recommendationReasons: isLatest && guard ? guard.recommendation.reasons.map(r => r.text) : [],
        steps: i.steps.map(s => ({
          id: s.id, stepOrder: s.stepOrder, stepName: s.stepName,
          approverId: s.approverId, approverName: s.approverId ? nameOf(s.approverId) : waitsOn(s).name, approverRoleId: s.approverRoleId,
          status: s.status, decision: s.decision, comment: s.comment,
          delegatedToId: s.delegatedToId, decidedAt: s.decidedAt, escalateAt: s.escalateAt,
        })),
      }
    }

    const current = view(latest)
    // The step the caller can decide now: theirs, pending, at the current order.
    const mine = open ? latest.steps.find(s => s.status === 'PENDING' && s.stepOrder === latest.currentStepOrder && (s.approverId === userId || (!s.approverId && !!s.approverRoleId && myRoles.includes(s.approverRoleId)))) : undefined
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

    return reply.send({ current, history: instances.slice(1).map(view), awaitingMe, exceptions })
  })
}
