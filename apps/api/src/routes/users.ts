import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { requireUser, requireUserOrAdminKey } from '../middleware/auth.js'
import { createAuditEvent } from '../lib/audit.js'
import { UpdateUserSchema, ChangePasswordSchema, AuditAction } from '@clm/types'

export async function userRoutes(app: FastifyInstance) {
  // GET /api/v1/users/me
  app.get('/me', { preHandler: requireUser }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { userRoles: { include: { role: true } } },
    })

    if (!user) return reply.status(404).send({ detail: 'User not found' })

    return reply.send({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      orgId: user.orgId,
      status: user.status,
      roles: user.userRoles.map((ur) => ur.role.name),
      preferences: user.preferences,
      lastActiveAt: user.lastActiveAt,
    })
  })

  // PATCH /api/v1/users/me
  app.patch('/me', { preHandler: requireUser }, async (req, reply) => {
    const body = UpdateUserSchema.parse(req.body)

    const updated = await prisma.user.update({
      where: { id: req.user.sub },
      data: body as any,
    })

    return reply.send({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      avatarUrl: updated.avatarUrl,
    })
  })

  // POST /api/v1/users/me/password — change own password
  app.post('/me/password', { preHandler: requireUser }, async (req, reply) => {
    const body = ChangePasswordSchema.parse(req.body)

    const user = await prisma.user.findUnique({ where: { id: req.user.sub } })
    if (!user) return reply.status(404).send({ detail: 'User not found' })

    const valid = await bcrypt.compare(body.oldPassword, user.passwordHash)
    if (!valid) {
      return reply.status(400).send({ detail: 'Current password is incorrect' })
    }

    const passwordHash = await bcrypt.hash(body.newPassword, 12)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    })

    await createAuditEvent({
      orgId: user.orgId,
      userId: user.id,
      action: AuditAction.PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip,
    })

    return reply.send({ message: 'Password changed successfully' })
  })

  // GET /api/v1/users — list org members
  app.get('/', { preHandler: requireUserOrAdminKey }, async (req, reply) => {
    const users = await prisma.user.findMany({
      where: { orgId: req.user.orgId, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
      orderBy: { name: 'asc' },
    })

    return reply.send(users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      status: u.status,
      lastActiveAt: u.lastActiveAt,
      roles: u.userRoles.map((ur) => ur.role.name),
    })))
  })
}
