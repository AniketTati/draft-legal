/**
 * SCIM 2.0 provisioning — docs/41 Part 20. Served at /scim/v2 for an identity
 * provider (Okta, Entra ID, OneLogin, JumpCloud), authenticated by the org's
 * SCIM bearer token (Settings → Integrations → Single sign-on), stored hashed.
 *
 *   GET    /ServiceProviderConfig
 *   GET    /Users?filter=userName eq "a@b.com"&startIndex=1&count=100
 *   POST   /Users                 GET/PUT/PATCH/DELETE /Users/:id
 *   GET    /Groups?filter=displayName eq "Legal"
 *   POST   /Groups                GET/PUT/PATCH/DELETE /Groups/:id
 *
 * DELETE of a user deactivates them (their history stays); `active: false`
 * does the same. A group's members get the role an admin chose for it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { AuditAction } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { hashApiKey } from '../middleware/auth.js'
import { setTenant, withoutTenantGuard } from '../lib/tenant-context.js'
import { createAuditEvent } from '../lib/audit.js'
import {
  SCIM_TOKEN_PREFIX, scimError, listResponse, toScimUser, toScimGroup, parseFilter,
  scimBool, scimEmail, scimName, userPatchChanges, groupPatchChanges, deactivateUser, syncGroupRoles, type UserChanges,
} from '../lib/sso/scim.js'

declare module 'fastify' {
  interface FastifyRequest { scim?: { orgId: string; tokenId: string } }
}

const MAX_PAGE = 200

function baseUrl(): string {
  return `${(process.env.API_PUBLIC_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/scim/v2`
}

const send = (reply: FastifyReply, status: number, body: unknown) =>
  reply.status(status).header('content-type', 'application/scim+json; charset=utf-8').send(body)
const fail = (reply: FastifyReply, status: number, detail: string, scimType?: string) => send(reply, status, scimError(status, detail, scimType))

async function scimAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token.startsWith(SCIM_TOKEN_PREFIX)) return fail(reply, 401, 'A SCIM bearer token is required')
  // Before a tenant is known: the token names it.
  const row = await withoutTenantGuard(() => prisma.scimToken.findUnique({ where: { tokenHash: hashApiKey(token) }, select: { id: true, orgId: true, revokedAt: true } }))
  if (!row || row.revokedAt) return fail(reply, 401, 'SCIM token invalid or revoked')
  req.scim = { orgId: row.orgId, tokenId: row.id }
  setTenant(row.orgId)
  prisma.scimToken.updateMany({ where: { id: row.id, orgId: row.orgId }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
}

function paging(q: { startIndex?: string; count?: string }) {
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1)
  const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(q.count ?? '100', 10) || 100))
  return { startIndex, count, skip: startIndex - 1 }
}

async function externalIds(orgId: string, userIds: string[]): Promise<Map<string, string>> {
  const links = await prisma.identityLink.findMany({ where: { orgId, provider: 'scim', userId: { in: userIds } }, select: { userId: true, subject: true } })
  return new Map(links.map(l => [l.userId, l.subject]))
}

async function setExternalId(orgId: string, userId: string, externalId: string | undefined): Promise<void> {
  if (!externalId) return
  await prisma.identityLink.deleteMany({ where: { orgId, provider: 'scim', OR: [{ userId }, { subject: externalId }] } })
  await prisma.identityLink.create({ data: { orgId, userId, provider: 'scim', subject: externalId } })
}

async function audit(req: FastifyRequest, action: AuditAction, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  await createAuditEvent({ orgId: req.scim!.orgId, action, resourceType, resourceId, metadata: { via: 'scim', scimTokenId: req.scim!.tokenId, ...metadata }, ipAddress: req.ip })
}

export async function scimRoutes(app: FastifyInstance) {
  // Identity providers send SCIM's own media type.
  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}) }
    catch (err) { (err as { statusCode?: number }).statusCode = 400; done(err as Error, undefined) }
  })
  app.addHook('preHandler', scimAuth)

  app.get('/ServiceProviderConfig', async (_req, reply) => send(reply, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE }, changePassword: { supported: false },
    sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token from Settings → Integrations → Single sign-on', primary: true }],
  }))

  // ── Users ──

  app.get('/Users', async (req, reply) => {
    const orgId = req.scim!.orgId
    const q = req.query as { filter?: string; startIndex?: string; count?: string }
    const filter = parseFilter(q.filter)
    if (filter === 'invalid') return fail(reply, 400, 'Only `attribute eq "value"` filters are supported', 'invalidFilter')
    const { startIndex, count, skip } = paging(q)
    let where: Record<string, unknown> = { orgId, deletedAt: null }
    if (filter) {
      if (filter.attribute === 'username' || filter.attribute === 'emails.value' || filter.attribute === 'emails') where = { ...where, email: { equals: filter.value, mode: 'insensitive' } }
      else if (filter.attribute === 'externalid') {
        const link = await prisma.identityLink.findFirst({ where: { orgId, provider: 'scim', subject: filter.value }, select: { userId: true } })
        where = { ...where, id: link?.userId ?? '__none__' }
      } else return fail(reply, 400, `Filtering on ${filter.attribute} is not supported`, 'invalidFilter')
    }
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: count }),
    ])
    const ext = await externalIds(orgId, users.map(u => u.id))
    return send(reply, 200, listResponse(users.map(u => toScimUser(u, ext.get(u.id) ?? null, baseUrl())), total, startIndex))
  })

  app.get('/Users/:id', async (req, reply) => {
    const orgId = req.scim!.orgId
    const { id } = req.params as { id: string }
    const user = await prisma.user.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!user) return fail(reply, 404, 'User not found')
    const ext = await externalIds(orgId, [id])
    return send(reply, 200, toScimUser(user, ext.get(id) ?? null, baseUrl()))
  })

  app.post('/Users', async (req, reply) => {
    const orgId = req.scim!.orgId
    const body = (req.body ?? {}) as Record<string, unknown>
    const email = scimEmail(body)
    if (!email) return fail(reply, 400, 'userName (or a primary email) must be an email address', 'invalidValue')
    const name = scimName(body) ?? email.split('@')[0]
    const active = scimBool(body.active) ?? true
    const externalId = typeof body.externalId === 'string' ? body.externalId : undefined

    // Emails are unique across orgs: another org's user is a conflict, never adopted.
    const existing = await withoutTenantGuard(() => prisma.user.findUnique({ where: { email } }))
    if (existing && (existing.orgId !== orgId || existing.deletedAt)) return fail(reply, 409, 'A user with this userName already exists', 'uniqueness')
    let user
    if (existing) {
      // Already in this org (invited or made by hand): the provider takes it over.
      const linked = await prisma.identityLink.count({ where: { orgId, provider: 'scim', userId: existing.id } })
      if (linked) return fail(reply, 409, 'A user with this userName already exists', 'uniqueness')
      user = await prisma.user.update({ where: { id: existing.id }, data: { name, ...(active && existing.status === 'INVITED' ? { status: 'ACTIVE', inviteToken: null, inviteExpiresAt: null } : {}) } })
      if (!active) await deactivateUser(orgId, user.id)
    } else {
      user = await prisma.user.create({
        data: {
          orgId, email, name,
          // Signs in through SSO; a random hash keeps the password form from matching.
          passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10),
          status: active ? 'ACTIVE' : 'DEACTIVATED',
        },
      })
    }
    await setExternalId(orgId, user.id, externalId)
    await audit(req, AuditAction.USER_PROVISIONED, 'user', user.id, { email, adopted: !!existing, active })
    const fresh = await prisma.user.findFirstOrThrow({ where: { id: user.id, orgId } })
    return send(reply, 201, toScimUser(fresh, externalId ?? null, baseUrl()))
  })

  async function applyUserChanges(req: FastifyRequest, reply: FastifyReply, id: string, changes: UserChanges) {
    const orgId = req.scim!.orgId
    const user = await prisma.user.findFirst({ where: { id, orgId, deletedAt: null } })
    if (!user) return fail(reply, 404, 'User not found')
    if (changes.email && changes.email !== user.email) {
      const taken = await withoutTenantGuard(() => prisma.user.findUnique({ where: { email: changes.email! }, select: { id: true } }))
      if (taken && taken.id !== id) return fail(reply, 409, 'A user with this userName already exists', 'uniqueness')
    }
    await prisma.user.update({
      where: { id },
      data: {
        ...(changes.name ? { name: changes.name } : {}),
        ...(changes.email ? { email: changes.email } : {}),
        ...(changes.active === true && user.status !== 'ACTIVE' ? { status: 'ACTIVE' } : {}),
      },
    })
    if (changes.active === false && user.status !== 'DEACTIVATED') {
      const r = await deactivateUser(orgId, id)
      await audit(req, AuditAction.USER_DEACTIVATED, 'user', id, r)
    } else if (changes.active === true && user.status === 'DEACTIVATED') {
      await audit(req, AuditAction.USER_REACTIVATED, 'user', id, {})
    }
    await setExternalId(orgId, id, changes.externalId)
    const fresh = await prisma.user.findFirstOrThrow({ where: { id, orgId } })
    const ext = await externalIds(orgId, [id])
    return send(reply, 200, toScimUser(fresh, ext.get(id) ?? null, baseUrl()))
  }

  app.put('/Users/:id', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { id } = req.params as { id: string }
    return applyUserChanges(req, reply, id, {
      name: scimName(body) ?? undefined,
      email: scimEmail(body) ?? undefined,
      active: scimBool(body.active),
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    })
  })

  app.patch('/Users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const changes = userPatchChanges((req.body as { Operations?: unknown } | null)?.Operations)
    if (changes === 'invalid') return fail(reply, 400, 'Operations must be an array', 'invalidSyntax')
    return applyUserChanges(req, reply, id, changes)
  })

  app.delete('/Users/:id', async (req, reply) => {
    const orgId = req.scim!.orgId
    const { id } = req.params as { id: string }
    const user = await prisma.user.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true, status: true } })
    if (!user) return fail(reply, 404, 'User not found')
    if (user.status !== 'DEACTIVATED') {
      const r = await deactivateUser(orgId, id)
      await audit(req, AuditAction.USER_DEACTIVATED, 'user', id, { ...r, deleted: true })
    }
    return reply.status(204).send()
  })

  // ── Groups ──

  async function groupView(orgId: string, group: { id: string; memberIds: string[] } & Parameters<typeof toScimGroup>[0]) {
    const members = await prisma.user.findMany({ where: { orgId, id: { in: group.memberIds } }, select: { id: true, email: true } })
    return toScimGroup(group, members, baseUrl())
  }

  /** Member ids that are users of this org (others are dropped). */
  async function ownMembers(orgId: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return []
    const users = await prisma.user.findMany({ where: { orgId, id: { in: [...new Set(ids)] }, deletedAt: null }, select: { id: true } })
    return users.map(u => u.id)
  }

  app.get('/Groups', async (req, reply) => {
    const orgId = req.scim!.orgId
    const q = req.query as { filter?: string; startIndex?: string; count?: string }
    const filter = parseFilter(q.filter)
    if (filter === 'invalid') return fail(reply, 400, 'Only `attribute eq "value"` filters are supported', 'invalidFilter')
    const { startIndex, count, skip } = paging(q)
    let where: Record<string, unknown> = { orgId }
    if (filter) {
      if (filter.attribute === 'displayname') where = { ...where, displayName: filter.value }
      else if (filter.attribute === 'externalid') where = { ...where, externalId: filter.value }
      else return fail(reply, 400, `Filtering on ${filter.attribute} is not supported`, 'invalidFilter')
    }
    const [total, groups] = await Promise.all([
      prisma.scimGroup.count({ where }),
      prisma.scimGroup.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: count }),
    ])
    return send(reply, 200, listResponse(await Promise.all(groups.map(g => groupView(orgId, g))), total, startIndex))
  })

  app.get('/Groups/:id', async (req, reply) => {
    const orgId = req.scim!.orgId
    const { id } = req.params as { id: string }
    const group = await prisma.scimGroup.findFirst({ where: { id, orgId } })
    if (!group) return fail(reply, 404, 'Group not found')
    return send(reply, 200, await groupView(orgId, group))
  })

  app.post('/Groups', async (req, reply) => {
    const orgId = req.scim!.orgId
    const body = (req.body ?? {}) as { displayName?: unknown; externalId?: unknown; members?: unknown }
    if (typeof body.displayName !== 'string' || !body.displayName.trim()) return fail(reply, 400, 'displayName is required', 'invalidValue')
    const exists = await prisma.scimGroup.findFirst({ where: { orgId, displayName: body.displayName.trim() }, select: { id: true } })
    if (exists) return fail(reply, 409, 'A group with this displayName already exists', 'uniqueness')
    const memberIds = await ownMembers(orgId, (Array.isArray(body.members) ? body.members : []).map(m => (m as { value?: unknown }).value).filter((v): v is string => typeof v === 'string'))
    const group = await prisma.scimGroup.create({
      data: { orgId, displayName: body.displayName.trim().slice(0, 200), externalId: typeof body.externalId === 'string' ? body.externalId : null, memberIds },
    })
    await syncGroupRoles(orgId, group, [], memberIds)
    return send(reply, 201, await groupView(orgId, group))
  })

  async function updateGroup(req: FastifyRequest, reply: FastifyReply, id: string, next: { displayName?: string; members?: string[]; add?: string[]; remove?: string[] }) {
    const orgId = req.scim!.orgId
    const group = await prisma.scimGroup.findFirst({ where: { id, orgId } })
    if (!group) return fail(reply, 404, 'Group not found')
    let members = next.members ? await ownMembers(orgId, next.members) : [...group.memberIds]
    if (next.add?.length) members = [...new Set([...members, ...await ownMembers(orgId, next.add)])]
    if (next.remove?.length) members = members.filter(m => !next.remove!.includes(m))
    const updated = await prisma.scimGroup.update({
      where: { id },
      data: { memberIds: members, ...(next.displayName ? { displayName: next.displayName.trim().slice(0, 200) } : {}) },
    })
    await syncGroupRoles(orgId, updated, group.memberIds, members)
    return send(reply, 200, await groupView(orgId, updated))
  }

  app.put('/Groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { displayName?: unknown; members?: unknown }
    const members = (Array.isArray(body.members) ? body.members : []).map(m => (m as { value?: unknown }).value).filter((v): v is string => typeof v === 'string')
    return updateGroup(req, reply, id, { displayName: typeof body.displayName === 'string' ? body.displayName : undefined, members })
  })

  app.patch('/Groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const ops = groupPatchChanges((req.body as { Operations?: unknown } | null)?.Operations)
    if (ops === 'invalid') return fail(reply, 400, 'Operations must be an array', 'invalidSyntax')
    return updateGroup(req, reply, id, { displayName: ops.displayName, members: ops.replaceMembers, add: ops.add, remove: ops.remove })
  })

  app.delete('/Groups/:id', async (req, reply) => {
    const orgId = req.scim!.orgId
    const { id } = req.params as { id: string }
    const group = await prisma.scimGroup.findFirst({ where: { id, orgId } })
    if (!group) return fail(reply, 404, 'Group not found')
    await syncGroupRoles(orgId, group, group.memberIds, [])
    await prisma.scimGroup.deleteMany({ where: { id, orgId } })
    return reply.status(204).send()
  })
}

