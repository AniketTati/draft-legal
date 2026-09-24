/**
 * Y3 — the web app judges an API call by the permission the server's route
 * for it needs (route-permissions.gen.ts), not by its own idea of it.
 */
import { describe, it, expect } from 'vitest'
import { routeFor, heldPermissions, missingPermission, canRequest, refusalMessage } from './can-request'

const SHARE = { action: 'configure', resource: 'contract' }
const viewer = [{ action: 'view', resource: 'contract', scope: 'org' }, { action: 'view', resource: 'workflow', scope: 'org' }]

describe('the route a call reaches', () => {
  it('is found however the client writes the call', () => {
    for (const url of ['/contracts/c1/share', '/api/v1/contracts/c1/share', '/contracts/c1/share?notify=1', '/contracts/:id/share']) {
      expect(routeFor('POST', url)?.permission, url).toEqual(SHARE)
    }
    expect(routeFor('post', '/contracts/c1/share')?.permission).toEqual(SHARE)
  })

  it('is the static route over a parameter, as the server\'s router picks it', () => {
    expect(routeFor('GET', '/approvals/all')?.permission).toEqual({ action: 'configure', resource: 'workflow' })
    expect(routeFor('GET', '/approvals/inst-1')?.permission).toEqual({ action: 'view', resource: 'workflow' })
    expect(routeFor('GET', '/admin/users/roles')?.permission).toBeNull()
    expect(routeFor('GET', '/admin/users/u1')?.permission).toEqual({ action: 'configure', resource: 'user' })
  })

  it('is none for a path the server doesn\'t serve', () => {
    expect(routeFor('POST', '/contracts/c1/shares')).toBeUndefined()
    expect(routeFor('DELETE', '/contracts/c1/share/extra/segments')).toBeUndefined()
  })
})

describe('what a user may request', () => {
  it('holds what their roles grant; ADMIN everything; nothing known before the catalogue arrives', () => {
    const roles = [{ name: 'VIEWER', permissions: viewer }, { name: 'FINANCE', permissions: [{ action: 'edit', resource: 'invoice' }] }]
    expect(heldPermissions(['VIEWER'], roles)).toEqual(viewer)
    expect(heldPermissions(['ADMIN'], undefined)).toBe('all')
    expect(heldPermissions(['VIEWER'], undefined)).toBeNull()
  })

  it('names the permission a write needs and the user lacks', () => {
    expect(missingPermission(viewer, 'POST', '/contracts/c1/share')).toEqual(SHARE)
    expect(missingPermission(viewer, 'POST', '/contracts/c1/amendments')).toEqual({ action: 'create', resource: 'contract' })
    expect(refusalMessage(SHARE)).toBe('You don\'t have permission to configure contracts.')
  })

  it('lets through what the user holds, by wildcard too, and what needs no permission or isn\'t known', () => {
    expect(canRequest(viewer, 'GET', '/contracts/c1')).toBe(true)
    expect(canRequest([{ action: '*', resource: 'contract' }], 'POST', '/contracts/c1/share')).toBe(true)
    expect(canRequest([{ action: 'configure', resource: '*' }], 'POST', '/contracts/c1/share')).toBe(true)
    expect(canRequest('all', 'POST', '/contracts/c1/share')).toBe(true)
    expect(canRequest([], 'POST', '/auth/logout')).toBe(true)
    expect(canRequest([], 'POST', '/not/a/route')).toBe(true)
  })
})
