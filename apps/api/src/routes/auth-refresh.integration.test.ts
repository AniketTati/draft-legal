/**
 * X50 — the server keeps one refresh token per user and rotates it on each
 * refresh, but it looked the token up and replaced it in two steps: two
 * refreshes racing with the same token could both answer 200, and when the
 * new tokens differed (a second boundary between them) the loser's were
 * already dead. Rotation now happens only while the token is still the
 * current one — which also stops a refresh reviving a session a sign-out or
 * a deactivation just ended.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { signRefreshToken } from '../lib/jwt.js'
import { getApp, closeApp, makeOrg, makeUser, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Refresh Race Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } })

describe('POST /auth/refresh', () => {
  it('two refreshes racing with the same token: one wins, the other is refused', async () => {
    // A token the server won't reissue byte for byte (the user has no roles
    // now), so rotation really replaces it.
    const token = signRefreshToken({ sub: user, orgId: org, roles: ['FORMER_ROLE'] })
    await prisma.user.update({ where: { id: user }, data: { refreshToken: token } })

    // Hold each lookup of this token until both requests have read it, as two
    // requests arriving together do (inject would otherwise run them in turn).
    // (A $use hook can't be removed and the integration files share one
    // client, so it switches itself off when this test is done.)
    let read = 0
    let active = true
    let bothRead!: () => void
    const barrier = new Promise<void>(r => { bothRead = r })
    prisma.$use(async (params, next) => {
      const result = await next(params)
      if (active && params.model === 'User' && params.action === 'findFirst' && params.args?.where?.refreshToken === token) {
        if (++read === 2) bothRead()
        await Promise.race([barrier, new Promise(r => setTimeout(r, 2_000))])
      }
      return result
    })

    const results = await Promise.all([refresh(token), refresh(token)])
    active = false
    expect(read).toBe(2)
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 401])
    const winner = results.find(r => r.statusCode === 200)!
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user } })).refreshToken).toBe(winner.json().refreshToken)
  })

  it('a refresh with the current token still works, and the old token then stops working', async () => {
    const token = signRefreshToken({ sub: user, orgId: org, roles: ['FORMER_ROLE'] })
    await prisma.user.update({ where: { id: user }, data: { refreshToken: token } })
    const first = await refresh(token)
    expect(first.statusCode).toBe(200)
    expect(first.json().refreshToken).not.toBe(token)
    expect((await refresh(token)).statusCode).toBe(401)
    expect((await refresh(first.json().refreshToken)).statusCode).toBe(200)
  })
})
