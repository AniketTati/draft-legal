/**
 * docs/41 Part 20 — OIDC single sign-on, per org (Okta, Entra ID, Google
 * Workspace, OneLogin, JumpCloud: anything that speaks OpenID Connect).
 *
 * Sign-in finds the org by the email's domain (`SsoConnection.allowedDomains`),
 * then runs the authorization-code flow with PKCE and a nonce through
 * `openid-client`, which validates the ID token (issuer, audience, signature
 * against the provider's published keys, expiry, nonce). We then require:
 *
 *   - an email, not marked unverified, in one of the connection's domains;
 *   - a user of that org with that email (active, or invited: signing in
 *     through the org's own identity provider accepts the invitation), or,
 *     with just-in-time provisioning on, a new user with the default role.
 *
 * A user of another org is never signed in here (emails are unique across
 * orgs, so that user is someone else's).
 */
import * as client from 'openid-client'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import type { SsoConnection } from '@prisma/client'
import { AuditAction } from '@clm/types'
import { prisma } from '../prisma.js'
import { decrypt } from '../encryption.js'
import { createAuditEvent } from '../audit.js'
import { withoutTenantGuard } from '../tenant-context.js'
import { roleIdFor } from './scim.js'
import { isStrict } from '../runtime-mode.js'

export class SsoError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'SsoError' }
}

export const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  const d = at > 0 ? email.slice(at + 1).trim().toLowerCase() : ''
  return DOMAIN.test(d) ? d : null
}

export function ssoRedirectUri(): string {
  const base = (process.env.API_PUBLIC_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  return process.env.SSO_REDIRECT_URI ?? `${base}/api/v1/auth/sso/callback`
}

/** An issuer an admin may enter: https (http only for a local provider on a developer's stack). */
export function validIssuer(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return !u.username && !u.password && !u.hash
    return u.protocol === 'http:' && !isStrict() && ['localhost', '127.0.0.1'].includes(u.hostname)
  } catch { return false }
}

/** The enabled connection whose domains include this email's. Across orgs, by design. */
export async function ssoForEmail(email: string): Promise<SsoConnection | null> {
  const domain = emailDomain(email)
  if (!domain) return null
  return withoutTenantGuard(() => prisma.ssoConnection.findFirst({ where: { enabled: true, allowedDomains: { has: domain } } }))
}

// Discovery results, per connection version, for ten minutes: every sign-in
// otherwise fetches the provider's metadata again.
const configs = new Map<string, { at: number; config: client.Configuration }>()
const CONFIG_TTL_MS = 10 * 60_000

export async function oidcConfig(conn: SsoConnection): Promise<client.Configuration> {
  const key = `${conn.id}:${conn.updatedAt.getTime()}`
  const hit = configs.get(key)
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config
  const insecure = conn.issuer.startsWith('http:')
  let config: client.Configuration
  try {
    // The ID token comes straight from the token endpoint over TLS, where the
    // spec lets a client skip its signature; we check it against the
    // provider's published keys anyway (non-repudiation checks).
    config = await client.discovery(new URL(conn.issuer), conn.clientId, decrypt(conn.encryptedClientSecret), undefined, {
      execute: [client.enableNonRepudiationChecks, ...(insecure ? [client.allowInsecureRequests] : [])],
    })
  } catch (err) {
    throw new SsoError(`Could not reach the identity provider at ${conn.issuer}: ${(err as Error).message}`, 502)
  }
  configs.set(key, { at: Date.now(), config })
  return config
}

export function clearOidcCache(): void { configs.clear() }

/** The provider's sign-in URL, with PKCE, state and nonce. */
export function authorizationUrl(config: client.Configuration, input: { state: string; nonce: string; codeChallenge: string; loginHint?: string }): string {
  return client.buildAuthorizationUrl(config, {
    redirect_uri: ssoRedirectUri(),
    scope: 'openid email profile',
    response_type: 'code',
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  }).href
}

export interface SsoIdentity { subject: string; email: string; name: string | null }

/** Exchange the callback's code and return who signed in (ID token validated by openid-client). */
export async function completeAuthorization(config: client.Configuration, callbackUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<SsoIdentity> {
  let tokens
  try {
    tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    })
  } catch (err) {
    throw new SsoError(`The identity provider's answer was refused: ${(err as Error).message}`, 401)
  }
  const claims = tokens.claims()
  if (!claims?.sub) throw new SsoError('The identity provider sent no subject', 401)
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!email) throw new SsoError('The identity provider did not share an email address. Ask your admin to add the email scope.', 401)
  if (claims.email_verified === false) throw new SsoError('Your email address is not verified at your identity provider.', 401)
  const name = typeof claims.name === 'string' ? claims.name
    : [claims.given_name, claims.family_name].filter(v => typeof v === 'string').join(' ') || null
  return { subject: String(claims.sub), email, name }
}

/**
 * The draftLegal user for an identity, created when the connection allows it.
 * Returns the user and their role names, as sign-in needs them.
 */
export async function userForIdentity(conn: SsoConnection, identity: SsoIdentity, ipAddress?: string): Promise<{ id: string; orgId: string; email: string; name: string; avatarUrl: string | null; status: string; roles: string[] }> {
  const domain = emailDomain(identity.email)
  if (!domain || !conn.allowedDomains.includes(domain)) throw new SsoError(`${identity.email} is not in a domain this workspace signs in.`, 403)

  // Emails are unique across orgs: look everywhere, to refuse another org's user.
  let user = await withoutTenantGuard(() => prisma.user.findUnique({
    where: { email: identity.email },
    include: { userRoles: { include: { role: true } } },
  }))
  if (user && (user.orgId !== conn.orgId || user.deletedAt)) throw new SsoError('This account belongs to another workspace. Contact your admin.', 403)
  if (user?.status === 'DEACTIVATED') throw new SsoError('Account deactivated. Contact your admin.', 403)

  if (!user) {
    if (!conn.jitProvisioning) throw new SsoError('You have no account in this workspace yet. Ask your admin to invite you.', 403)
    const roleId = await roleIdFor(conn.orgId, conn.defaultRole)
    user = await prisma.user.create({
      data: {
        orgId: conn.orgId,
        email: identity.email,
        name: identity.name ?? identity.email.split('@')[0],
        // No password: this user signs in through the identity provider. A
        // random hash keeps the password form from ever matching.
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10),
        status: 'ACTIVE',
        ...(roleId ? { userRoles: { create: [{ roleId, grantedBy: 'sso' }] } } : {}),
      },
      include: { userRoles: { include: { role: true } } },
    })
    await createAuditEvent({ orgId: conn.orgId, userId: user.id, action: AuditAction.USER_PROVISIONED, resourceType: 'user', resourceId: user.id, metadata: { via: 'sso', role: roleId ? conn.defaultRole : null }, ipAddress })
  } else if (user.status === 'INVITED') {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', inviteToken: null, inviteExpiresAt: null },
      include: { userRoles: { include: { role: true } } },
    })
  }

  // The provider's subject is the identity; the email only finds the user the
  // first time. A subject linked to another user, or a user linked to another
  // subject, is a different person with this email (a reused address).
  const [bySubject, byUser] = await Promise.all([
    prisma.identityLink.findFirst({ where: { orgId: conn.orgId, provider: 'oidc', subject: identity.subject } }),
    prisma.identityLink.findFirst({ where: { orgId: conn.orgId, provider: 'oidc', userId: user.id } }),
  ])
  if ((bySubject && bySubject.userId !== user.id) || (byUser && byUser.subject !== identity.subject)) {
    throw new SsoError('This email is linked to another identity at your provider. Contact your admin.', 403)
  }
  if (!bySubject) await prisma.identityLink.create({ data: { orgId: conn.orgId, userId: user.id, provider: 'oidc', subject: identity.subject } })

  return { id: user.id, orgId: user.orgId, email: user.email, name: user.name, avatarUrl: user.avatarUrl, status: user.status, roles: user.userRoles.map(ur => ur.role.name) }
}
