/**
 * Single sign-on and SCIM settings — docs/41 Part 20.
 *
 * Sign-in (public), at /api/v1/auth/sso:
 *   POST /discover   { email }        — does this email's domain sign in with SSO? (+ where to start)
 *   GET  /start?email=&next=          — sets a short browser-binding cookie, redirects to the provider
 *   GET  /callback                    — the provider's redirect back: validates, signs the user in,
 *                                       and redirects to the web app with a one-time code
 *   POST /exchange   { code }         — the web app trades the code for its session tokens
 *
 * Admin (signed-in, configure:organization), at /api/v1/admin/sso:
 *   GET / · PUT / · DELETE /          — the OIDC connection (client secret never returned)
 *   POST /test                        — fetch the provider's discovery document
 *   GET /scim-tokens · POST /scim-tokens · DELETE /scim-tokens/:id
 *   GET /scim-groups · PATCH /scim-groups/:id { roleName }   — which role a group gives
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { AuditAction } from '@clm/types'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { encrypt } from '../lib/encryption.js'
import { createAuditEvent } from '../lib/audit.js'
import { issueSessionTokens } from '../lib/jwt.js'
import { requirePermission } from '../middleware/permissions.js'
import { requireUser, hashApiKey } from '../middleware/auth.js'
import { withoutTenantGuard } from '../lib/tenant-context.js'
import { signToken, verifyToken, pkcePair, type SignedClaims } from '../lib/integrations/signed-token.js'
import {
  ssoForEmail, oidcConfig, authorizationUrl, completeAuthorization, userForIdentity, ssoRedirectUri,
  validIssuer, DOMAIN, SsoError,
} from '../lib/sso/oidc.js'
import { SCIM_TOKEN_PREFIX, syncGroupRoles } from '../lib/sso/scim.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../lib/permissions.js'

const STATE_TTL_S = 10 * 60
const CODE_TTL_S = 60
const COOKIE = 'clm_sso'
const COOKIE_PATH = '/api/v1/auth/sso'
const stateKey = (nonce: string) => `sso-oidc:${nonce}`
const codeKey = (code: string) => `sso-code:${code}`
const appBase = () => (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')

/** Only an in-app path survives the round trip (no open redirect). */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next.slice(0, 500) : '/dashboard'
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

function cookie(value: string, maxAge: number): string {
  const secure = appBase().startsWith('https:') ? '; Secure' : ''
  return `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function authSsoRoutes(app: FastifyInstance) {
  const back = (reply: FastifyReply, params: Record<string, string>) =>
    reply.header('set-cookie', cookie('', 0)).redirect(`${appBase()}/login/sso?${new URLSearchParams(params)}`)

  app.post('/discover', async (req, reply) => {
    const body = z.object({ email: z.string().email().max(320), next: z.string().max(500).optional() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ detail: 'Enter your work email.' })
    const conn = await ssoForEmail(body.data.email)
    if (!conn) return reply.send({ sso: false })
    const q = new URLSearchParams({ email: body.data.email, next: safeNext(body.data.next) })
    return reply.send({ sso: true, startUrl: `/api/v1/auth/sso/start?${q}` })
  })

  app.get('/start', async (req, reply) => {
    const { email, next } = req.query as { email?: string; next?: string }
    const conn = email ? await ssoForEmail(email) : null
    if (!conn) return back(reply, { error: 'Single sign-on is not set up for that email domain.' })
    let config
    try { config = await oidcConfig(conn) }
    catch (err) { return back(reply, { error: (err as Error).message }) }
    const nonce = crypto.randomBytes(16).toString('base64url')
    const oidcNonce = crypto.randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkcePair()
    await redis.set(stateKey(nonce), JSON.stringify({ verifier, oidcNonce }), 'EX', STATE_TTL_S)
    const state = signToken('sso-oidc-state', { o: conn.orgId, n: nonce, next: safeNext(next) }, STATE_TTL_S)
    // The cookie ties the callback to this browser: a callback link someone
    // else started (login CSRF) arrives without it and is refused.
    reply.header('set-cookie', cookie(nonce, STATE_TTL_S))
    return reply.redirect(authorizationUrl(config, { state, nonce: oidcNonce, codeChallenge: challenge, loginHint: email }))
  })

  app.get('/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string }
    const claims = verifyToken<SignedClaims & { o: string; n: string; next: string }>('sso-oidc-state', q.state)
    if (!claims) return back(reply, { error: 'The sign-in link expired. Try again.' })
    if (readCookie(req.headers.cookie, COOKIE) !== claims.n) return back(reply, { error: 'This sign-in was started in another browser. Try again here.' })
    const stored = await redis.getdel(stateKey(claims.n))
    if (!stored) return back(reply, { error: 'This sign-in was already used. Try again.' })
    if (q.error) return back(reply, { error: q.error_description ?? q.error })
    const { verifier, oidcNonce } = JSON.parse(stored) as { verifier: string; oidcNonce: string }

    const conn = await withoutTenantGuard(() => prisma.ssoConnection.findFirst({ where: { orgId: claims.o, enabled: true } }))
    if (!conn) return back(reply, { error: 'Single sign-on is turned off for this workspace.' })
    try {
      const config = await oidcConfig(conn)
      // What the provider redirected to, as openid-client checks it against the redirect URI.
      const callbackUrl = new URL(ssoRedirectUri())
      for (const [k, v] of Object.entries(req.query as Record<string, string>)) callbackUrl.searchParams.set(k, v)
      const identity = await completeAuthorization(config, callbackUrl, { state: q.state!, nonce: oidcNonce, verifier })
      const user = await userForIdentity(conn, identity, req.ip)
      const code = crypto.randomBytes(32).toString('base64url')
      await redis.set(codeKey(code), JSON.stringify({ userId: user.id, orgId: user.orgId }), 'EX', CODE_TTL_S)
      await prisma.ssoConnection.updateMany({ where: { id: conn.id, orgId: conn.orgId }, data: { lastLoginAt: new Date() } })
      return back(reply, { code, next: claims.next })
    } catch (err) {
      req.log.warn({ err: (err as Error).message, orgId: claims.o }, 'SSO sign-in refused')
      return back(reply, { error: err instanceof SsoError ? err.message : 'Single sign-on failed. Try again or contact your admin.' })
    }
  })

  app.post('/exchange', async (req, reply) => {
    const body = z.object({ code: z.string().min(20).max(100) }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ detail: 'Invalid sign-in code' })
    const stored = await redis.getdel(codeKey(body.data.code))
    if (!stored) return reply.status(401).send({ detail: 'This sign-in code expired. Sign in again.' })
    const { userId, orgId } = JSON.parse(stored) as { userId: string; orgId: string }
    const user = await withoutTenantGuard(() => prisma.user.findFirst({
      where: { id: userId, orgId, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
    }))
    if (!user || user.status !== 'ACTIVE') return reply.status(403).send({ detail: 'Account deactivated. Contact your admin.' })
    const roles = user.userRoles.map(ur => ur.role.name)
    const tokens = issueSessionTokens({ sub: user.id, orgId: user.orgId, roles, sid: crypto.randomUUID() })
    await withoutTenantGuard(() => prisma.user.update({ where: { id: user.id }, data: { refreshToken: tokens.refreshToken, lastActiveAt: new Date() } }))
    await createAuditEvent({ orgId, userId: user.id, action: AuditAction.SSO_LOGIN, resourceType: 'user', resourceId: user.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] })
    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, orgId: user.orgId, avatarUrl: user.avatarUrl, status: user.status, roles },
      ...tokens,
    })
  })
}

// ─── Admin ────────────────────────────────────────────────────────────────────

const SsoConfigSchema = z.object({
  issuer:          z.string().url().max(500).refine(validIssuer, 'The issuer must be an https URL'),
  clientId:        z.string().min(1).max(300),
  clientSecret:    z.string().min(1).max(2000).optional(),
  allowedDomains:  z.array(z.string().trim().toLowerCase().regex(DOMAIN, 'Not a domain')).min(1).max(20),
  jitProvisioning: z.boolean().default(true),
  defaultRole:     z.string().min(1).max(64).default('VIEWER'),
  enabled:         z.boolean().default(false),
})

export async function adminSsoRoutes(app: FastifyInstance) {
  const admin = [requireUser, requirePermission('configure', 'organization')]

  app.get('/', { preHandler: admin }, async (req, reply) => {
    const conn = await prisma.ssoConnection.findFirst({ where: { orgId: req.user.orgId } })
    return reply.send({
      callbackUrl: ssoRedirectUri(),
      scimBaseUrl: `${(process.env.API_PUBLIC_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/scim/v2`,
      connection: conn ? {
        protocol: conn.protocol, issuer: conn.issuer, clientId: conn.clientId, hasClientSecret: !!conn.encryptedClientSecret,
        allowedDomains: conn.allowedDomains, jitProvisioning: conn.jitProvisioning, defaultRole: conn.defaultRole,
        enabled: conn.enabled, lastLoginAt: conn.lastLoginAt, updatedAt: conn.updatedAt,
      } : null,
    })
  })

  app.put('/', { preHandler: admin }, async (req, reply) => {
    let body
    try { body = SsoConfigSchema.parse(req.body) }
    catch (err) { return reply.status(400).send({ detail: 'Invalid request', issues: (err as { issues?: unknown }).issues }) }
    const { orgId, sub: userId } = req.user
    const existing = await prisma.ssoConnection.findFirst({ where: { orgId } })
    if (!existing && !body.clientSecret) return reply.status(400).send({ detail: 'Enter the client secret.' })

    const role = await prisma.role.findFirst({ where: { name: body.defaultRole, OR: [{ orgId }, { orgId: null, isSystem: true }] }, select: { id: true } })
    if (!role && !DEFAULT_ROLE_PERMISSIONS[body.defaultRole]) return reply.status(400).send({ detail: `No role named ${body.defaultRole}` })

    // A domain signs in to one workspace. Deliberately across orgs; the answer
    // names no other workspace.
    const domains = [...new Set(body.allowedDomains)]
    const claimed = await withoutTenantGuard(() => prisma.ssoConnection.findFirst({
      where: { orgId: { not: orgId }, allowedDomains: { hasSome: domains } }, select: { allowedDomains: true },
    }))
    if (claimed) {
      const taken = domains.filter(d => claimed.allowedDomains.includes(d))
      return reply.status(409).send({ detail: `${taken.join(', ')} already signs in to another workspace.` })
    }
    // Password sign-in stays on alongside SSO, so a broken provider setup
    // never locks the admin out.
    const data = {
      issuer: body.issuer.replace(/\/$/, ''), clientId: body.clientId, allowedDomains: domains,
      jitProvisioning: body.jitProvisioning, defaultRole: body.defaultRole, enabled: body.enabled,
      ...(body.clientSecret ? { encryptedClientSecret: encrypt(body.clientSecret) } : {}),
    }
    if (existing) await prisma.ssoConnection.updateMany({ where: { id: existing.id, orgId }, data })
    else await prisma.ssoConnection.create({ data: { orgId, createdById: userId, encryptedClientSecret: encrypt(body.clientSecret!), ...data } })
    await createAuditEvent({ orgId, userId, action: AuditAction.SSO_CONFIGURED, resourceType: 'sso_connection', resourceId: orgId, metadata: { issuer: data.issuer, domains, enabled: body.enabled, jitProvisioning: body.jitProvisioning, defaultRole: body.defaultRole, secretChanged: !!body.clientSecret }, ipAddress: req.ip })
    return reply.send({ ok: true })
  })

  app.delete('/', { preHandler: admin }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const r = await prisma.ssoConnection.deleteMany({ where: { orgId } })
    if (!r.count) return reply.status(404).send({ detail: 'Single sign-on is not set up' })
    await createAuditEvent({ orgId, userId, action: AuditAction.SSO_CONFIGURED, resourceType: 'sso_connection', resourceId: orgId, metadata: { removed: true }, ipAddress: req.ip })
    return reply.status(204).send()
  })

  app.post('/test', { preHandler: admin }, async (req, reply) => {
    const conn = await prisma.ssoConnection.findFirst({ where: { orgId: req.user.orgId } })
    if (!conn) return reply.status(404).send({ detail: 'Save the connection first' })
    try {
      const config = await oidcConfig(conn)
      const meta = config.serverMetadata()
      return reply.send({ ok: true, issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint })
    } catch (err) {
      return reply.send({ ok: false, detail: (err as Error).message })
    }
  })

  // ── SCIM tokens ──
  app.get('/scim-tokens', { preHandler: admin }, async (req, reply) => {
    const data = await prisma.scimToken.findMany({
      where: { orgId: req.user.orgId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, name: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    })
    return reply.send({ data })
  })

  app.post('/scim-tokens', { preHandler: admin }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ detail: 'Name the token (e.g. "Okta")' })
    const { orgId, sub: userId } = req.user
    const token = `${SCIM_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
    const created = await prisma.scimToken.create({
      data: { orgId, name: body.data.name, tokenHash: hashApiKey(token), prefix: token.slice(0, 12), createdById: userId },
      select: { id: true, name: true, prefix: true, createdAt: true },
    })
    await createAuditEvent({ orgId, userId, action: AuditAction.SCIM_TOKEN_CREATED, resourceType: 'scim_token', resourceId: created.id, metadata: { name: created.name }, ipAddress: req.ip })
    // Shown once, like an API key: we keep only its hash.
    return reply.status(201).send({ ...created, token })
  })

  app.delete('/scim-tokens/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { orgId, sub: userId } = req.user
    const r = await prisma.scimToken.updateMany({ where: { id, orgId, revokedAt: null }, data: { revokedAt: new Date() } })
    if (!r.count) return reply.status(404).send({ detail: 'Token not found' })
    await createAuditEvent({ orgId, userId, action: AuditAction.SCIM_TOKEN_REVOKED, resourceType: 'scim_token', resourceId: id, ipAddress: req.ip })
    return reply.status(204).send()
  })

  // ── Groups → roles ──
  app.get('/scim-groups', { preHandler: admin }, async (req, reply) => {
    const data = await prisma.scimGroup.findMany({ where: { orgId: req.user.orgId }, orderBy: { displayName: 'asc' }, take: 200 })
    return reply.send({ data: data.map(g => ({ id: g.id, displayName: g.displayName, roleName: g.roleName, memberCount: g.memberIds.length, updatedAt: g.updatedAt })) })
  })

  app.patch('/scim-groups/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ roleName: z.string().min(1).max(64).nullable() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ detail: 'Pick a role, or none' })
    const { orgId, sub: userId } = req.user
    const group = await prisma.scimGroup.findFirst({ where: { id, orgId } })
    if (!group) return reply.status(404).send({ detail: 'Group not found' })
    if (body.data.roleName) {
      const role = await prisma.role.findFirst({ where: { name: body.data.roleName, OR: [{ orgId }, { orgId: null, isSystem: true }] }, select: { id: true } })
      if (!role && !DEFAULT_ROLE_PERMISSIONS[body.data.roleName]) return reply.status(400).send({ detail: `No role named ${body.data.roleName}` })
    }
    // Members lose the old role (it was the group's), then gain the new one.
    await syncGroupRoles(orgId, group, group.memberIds, [])
    await prisma.scimGroup.updateMany({ where: { id, orgId }, data: { roleName: body.data.roleName } })
    await syncGroupRoles(orgId, { id, roleName: body.data.roleName }, [], group.memberIds)
    await createAuditEvent({ orgId, userId, action: AuditAction.ROLE_CHANGED, resourceType: 'scim_group', resourceId: id, metadata: { group: group.displayName, from: group.roleName, to: body.data.roleName }, ipAddress: req.ip })
    return reply.send({ ok: true })
  })
}

