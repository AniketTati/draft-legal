/**
 * Admin user management routes — invite, deactivate, reactivate, role assign.
 * All endpoints require 'configure:user' permission.
 */
import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { requirePermission } from '../middleware/permissions.js'
import { requireUserOrAdminKey } from '../middleware/auth.js'
import { createAuditEvent } from '../lib/audit.js'
import { invalidatePermissionCache, DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_DESCRIPTIONS } from '../lib/permissions.js'
import { InviteUserSchema, AssignRoleSchema, BulkImportUserSchema, AuditAction } from '@clm/types'

export async function adminUserRoutes(app: FastifyInstance) {
  const adminGuard = requirePermission('configure', 'user')

  // POST /api/v1/admin/users/invite — invite a user to the org
  app.post('/invite', { preHandler: adminGuard }, async (req, reply) => {
    const body = InviteUserSchema.parse(req.body)
    const { orgId } = req.user

    // P7.0.1 — Email is now globally unique (one user per email across all
    // orgs). Check across the entire DB, not just this org, so we surface a
    // useful error before the DB constraint fires with an opaque P2002.
    const existing = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, orgId: true, deletedAt: true },
    })
    if (existing && !existing.deletedAt) {
      const sameOrg = existing.orgId === orgId
      return reply.status(409).send({
        detail: sameOrg
          ? 'User with this email already exists in this organization'
          : 'A user with this email already has an account in another workspace. Ask them to use a different email or contact support to merge accounts.',
      })
    }

    // Generate invite token (32 bytes hex = 64 chars)
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    // Resolve role IDs
    const roles = await prisma.role.findMany({
      where: {
        OR: [{ orgId }, { orgId: null, isSystem: true }],
        name: { in: body.roles },
      },
    })

    if (roles.length !== body.roles.length) {
      const found = roles.map(r => r.name)
      const missing = body.roles.filter(r => !found.includes(r))
      return reply.status(400).send({ detail: `Roles not found: ${missing.join(', ')}` })
    }

    const user = await prisma.user.create({
      data: {
        orgId,
        email: body.email,
        name: body.name,
        passwordHash: '', // No password yet — set on accept-invite
        status: 'INVITED',
        inviteToken,
        inviteExpiresAt,
        userRoles: {
          create: roles.map(r => ({ roleId: r.id, grantedBy: req.user.sub })),
        },
      },
      include: { userRoles: { include: { role: true } } },
    })

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.USER_INVITED,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: body.email, roles: body.roles },
      ipAddress: req.ip,
    })

    return reply.status(201).send({
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      inviteToken, // Frontend needs this to construct the invite link
      inviteExpiresAt,
      roles: user.userRoles.map(ur => ur.role.name),
    })
  })

  // GET /api/v1/admin/users/:id — get single user detail
  app.get('/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await prisma.user.findFirst({
      where: { id, orgId: req.user.orgId, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
    })

    if (!user) return reply.status(404).send({ detail: 'User not found' })

    return reply.send({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      status: user.status,
      lastActiveAt: user.lastActiveAt,
      roles: user.userRoles.map(ur => ur.role.name),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
  })

  // PATCH /api/v1/admin/users/:id/roles — assign/replace roles
  app.patch('/:id/roles', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = AssignRoleSchema.parse(req.body)
    const { orgId } = req.user

    // Verify user exists in same org
    const user = await prisma.user.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!user) return reply.status(404).send({ detail: 'User not found' })

    // Prevent removing own ADMIN role
    if (user.id === req.user.sub && !body.roles.includes('ADMIN' as any)) {
      return reply.status(400).send({ detail: 'Cannot remove your own ADMIN role' })
    }

    // Resolve role IDs
    const roles = await prisma.role.findMany({
      where: {
        OR: [{ orgId }, { orgId: null, isSystem: true }],
        name: { in: body.roles },
      },
    })

    if (roles.length !== body.roles.length) {
      const found = roles.map(r => r.name)
      const missing = body.roles.filter(r => !found.includes(r))
      return reply.status(400).send({ detail: `Roles not found: ${missing.join(', ')}` })
    }

    // Replace all user roles in a transaction
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: id } }),
      ...roles.map(r =>
        prisma.userRole.create({
          data: { userId: id, roleId: r.id, grantedBy: req.user.sub },
        })
      ),
    ])

    invalidatePermissionCache(orgId)

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.ROLE_CHANGED,
      resourceType: 'user',
      resourceId: id,
      metadata: { newRoles: body.roles, changedBy: req.user.sub },
      ipAddress: req.ip,
    })

    return reply.send({ message: 'Roles updated', roles: body.roles })
  })

  // POST /api/v1/admin/users/:id/deactivate
  app.post('/:id/deactivate', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    if (id === req.user.sub) {
      return reply.status(400).send({ detail: 'Cannot deactivate yourself' })
    }

    const user = await prisma.user.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!user) return reply.status(404).send({ detail: 'User not found' })
    if (user.status === 'DEACTIVATED') {
      return reply.status(400).send({ detail: 'User is already deactivated' })
    }

    await prisma.user.update({
      where: { id },
      data: { status: 'DEACTIVATED', refreshToken: null },
    })
    // X43 — and their API keys: a key never checks who made it, so an admin's
    // `admin`-scope key kept full access after they left.
    const keys = await prisma.apiKey.updateMany({
      where: { orgId, createdById: id, revokedAt: null },
      data:  { revokedAt: new Date() },
    })

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.USER_DEACTIVATED,
      resourceType: 'user',
      resourceId: id,
      metadata: { apiKeysRevoked: keys.count },
      ipAddress: req.ip,
    })

    return reply.send({ message: 'User deactivated' })
  })

  // POST /api/v1/admin/users/:id/reactivate
  app.post('/:id/reactivate', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId } = req.user

    const user = await prisma.user.findFirst({
      where: { id, orgId, deletedAt: null },
    })
    if (!user) return reply.status(404).send({ detail: 'User not found' })
    if (user.status !== 'DEACTIVATED') {
      return reply.status(400).send({ detail: 'User is not deactivated' })
    }

    await prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE' },
    })

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.USER_REACTIVATED,
      resourceType: 'user',
      resourceId: id,
      ipAddress: req.ip,
    })

    return reply.send({ message: 'User reactivated' })
  })

  // POST /api/v1/admin/users/bulk-import — bulk invite users via JSON array
  app.post('/bulk-import', { preHandler: adminGuard }, async (req, reply) => {
    const users = BulkImportUserSchema.parse(req.body)
    const { orgId } = req.user

    const results: { created: string[]; skipped: string[]; errors: Array<{ email: string; reason: string }> } = {
      created: [],
      skipped: [],
      errors: [],
    }

    // Pre-fetch existing emails
    const existingUsers = await prisma.user.findMany({
      where: { orgId, email: { in: users.map(u => u.email) }, deletedAt: null },
      select: { email: true },
    })
    const existingEmails = new Set(existingUsers.map(u => u.email))

    // Pre-fetch all roles for this org
    const allRoles = await prisma.role.findMany({
      where: { OR: [{ orgId }, { orgId: null, isSystem: true }] },
    })
    const rolesByName = new Map(allRoles.map(r => [r.name, r.id]))

    for (const u of users) {
      if (existingEmails.has(u.email)) {
        results.skipped.push(u.email)
        continue
      }

      const missingRoles = u.roles.filter(r => !rolesByName.has(r))
      if (missingRoles.length > 0) {
        results.errors.push({ email: u.email, reason: `Invalid roles: ${missingRoles.join(', ')}` })
        continue
      }

      const inviteToken = crypto.randomBytes(32).toString('hex')
      const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await prisma.user.create({
        data: {
          orgId,
          email: u.email,
          name: u.name,
          passwordHash: '',
          status: 'INVITED',
          inviteToken,
          inviteExpiresAt,
          userRoles: {
            create: u.roles.map(r => ({ roleId: rolesByName.get(r)!, grantedBy: req.user.sub })),
          },
        },
      })

      results.created.push(u.email)
    }

    await createAuditEvent({
      orgId,
      userId: req.user.sub,
      action: AuditAction.USER_INVITED,
      resourceType: 'user',
      resourceId: 'bulk',
      metadata: { count: results.created.length, skipped: results.skipped.length, errors: results.errors.length },
      ipAddress: req.ip,
    })

    return reply.send(results)
  })

  // GET /api/v1/admin/roles — list roles with permissions
  // FIX (2026-04-30 audit): every authenticated org member needs to read this
  // because the web client's usePermission() hook depends on it to compute
  // RoleGate visibility. Restricting to view:user broke non-admin pages with
  // 403 floods. The role catalogue is org-scoped and not sensitive.
  app.get('/roles', { preHandler: requireUserOrAdminKey }, async (req, reply) => {
    const roles = await prisma.role.findMany({
      where: {
        OR: [{ orgId: req.user.orgId }, { orgId: null, isSystem: true }],
      },
      orderBy: { name: 'asc' },
    })

    return reply.send(roles.map(r => ({
      id: r.id,
      orgId: r.orgId,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      isSystem: r.isSystem,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })))
  })
}
