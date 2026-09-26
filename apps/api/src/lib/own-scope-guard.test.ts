/**
 * X7 — the own-scope guard must stop the route, not just send a 404 and let
 * the handler run on. Fastify only waits on an early response from an async
 * preHandler if the reply is returned; without it, a later async hook (an
 * awaiting onSend) lets the handler — e.g. a DELETE — run after the 404 went out.
 */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { ownScopeGuard, guardOwnScopeRoutes } from './own-scope-guard.js'

async function appWith(scope: string) {
  const app = Fastify()
  const ran: string[] = []
  app.addHook('onSend', async (_req, _reply, payload) => {
    await new Promise(r => setTimeout(r, 5))
    return payload
  })
  await app.register(async plugin => {
    guardOwnScopeRoutes(plugin, /\/:id(\/|$)/, ownScopeGuard(async (_req, id) => id === 'mine', 'Thing not found'))
    const setScope = async (req: { permissionScope?: string | null }) => { req.permissionScope = scope }
    plugin.delete('/things/:id', { preHandler: setScope }, async req => {
      ran.push((req.params as { id: string }).id)
      return { deleted: true }
    })
    plugin.get('/things', { preHandler: [setScope] }, async () => ({ list: true }))
  })
  // A sibling plugin's `:id` route is not guarded.
  await app.register(async plugin => {
    plugin.get('/others/:id', async () => ({ other: true }))
  })
  await app.ready()
  return { app, ran }
}

describe('ownScopeGuard', () => {
  it('404s an own-scope caller on a record it does not own, and the handler never runs', async () => {
    const { app, ran } = await appWith('own')
    const res = await app.inject({ method: 'DELETE', url: '/things/theirs' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ detail: 'Thing not found' })
    await new Promise(r => setTimeout(r, 20))
    expect(ran).toEqual([])
    await app.close()
  })

  it('lets the owner through, and leaves org scope and unmatched routes alone', async () => {
    const own = await appWith('own')
    expect((await own.app.inject({ method: 'DELETE', url: '/things/mine' })).statusCode).toBe(200)
    expect((await own.app.inject({ method: 'GET', url: '/things' })).statusCode).toBe(200)
    expect((await own.app.inject({ method: 'GET', url: '/others/theirs' })).statusCode).toBe(200)
    expect(own.ran).toEqual(['mine'])
    await own.app.close()

    const org = await appWith('org')
    expect((await org.app.inject({ method: 'DELETE', url: '/things/theirs' })).statusCode).toBe(200)
    await org.app.close()
  })
})
