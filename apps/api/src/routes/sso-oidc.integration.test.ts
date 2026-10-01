/**
 * docs/41 Part 20 — OIDC single sign-on against a mocked identity provider:
 * discovery, JWKS and the token endpoint answer from a stubbed fetch, and ID
 * tokens are signed with a key made here. No network.
 *
 *   - an email in the connection's domain is sent to the provider; the
 *     callback validates the ID token (signature, audience, nonce), creates
 *     the user just in time with the default role, and the web app trades a
 *     one-time code for a session;
 *   - a callback from another browser (no binding cookie), an email outside
 *     the domains, another org's user, a reused code or a forged ID token
 *     signs nobody in.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'

if (Buffer.from(process.env.AI_KEY_ENCRYPTION_KEY ?? '', 'base64').length !== 32) process.env.AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import { getApp, closeApp, makeOrg, makeUser, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { clearOidcCache } from '../lib/sso/oidc.js'
import { verifyToken as verifySession } from '../lib/jwt.js'

const ISSUER = 'https://idp.acme-sso.example'
const CLIENT_ID = 'draftlegal-client'
const DOMAIN = `acme-sso-${randomUUID().slice(0, 6)}.example`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }

/** What the provider's token endpoint returns next. */
let nextIdentity: { sub: string; email: string; name?: string; email_verified?: boolean; forge?: boolean } = { sub: 'u1', email: '' }
/** The nonce the authorization URL carried (the provider echoes it). */
let nonceFromAuthorize = ''

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function idToken(): string {
  const { forge, ...claims } = nextIdentity
  return jwt.sign({ ...claims, nonce: nonceFromAuthorize }, forge ? forger.privateKey : privateKey, {
    algorithm: 'RS256', keyid: 'k1', issuer: ISSUER, audience: CLIENT_ID, expiresIn: 300,
  })
}

const realFetch = globalThis.fetch
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      })
    }
    if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] })
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body ?? (input instanceof Request ? await input.text() : '')))
      if (!body.get('code_verifier')) return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers: { 'content-type': 'application/json' } })
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken() })
    }
    return realFetch(input as never, init)
  }))
})

let app: TestApp
let org: string, otherOrg: string, admin: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('SSO Org')
  otherOrg = await makeOrg('SSO Other Org')
  admin = await makeUser(org)
  await grantRole(org, admin, 'ADMIN')
  clearOidcCache()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const orgId of [org, otherOrg]) {
    await prisma.identityLink.deleteMany({ where: { orgId } })
    await prisma.ssoConnection.deleteMany({ where: { orgId } })
  }
  await cleanupAll()
  await closeApp()
})

/** Start a sign-in as the browser would: discover, follow /start, read the provider URL. */
async function start(email: string) {
  const d = await app.inject({ method: 'POST', url: '/api/v1/auth/sso/discover', payload: { email, next: '/contracts' } })
  expect(d.json().sso).toBe(true)
  const s = await app.inject({ method: 'GET', url: d.json().startUrl })
  expect(s.statusCode).toBe(302)
  const location = new URL(s.headers.location as string)
  expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`)
  nonceFromAuthorize = location.searchParams.get('nonce')!
  const cookie = String(s.headers['set-cookie']).split(';')[0]
  return { state: location.searchParams.get('state')!, cookie, location }
}

async function callback(state: string, cookie?: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/auth/sso/callback?code=code-${randomUUID()}&state=${encodeURIComponent(state)}`, headers: cookie ? { cookie } : {} })
  expect(res.statusCode).toBe(302)
  return new URL(res.headers.location as string)
}

describe('setting up SSO', () => {
  it('saves the connection without ever returning the secret, and refuses a domain another workspace has', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/admin/sso', headers: auth(org, ['ADMIN'], admin),
      payload: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'super-secret', allowedDomains: [DOMAIN.toUpperCase()], jitProvisioning: true, defaultRole: 'LEGAL_COUNSEL', enabled: true },
    })
    expect(put.statusCode).toBe(200)
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/sso', headers: auth(org, ['ADMIN'], admin) })
    expect(get.json().connection).toMatchObject({ issuer: ISSUER, allowedDomains: [DOMAIN], hasClientSecret: true, enabled: true })
    expect(JSON.stringify(get.json())).not.toContain('super-secret')

    const test = await app.inject({ method: 'POST', url: '/api/v1/admin/sso/test', headers: auth(org, ['ADMIN'], admin) })
    expect(test.json()).toMatchObject({ ok: true, tokenEndpoint: `${ISSUER}/token` })

    const otherAdmin = await makeUser(otherOrg)
    const clash = await app.inject({
      method: 'PUT', url: '/api/v1/admin/sso', headers: auth(otherOrg, ['ADMIN'], otherAdmin),
      payload: { issuer: ISSUER, clientId: 'x', clientSecret: 'y', allowedDomains: [DOMAIN], enabled: true },
    })
    expect(clash.statusCode).toBe(409)
  })

  it('says no SSO for a domain nobody set up', async () => {
    const d = await app.inject({ method: 'POST', url: '/api/v1/auth/sso/discover', payload: { email: 'someone@no-sso.example' } })
    expect(d.json()).toEqual({ sso: false })
  })
})

describe('signing in', () => {
  const email = `jane-${randomUUID().slice(0, 6)}@${DOMAIN}`

  it('validates the provider\'s ID token, creates the user with the default role, and hands over a session once', async () => {
    const { state, cookie, location } = await start(email)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    nextIdentity = { sub: 'okta-jane', email, name: 'Jane Okta', email_verified: true }

    const back = await callback(state, cookie)
    expect(back.pathname).toBe('/login/sso')
    expect(back.searchParams.get('error')).toBeNull()
    expect(back.searchParams.get('next')).toBe('/contracts')
    const code = back.searchParams.get('code')!

    const ex = await app.inject({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code } })
    expect(ex.statusCode).toBe(200)
    const body = ex.json()
    expect(body.user).toMatchObject({ email, name: 'Jane Okta', orgId: org, roles: ['LEGAL_COUNSEL'] })
    expect(verifySession(body.accessToken)).toMatchObject({ orgId: org, roles: ['LEGAL_COUNSEL'], type: 'access' })
    const link = await prisma.identityLink.findFirstOrThrow({ where: { orgId: org, provider: 'oidc', subject: 'okta-jane' } })
    expect(link.userId).toBe(body.user.id)

    // The code works once.
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { code } })
    expect(again.statusCode).toBe(401)
    // The state works once too.
    const replay = await callback(state, cookie)
    expect(replay.searchParams.get('error')).toMatch(/already used/)
  })

  it('signs the same person in again without a second account', async () => {
    const { state, cookie } = await start(email)
    nextIdentity = { sub: 'okta-jane', email }
    const back = await callback(state, cookie)
    expect(back.searchParams.get('code')).toBeTruthy()
    expect(await prisma.user.count({ where: { email } })).toBe(1)
  })

  it('refuses a callback from a browser that did not start the sign-in', async () => {
    const { state } = await start(email)
    nextIdentity = { sub: 'okta-jane', email }
    const back = await callback(state, 'clm_sso=someone-else')
    expect(back.searchParams.get('error')).toMatch(/another browser/)
    expect(back.searchParams.get('code')).toBeNull()
  })

  it('refuses an ID token not signed by the provider', async () => {
    const { state, cookie } = await start(email)
    nextIdentity = { sub: 'okta-jane', email, forge: true }
    const back = await callback(state, cookie)
    expect(back.searchParams.get('code')).toBeNull()
    expect(back.searchParams.get('error')).toBeTruthy()
  })

  it('refuses an email outside the workspace\'s domains, even from its provider', async () => {
    const { state, cookie } = await start(email)
    nextIdentity = { sub: 'okta-mallory', email: 'mallory@elsewhere.example' }
    const back = await callback(state, cookie)
    expect(back.searchParams.get('error')).toMatch(/not in a domain/)
  })

  it('never signs in another workspace\'s user', async () => {
    const theirs = `bob-${randomUUID().slice(0, 6)}@${DOMAIN}`
    await prisma.user.create({ data: { orgId: otherOrg, email: theirs, passwordHash: 'x', name: 'Bob' } })
    const { state, cookie } = await start(theirs)
    nextIdentity = { sub: 'okta-bob', email: theirs }
    const back = await callback(state, cookie)
    expect(back.searchParams.get('error')).toMatch(/another workspace/)
  })

  it('refuses a deactivated user, and a new one when just-in-time provisioning is off', async () => {
    await prisma.user.update({ where: { email }, data: { status: 'DEACTIVATED' } })
    let s = await start(email)
    nextIdentity = { sub: 'okta-jane', email }
    expect((await callback(s.state, s.cookie)).searchParams.get('error')).toMatch(/deactivated/)

    await prisma.ssoConnection.updateMany({ where: { orgId: org }, data: { jitProvisioning: false } })
    clearOidcCache()
    const fresh = `new-${randomUUID().slice(0, 6)}@${DOMAIN}`
    s = await start(fresh)
    nextIdentity = { sub: 'okta-new', email: fresh }
    expect((await callback(s.state, s.cookie)).searchParams.get('error')).toMatch(/invite you/)
    expect(await prisma.user.count({ where: { email: fresh } })).toBe(0)
  })
})
