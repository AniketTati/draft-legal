/**
 * Y3 — the web app decides which actions to offer, and which writes to send,
 * from its copy of the permission each API route needs. The copy is
 * generated from the routes the app registers; a route added, removed or
 * given another permission without regenerating it fails here.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { getApp, closeApp } from '../test-support/helpers.js'
import { routePermissionsSource, WEB_ROUTE_TABLE } from '../lib/route-permissions.js'

afterAll(async () => { await closeApp() })

describe('the web app\'s route permission table', () => {
  it('is the one the API registers (else: pnpm --filter api gen:route-permissions)', async () => {
    const app = await getApp()
    expect(readFileSync(WEB_ROUTE_TABLE, 'utf8')).toBe(routePermissionsSource(app.registeredRoutes))
  })

  it('names what requirePermission checks, and null where a route has no such check', async () => {
    const app = await getApp()
    const byRoute = new Map(app.registeredRoutes.map(r => [`${r.method} ${r.url}`, r.permission]))
    expect(byRoute.get('POST /api/v1/contracts/:id/share')).toEqual({ action: 'configure', resource: 'contract' })
    expect(byRoute.get('POST /api/v1/contracts/:id/amendments')).toEqual({ action: 'create', resource: 'contract' })
    expect(byRoute.get('POST /api/v1/auth/login')).toBeNull()
  })
})
