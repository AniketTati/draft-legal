import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { issueSessionTokens, verifyToken } from '../lib/jwt.js'
import { createAuditEvent } from '../lib/audit.js'
import { seedOrgDefaults } from '../lib/org-seed.js'
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_DESCRIPTIONS } from '../lib/permissions.js'
import { LoginSchema, RegisterSchema, RefreshTokenSchema, AcceptInviteSchema, ChangePasswordSchema } from '@clm/types'
import { AuditAction } from '@clm/types'
import { isTest } from '../lib/runtime-mode.js'

// P20 — per-email login throttle. The Fastify rate-limit hook fires
// before body parsing, so it can't see the email; we apply it manually
// inside the handler. Bucket: 10 attempts per 15 minutes per email.
// IP-keyed throttle stays at the route-config level (covers spray
// attacks across many emails from one IP).
const LOGIN_PER_EMAIL_MAX     = 10
const LOGIN_PER_EMAIL_WINDOW  = 15 * 60     // seconds
async function emailThrottleHit(email: string): Promise<{ tooMany: boolean; remaining: number }> {
  const key   = `login-attempt:${email.toLowerCase()}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, LOGIN_PER_EMAIL_WINDOW)
  return {
    tooMany:   count > LOGIN_PER_EMAIL_MAX,
    remaining: Math.max(0, LOGIN_PER_EMAIL_MAX - count),
  }
}
async function emailThrottleReset(email: string): Promise<void> {
  await redis.del(`login-attempt:${email.toLowerCase()}`)
}

export async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/register
  // Tight cap to prevent automated org-creation spam: 5 per IP per
  // hour. Genuine users register once; anything beyond that is a bot.
  app.post('/register', {
    config: {
      rateLimit: isTest() ? false : {
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: (req) => `register:${req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Too Many Requests',
          detail: 'Too many registration attempts. Try again in an hour.',
        }),
      },
    },
  }, async (req, reply) => {
    const body = RegisterSchema.parse(req.body)

    // Create org if orgName provided, else require existing org (invite flow later)
    let orgId: string

    let orgSlug: string
    if (body.orgName) {
      orgSlug = body.orgSlug ?? body.orgName.toLowerCase().replace(/\s+/g, '-')
      const org = await prisma.organization.create({
        data: { name: body.orgName, slug: orgSlug },
      })
      orgId = org.id
    } else {
      return reply.status(400).send({ detail: 'orgName required for self-registration' })
    }

    // P7.0.1 — Email is globally unique, so check across the whole DB.
    // A user trying to "self-register a new org" with an email that
    // already has an account anywhere should be told to log in instead.
    const existing = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, deletedAt: true },
    })
    if (existing && !existing.deletedAt) {
      return reply.status(409).send({
        detail: 'An account with this email already exists. Please log in or use a different email.',
      })
    }

    const passwordHash = await bcrypt.hash(body.password, 12)

    // Create all system roles for the new org
    const systemRoleNames = Object.keys(DEFAULT_ROLE_PERMISSIONS)
    for (const roleName of systemRoleNames) {
      await prisma.role.upsert({
        where: { orgId_name: { orgId, name: roleName } },
        create: {
          orgId, name: roleName, isSystem: true,
          permissions: (DEFAULT_ROLE_PERMISSIONS[roleName] ?? []) as any,
          description: DEFAULT_ROLE_DESCRIPTIONS[roleName] ?? null,
        },
        update: {
          permissions: (DEFAULT_ROLE_PERMISSIONS[roleName] ?? []) as any,
          description: DEFAULT_ROLE_DESCRIPTIONS[roleName] ?? null,
        },
      })
    }

    const adminRole = await prisma.role.findFirst({
      where: { orgId, name: 'ADMIN' },
    })

    const user = await prisma.user.create({
      data: {
        orgId,
        email: body.email,
        passwordHash,
        name: body.name,
        userRoles: { create: { roleId: adminRole!.id } },
      },
    })

    const tokens = issueTokens(user.id, orgId, ['ADMIN'], crypto.randomUUID())

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: tokens.refreshToken },
    })

    // Provision default templates, clause library, and playbook in background
    seedOrgDefaults(orgId, orgSlug, user.id).catch(err =>
      console.error('[org-seed] failed for org', orgId, err)
    )

    await createAuditEvent({
      orgId,
      userId: user.id,
      action: AuditAction.USER_CREATED,
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip,
    })

    return reply.status(201).send({ user: { ...safeUser(user), roles: ['ADMIN'] }, ...tokens })
  })

  // POST /api/v1/auth/login
  // Brute-force shield (production audit, 2026-04-29). Three layers:
  //   1. Global 1000/min already applied at app.ts level — soaks burst
  //      enumeration attempts.
  //   2. IP-keyed at the route config below — 60 attempts per 15 min
  //      per IP. Catches one attacker spraying many emails from a
  //      single host. Real users typing the wrong password 5-6 times
  //      stay well under.
  //   3. Email-keyed manually after body parse (see emailThrottleHit
  //      above) — 10 per 15 min per email. Catches distributed-IP
  //      attacks against a known target mailbox; this is the real
  //      brute-force defense and what attackers actually pivot around.
  // Bypass all three in test mode so the audit harness can run
  // thousands of logins back-to-back.
  app.post('/login', {
    config: {
      rateLimit: isTest() ? false : {
        // 200 attempts per 15 min per IP. Generous enough for real
        // user sessions (auto-retry on stale tokens, multiple tabs)
        // and the probe runner; tight enough to slow a one-IP brute-
        // force grind by 10×. The real defense is the per-email
        // throttle below.
        max: 200,
        timeWindow: '15 minutes',
        keyGenerator: (req) => `login-ip:${req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Too Many Requests',
          detail: 'Too many login attempts from your network. Try again in 15 minutes.',
        }),
      },
    },
  }, async (req, reply) => {
    const body = LoginSchema.parse(req.body)

    // Layer 3: per-email throttle. We check BEFORE bcrypt.compare so
    // an attacker can't measure response time to learn whether the
    // email exists. We also DON'T leak whether they hit the throttle
    // before reaching auth — same "Too many login attempts" message
    // either way.
    if (!isTest()) {
      const { tooMany } = await emailThrottleHit(body.email)
      if (tooMany) {
        return reply.status(429).send({
          detail: 'Too many login attempts. Try again in 15 minutes.',
        })
      }
    }

    // P7.0.1 — `findUnique({ email })` per the new globally-unique-email
    // constraint. Previously this used `findFirst` with no orgId scope, which
    // caused F-30 (multi-tenant routing bug): when two orgs had a user with
    // the same email, the older row won and the JWT was issued for the wrong
    // org. With `email @unique` enforced at the DB level (migration
    // `20260425090000_globally_unique_user_email`) there is exactly one
    // candidate per email — no ambiguity, no wrong-tenant routing.
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { userRoles: { include: { role: true } } },
    })

    if (!user || user.deletedAt || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return reply.status(401).send({ detail: 'Invalid email or password' })
    }

    if (user.status === 'DEACTIVATED') {
      return reply.status(403).send({ detail: 'Account deactivated. Contact your admin.' })
    }

    if (user.status === 'INVITED') {
      return reply.status(403).send({ detail: 'Please accept your invitation first.' })
    }

    const roles = user.userRoles.map((ur) => ur.role.name)
    const tokens = issueTokens(user.id, user.orgId, roles, crypto.randomUUID())

    // Reset the per-email throttle on a successful login. A user
    // who's been locked out can fix their typo and get back in
    // without waiting the full 15-min window.
    if (!isTest()) await emailThrottleReset(body.email)

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: tokens.refreshToken, lastActiveAt: new Date() },
    })

    await createAuditEvent({
      orgId: user.orgId,
      userId: user.id,
      action: AuditAction.USER_LOGIN,
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    return reply.send({ user: { ...safeUser(user), roles }, ...tokens })
  })

  // POST /api/v1/auth/refresh
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = RefreshTokenSchema.parse(req.body)

    let payload
    try {
      payload = verifyToken(refreshToken)
      if (payload.type !== 'refresh') throw new Error()
    } catch {
      return reply.status(401).send({ detail: 'Invalid refresh token' })
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.sub, refreshToken, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
    })

    if (!user) {
      return reply.status(401).send({ detail: 'Refresh token revoked' })
    }

    const roles = user.userRoles.map((ur) => ur.role.name)
    // A token from before sessions had ids gets one derived from it, so two
    // refreshes racing with it still mint the same tokens (below).
    const sid = payload.sid ?? crypto.createHash('sha256').update(refreshToken).digest('hex').slice(0, 32)
    const tokens = issueTokens(user.id, user.orgId, roles, sid)

    // X50 — rotate only while this is still the current token. Two refreshes
    // racing with the same token both passed the lookup above and both
    // answered 200, and the tokens the loser got were dead on arrival.
    const rotated = await prisma.user.updateMany({
      where: { id: user.id, refreshToken, deletedAt: null },
      data: { refreshToken: tokens.refreshToken },
    })
    if (rotated.count === 0) {
      // The race was lost — but a winner refreshing the same session in the
      // same second minted these very tokens (signing is deterministic, `iat`
      // is whole seconds, and a sign-in starts a new `sid`), and they are the
      // current ones: hand them over, as before, rather than refuse a
      // harmless race.
      const current = await prisma.user.count({
        where: { id: user.id, refreshToken: tokens.refreshToken, deletedAt: null },
      })
      if (current === 0) return reply.status(401).send({ detail: 'Refresh token revoked' })
    }

    return reply.send(tokens)
  })

  // GET /api/v1/auth/invites/:token
  //
  // P7.4.8 / F-09 — pre-validate the invite token on mount of the
  // /accept-invite/:token page so we can show "invalid or expired"
  // instead of pretending everything's fine until POST submit. We
  // ALSO surface the inviter's org name + the invitee's email so the
  // user knows what they're accepting into.
  //
  // Security: do NOT distinguish "invalid" from "expired" from
  // "already-used" — return one bucket. Otherwise an attacker could
  // probe the token space.
  app.get<{ Params: { token: string } }>('/invites/:token', async (req, reply) => {
    const { token } = req.params
    if (!token || token.length < 16) {
      return reply.status(404).send({ detail: 'Invalid or expired invite' })
    }

    const user = await prisma.user.findFirst({
      where: { inviteToken: token, status: 'INVITED', deletedAt: null },
      include: { org: { select: { name: true } } },
    })

    if (!user) {
      return reply.status(404).send({ detail: 'Invalid or expired invite' })
    }
    if (user.inviteExpiresAt && user.inviteExpiresAt < new Date()) {
      return reply.status(404).send({ detail: 'Invalid or expired invite' })
    }

    return reply.send({
      email: user.email,
      orgName: user.org.name,
      // Returning the inviter's name would be richer but we don't
      // currently store invitedBy on the user record. Add later if
      // we want to render "Sara invited you to Demo Org".
    })
  })

  // POST /api/v1/auth/accept-invite
  app.post('/accept-invite', async (req, reply) => {
    const body = AcceptInviteSchema.parse(req.body)

    const user = await prisma.user.findFirst({
      where: { inviteToken: body.token, status: 'INVITED', deletedAt: null },
      include: { org: true },
    })

    if (!user) {
      return reply.status(404).send({ detail: 'Invalid or expired invite token' })
    }

    if (user.inviteExpiresAt && user.inviteExpiresAt < new Date()) {
      return reply.status(410).send({ detail: 'Invite has expired' })
    }

    const passwordHash = await bcrypt.hash(body.password, 12)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        name: body.name ?? user.name,
        status: 'ACTIVE',
        inviteToken: null,
        inviteExpiresAt: null,
        lastActiveAt: new Date(),
      },
    })

    await createAuditEvent({
      orgId: user.orgId,
      userId: user.id,
      action: AuditAction.USER_CREATED,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { method: 'invite_accepted' },
      ipAddress: req.ip,
    })

    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: { userRoles: { include: { role: true } } },
    })
    const roles = updatedUser?.userRoles.map(ur => ur.role.name) ?? []

    return reply.send({
      message: 'Invite accepted. You can now log in.',
      email: user.email,
      orgName: user.org.name,
      roles,
    })
  })

  // POST /api/v1/auth/request-password-reset
  //
  // U.6.3 — replaces the old "ask your admin" stub on /login with a
  // real round-trip. We don't have email delivery yet (A.6 territory),
  // but we DO have an in-app notifications table and an admin role,
  // so we can give the user something useful right now: dispatching
  // a "Password reset requested" notification to every admin in the
  // matching org. The admin sees it in their bell tray and can reset
  // via Admin → Users.
  //
  // Security:
  //   - Response is always 200 with the same body, regardless of
  //     whether the email exists. Don't leak account existence.
  //   - Rate-limited by Fastify's global rate limit (already on /auth).
  //   - We do NOT issue a token here, log them in, or expose admin
  //     names to the (unauthenticated) requester.
  app.post('/request-password-reset', async (req, reply) => {
    const body = req.body as { email?: string } | null
    const email = (body?.email ?? '').trim().toLowerCase()

    // Validate the shape only — never reveal whether email matches.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ detail: 'Invalid email format' })
    }

    // Run the lookup-and-notify in the background (don't await) so the
    // response time is constant whether the email exists or not (mitigates
    // timing-based account enumeration).
    ;(async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, name: true, orgId: true, deletedAt: true },
        })
        if (!user || user.deletedAt) return

        // Find every admin in the user's org.
        const admins = await prisma.userRole.findMany({
          where: {
            user: { orgId: user.orgId, deletedAt: null },
            role: { name: 'ADMIN', orgId: user.orgId },
          },
          select: { userId: true },
        })

        if (admins.length === 0) return

        await prisma.notification.createMany({
          data: admins.map(({ userId }) => ({
            orgId: user.orgId,
            userId,
            type: 'PASSWORD_RESET_REQUEST',
            title: 'Password reset requested',
            body: `${user.name} (${email}) asked for a password reset. Open Admin → Users to send them a new temporary password.`,
            resourceType: 'user',
            resourceId: user.id,
          })),
        })

        await createAuditEvent({
          orgId: user.orgId,
          userId: user.id,
          action: AuditAction.PASSWORD_RESET_REQUESTED,
          resourceType: 'user',
          resourceId: user.id,
          ipAddress: req.ip,
          metadata: { adminCount: admins.length },
        })
      } catch (err) {
        req.log.error({ err }, 'request-password-reset background task failed')
      }
    })()

    // Constant-shape response.
    return reply.send({
      ok: true,
      message:
        'If an account exists for that email, your administrator has been notified. They will send you a new temporary password.',
    })
  })

  // POST /api/v1/auth/logout
  app.post('/logout', async (req, reply) => {
    // Whose session ends: the access token's user or, once that token has
    // expired (15 idle minutes), the user whose current refresh token this
    // is (X50 review). Before, a sign-out after a pause ended nothing on the
    // server, and other tabs kept the session going.
    let who: { sub: string; orgId: string } | null = null
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(header.slice(7))
        who = { sub: payload.sub, orgId: payload.orgId }
      } catch { /* expired or invalid */ }
    }
    const refreshToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken
    if (!who && typeof refreshToken === 'string') {
      try {
        const payload = verifyToken(refreshToken)
        // Only the current token: an old one can't end a newer session.
        if (payload.type === 'refresh' && await prisma.user.count({ where: { id: payload.sub, refreshToken } })) {
          who = { sub: payload.sub, orgId: payload.orgId }
        }
      } catch { /* expired or invalid */ }
    }
    if (who) {
      try {
        await prisma.user.update({
          where: { id: who.sub },
          data: { refreshToken: null },
        })
        await createAuditEvent({
          orgId: who.orgId,
          userId: who.sub,
          action: AuditAction.USER_LOGOUT,
          resourceType: 'user',
          resourceId: who.sub,
        })
      } catch { /* ignore */ }
    }
    return reply.status(204).send()
  })
}

function issueTokens(userId: string, orgId: string, roles: string[], sid: string) {
  return issueSessionTokens({ sub: userId, orgId, roles, sid })
}

function safeUser(user: { id: string; email: string; name: string; orgId: string; avatarUrl: string | null; status?: string }) {
  return { id: user.id, email: user.email, name: user.name, orgId: user.orgId, avatarUrl: user.avatarUrl, status: user.status ?? 'ACTIVE' }
}
