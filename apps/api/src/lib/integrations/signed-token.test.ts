/**
 * docs/41 Parts 17 and 20 — signed OAuth state and embed tokens: tamper,
 * expiry and purpose are all refused; PKCE pairs verify.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'

beforeAll(() => { process.env.JWT_SECRET ??= 'unit-test-jwt-secret-that-is-long-enough-32' })

const load = async () => ({ ...(await import('./signed-token.js')), ...(await import('./embed.js')) })

describe('signed tokens', () => {
  it('round-trips claims for their purpose', async () => {
    const { signToken, verifyToken } = await load()
    const t = signToken('salesforce-oauth-state', { o: 'org1', n: 'abc' }, 60)
    expect(verifyToken('salesforce-oauth-state', t)).toMatchObject({ o: 'org1', n: 'abc' })
  })

  it('refuses a token signed for another purpose', async () => {
    const { signToken, verifyToken } = await load()
    const state = signToken('salesforce-oauth-state', { o: 'org1' }, 60)
    expect(verifyToken('contract-embed', state)).toBeNull()
    expect(verifyToken('sso-oidc-state', state)).toBeNull()
  })

  it('refuses a changed body or signature', async () => {
    const { signToken, verifyToken } = await load()
    const t = signToken('sso-oidc-state', { o: 'org1' }, 60)
    const [body, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), o: 'org2' })).toString('base64url')
    expect(verifyToken('sso-oidc-state', `${forged}.${sig}`)).toBeNull()
    expect(verifyToken('sso-oidc-state', `${body}.${sig.slice(0, -2)}xx`)).toBeNull()
    expect(verifyToken('sso-oidc-state', 'not-a-token')).toBeNull()
    expect(verifyToken('sso-oidc-state', undefined)).toBeNull()
  })

  it('refuses an expired token', async () => {
    const { signToken, verifyToken } = await load()
    const t = signToken('sso-oidc-state', { o: 'org1' }, 60)
    expect(verifyToken('sso-oidc-state', t, Date.now() + 61_000)).toBeNull()
  })

  it('makes an S256 PKCE pair', async () => {
    const { pkcePair } = await load()
    const { verifier, challenge } = pkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('embed tokens', () => {
  it('allow reading one contract of one org, for minutes', async () => {
    const { signEmbedToken, verifyEmbedToken } = await load()
    const t = signEmbedToken('org1', 'c1')
    expect(verifyEmbedToken(t, 'c1')).toMatchObject({ orgId: 'org1', contractId: 'c1' })
    expect(verifyEmbedToken(t, 'c2')).toBeNull()
    expect(verifyEmbedToken(t, 'c1', Date.now() + 11 * 60_000)).toBeNull()
  })

  it('cap their lifetime at an hour whatever is asked', async () => {
    const { signEmbedToken, verifyEmbedToken } = await load()
    const t = signEmbedToken('org1', 'c1', 24 * 3600)
    expect(verifyEmbedToken(t, 'c1', Date.now() + 61 * 60_000)).toBeNull()
  })
})
