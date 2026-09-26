/**
 * X50 — the server keeps one refresh token per user and rotates it on each
 * refresh, but it looked the token up and replaced it in two steps: two
 * refreshes racing with the same token could both answer 200, and when the
 * new tokens differed (a second boundary between them) the loser's were
 * already dead. Rotation now happens only while the token is still the
 * current one — which also stops a refresh reviving a session a sign-out or
 * a deactivation just ended. A race inside one second, where both mint the
 * same tokens, still hands both of them that current pair.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { signRefreshToken } from '../lib/jwt.js'
import { usePrismaMiddleware } from '../lib/prisma.js'
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

/**
 * Two refreshes with `token`, as two requests arriving together: each lookup
 * of the token is held until both have read it (inject would otherwise run
 * them in turn). Then both mint in the same second or, with `acrossASecond`,
 * the second waits until the first has rotated the token and a new second
 * has begun, so their tokens differ. (Prisma middleware can't be removed and the
 * integration files share one client, so it switches itself off after.)
 */
async function race(token: string, acrossASecond: boolean) {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)))
  const nextSecond = () => (Math.floor(Date.now() / 1000) + 1) * 1000 + 20
  let reads = 0
  let active = true
  let bothRead!: () => void
  const barrier = new Promise<void>(r => { bothRead = r })
  let rotated!: () => void
  const firstRotated = new Promise<void>(r => { rotated = r })
  let resumeAt: number | undefined
  usePrismaMiddleware(async (params, next) => {
    const result = await next(params)
    if (!active || params.model !== 'User') return result
    const where = params.args?.where ?? {}
    if ((params.action === 'update' || params.action === 'updateMany') && where.id === user && params.args?.data?.refreshToken) rotated()
    if (params.action === 'findFirst' && where.refreshToken === token && result) {
      const order = ++reads
      if (reads === 2) bothRead()
      let timer!: NodeJS.Timeout
      await Promise.race([barrier, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the two lookups never met')), 5_000) })])
        .finally(() => clearTimeout(timer))
      if (!acrossASecond) {
        resumeAt ??= nextSecond()
        await sleep(resumeAt - Date.now())
      } else if (order === 2) {
        await firstRotated
        await sleep(nextSecond() - Date.now())
      }
    }
    return result
  })
  try {
    const results = await Promise.all([refresh(token), refresh(token)])
    return { results, reads }
  } finally {
    active = false
  }
}

/** A token the server won't reissue byte for byte (the user has no roles now), so rotation really replaces it. */
async function currentToken() {
  const token = signRefreshToken({ sub: user, orgId: org, roles: ['FORMER_ROLE'] })
  await prisma.user.update({ where: { id: user }, data: { refreshToken: token } })
  return token
}
const stored = async () => (await prisma.user.findUniqueOrThrow({ where: { id: user } })).refreshToken

/**
 * Runs `request`, holding its lookup of `token` until `meanwhile` is done,
 * which starts just after a second begins so it all falls inside one second.
 */
async function whileLookupHeld(token: string, meanwhile: () => Promise<void>, request: () => ReturnType<typeof refresh>) {
  let active = true
  usePrismaMiddleware(async (params, next) => {
    const result = await next(params)
    if (active && result && params.model === 'User' && params.action === 'findFirst' && params.args?.where?.refreshToken === token) {
      active = false
      await new Promise(r => setTimeout(r, (Math.floor(Date.now() / 1000) + 1) * 1000 + 20 - Date.now()))
      await meanwhile()
    }
    return result
  })
  try {
    return await request()
  } finally {
    active = false
  }
}

describe('POST /auth/refresh', () => {
  it('two refreshes racing with the same token in one second both get the one current pair', async () => {
    const { results, reads } = await race(await currentToken(), false)
    expect(reads).toBe(2)
    expect(results.map(r => r.statusCode)).toEqual([200, 200])
    expect(results[0].json().refreshToken).toBe(results[1].json().refreshToken)
    expect(await stored()).toBe(results[0].json().refreshToken)
  })

  it('racing across a second boundary: the loser is refused, and the winner\'s tokens stay alive', async () => {
    const { results, reads } = await race(await currentToken(), true)
    expect(reads).toBe(2)
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 401])
    const winner = results.find(r => r.statusCode === 200)!
    expect(await stored()).toBe(winner.json().refreshToken)
    expect((await refresh(winner.json().refreshToken)).statusCode).toBe(200)
  })

  it('X50 review — a refresh of a session signed out and in again in the same second gets nothing from the new one', async () => {
    await prisma.user.update({ where: { id: user }, data: { passwordHash: await bcrypt.hash('it-refresh-password', 4) } })
    const { email } = await prisma.user.findUniqueOrThrow({ where: { id: user } })
    const signIn = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'it-refresh-password' } })
    const first = await signIn()
    expect(first.statusCode).toBe(200)
    let second!: Awaited<ReturnType<typeof signIn>>
    const res = await whileLookupHeld(first.json().refreshToken, async () => {
      await prisma.user.update({ where: { id: user }, data: { refreshToken: null } })   // signed out…
      second = await signIn()                                                              // …and in again
    }, () => refresh(first.json().refreshToken))
    expect(second.statusCode).toBe(200)
    expect(res.statusCode).toBe(401)
    expect(await stored()).toBe(second.json().refreshToken)
  })

  it('X50 review — a refresh of a session signed out meanwhile is refused', async () => {
    const token = await currentToken()
    const res = await whileLookupHeld(token, async () => {
      await prisma.user.update({ where: { id: user }, data: { refreshToken: null } })
    }, () => refresh(token))
    expect(res.statusCode).toBe(401)
    expect(await stored()).toBeNull()
  })

  it('X50 review — signing out after the access token expired still ends the session, given the current refresh token', async () => {
    const token = await currentToken()
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: token } })
    expect(logout.statusCode).toBe(204)
    expect(await stored()).toBeNull()
    expect(await prisma.auditEvent.count({ where: { orgId: org, userId: user, action: 'USER_LOGOUT' } })).toBeGreaterThan(0)
    expect((await refresh(token)).statusCode).toBe(401)
  })

  it('X50 review — an old refresh token can\'t end a newer session', async () => {
    const old = signRefreshToken({ sub: user, orgId: org, roles: ['OLD_ROLE'] })
    const current = await currentToken()
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken: old } })).statusCode).toBe(204)
    expect(await stored()).toBe(current)
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
