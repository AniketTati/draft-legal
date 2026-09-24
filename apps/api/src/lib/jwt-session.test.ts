/**
 * X73 — sign-in and refresh responses said `expiresIn: 900` whatever
 * JWT_ACCESS_EXPIRES_IN set, so a client timing its refresh by it was wrong
 * whenever the lifetime was configured.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  delete process.env.JWT_ACCESS_EXPIRES_IN
  vi.resetModules()
})

async function tokensWith(lifetime: string | undefined) {
  vi.resetModules()
  if (lifetime === undefined) delete process.env.JWT_ACCESS_EXPIRES_IN
  else process.env.JWT_ACCESS_EXPIRES_IN = lifetime
  const { issueSessionTokens, verifyToken } = await import('./jwt.js')
  const tokens = issueSessionTokens({ sub: 'u1', orgId: 'o1', roles: ['ADMIN'], sid: 's1' })
  return { tokens, access: verifyToken(tokens.accessToken) as unknown as { iat: number; exp: number } }
}

describe('issueSessionTokens', () => {
  it('reports the access token\'s configured lifetime', async () => {
    const { tokens, access } = await tokensWith('1h')
    expect(tokens.expiresIn).toBe(3600)
    expect(access.exp - access.iat).toBe(3600)
  })

  it('reports 15 minutes by default', async () => {
    expect((await tokensWith(undefined)).tokens.expiresIn).toBe(900)
  })
})
