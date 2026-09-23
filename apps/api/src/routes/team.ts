/**
 * Team workload routes — SCR-031
 * View team members with workload counts and manage OOO status.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { requireAuth } from '../middleware/auth.js'

const SetOooSchema = z.object({
  outOfOffice: z.boolean(),
  outOfOfficeUntil: z.string().datetime().optional().nullable(),
  delegateToId: z.string().optional().nullable(),
})

export async function teamRoutes(app: FastifyInstance) {
  // GET /api/v1/team/workload — users with aggregate workload counts.
  // P14 audit (2026-04-29). The workload page exists to answer "who's
  // up, who's swamped" — basic team awareness that every org member
  // needs. Gating it on `view user` blocked LEGAL_COUNSEL and
  // CONTRACT_MANAGER (the ICs who actually need to know team capacity)
  // and produced 403 console errors on every page load. Drop to
  // `requireAuth` — the response only includes name/email/role/counts,
  // not anything sensitive (no PII, no comp). Mutations (set OOO etc.)
  // remain `requirePermission`-gated below.
  app.get('/workload', { preHandler: requireAuth }, async (req, reply) => {
    const { orgId, sub: me } = req.user
    // X21 — the directory and OOO stay visible to every member, but a count is
    // only shown where the caller could see what it counts: other people's
    // contracts need view:contract beyond `own`, their approval queues
    // view:workflow beyond `own`. The caller's own counts are always shown.
    const [contractScope, workflowScope] = await Promise.all([
      permissionScopeFor(req, 'view', 'contract'),
      permissionScopeFor(req, 'view', 'workflow'),
    ])
    const seesContracts = contractScope != null && contractScope !== 'own'
    const seesApprovals = workflowScope != null && workflowScope !== 'own'

    const users = await prisma.user.findMany({
      where: { orgId, deletedAt: null, status: 'ACTIVE' },
      include: { userRoles: { include: { role: true } } },
      orderBy: { name: 'asc' },
    })

    // Get contract counts per owner
    const contractCounts = await prisma.contract.groupBy({
      by: ['ownerId'],
      // X17 — a diligence room's uploads are a target's contracts, not anyone's book.
      where: { orgId, deletedAt: null, diligenceRoomId: null, status: { notIn: ['ARCHIVED', 'TERMINATED', 'EXPIRED'] } },
      _count: { id: true },
    })
    const contractCountMap = new Map(contractCounts.map(c => [c.ownerId, c._count.id]))

    // Get pending approval counts per approver
    const approvalCounts = await prisma.approvalStep.groupBy({
      by: ['approverId'],
      where: { orgId, status: 'PENDING' },
      _count: { id: true },
    })
    const approvalCountMap = new Map(approvalCounts.map(a => [a.approverId, a._count.id]))

    const result = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      roles: u.userRoles.map(ur => ur.role.name),
      lastActiveAt: u.lastActiveAt,
      outOfOffice: u.outOfOffice,
      outOfOfficeUntil: u.outOfOfficeUntil,
      delegateToId: u.delegateToId,
      activeContracts: seesContracts || u.id === me ? contractCountMap.get(u.id) ?? 0 : null,
      pendingApprovals: seesApprovals || u.id === me ? approvalCountMap.get(u.id) ?? 0 : null,
    }))

    return reply.send(result)
  })

  // PATCH /api/v1/team/:userId/ooo — set OOO status
  app.patch('/:userId/ooo', { preHandler: requirePermission('configure', 'user') }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const { orgId } = req.user
    const body = SetOooSchema.parse(req.body)

    const user = await prisma.user.findFirst({
      where: { id: userId, orgId, deletedAt: null },
    })
    if (!user) return reply.status(404).send({ detail: 'User not found' })

    if (body.delegateToId) {
      const delegate = await prisma.user.findFirst({
        where: { id: body.delegateToId, orgId, status: 'ACTIVE', deletedAt: null },
      })
      if (!delegate) return reply.status(400).send({ detail: 'Delegate user not found or not active' })
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        outOfOffice: body.outOfOffice,
        outOfOfficeUntil: body.outOfOfficeUntil ? new Date(body.outOfOfficeUntil) : null,
        delegateToId: body.delegateToId ?? null,
      },
    })

    return reply.send({ message: 'OOO status updated' })
  })
}
