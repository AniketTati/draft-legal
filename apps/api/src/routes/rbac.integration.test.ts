/**
 * RBAC per role — a permission-scoped role can read but not write; ADMIN can.
 * Permissions resolve from DEFAULT_ROLE_PERMISSIONS: FINANCE = view contract
 * only; ADMIN = everything at org scope.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('RBAC Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'RBAC Contract' })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('RBAC per role (contracts)', () => {
  it('a view-only role (FINANCE) can read a contract', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['FINANCE']),
    })
    expect(res.statusCode).toBe(200)
  })

  it('a view-only role (FINANCE) CANNOT edit a contract (403)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`,
      headers: auth(org, ['FINANCE']), payload: { title: 'Hacked by finance' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('ADMIN can edit a contract, and the change persists', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`,
      headers: auth(org, ['ADMIN']), payload: { title: 'Edited by admin' },
    })
    expect(res.statusCode).toBe(200)

    const check = await app.inject({
      method: 'GET', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN']),
    })
    expect(check.json().title).toBe('Edited by admin')
  })

  it('a role with no permissions at all is denied write', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`,
      headers: auth(org, ['NONEXISTENT_ROLE']), payload: { title: 'nope' },
    })
    expect(res.statusCode).toBe(403)
  })
})

/**
 * W0-1 — the agent's apply path must not be a way around the checks above.
 *
 * It proxies to /internal/ai/tools/*, which authenticates the *service* and
 * runs as ADMIN, so agent-threads.ts is the only place the caller's own role
 * can be enforced. Before the fix, FINANCE — 403'd by PATCH /contracts/:id one
 * describe block up — could perform the same write here.
 */
describe('RBAC on the agent apply path', () => {
  // Threads carry a real userId FK, so every call here authenticates as the
  // seeded owner and varies only the roles — which is exactly the variable
  // under test.
  async function openThread(roles: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/threads',
      headers: auth(org, roles, owner), payload: { title: 'rbac probe' },
    })
    expect(res.statusCode).toBeLessThan(300)
    return res.json().id
  }

  it('a view-only role (FINANCE) CANNOT write via agent apply (403)', async () => {
    const thread = await openThread(['FINANCE'])
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`,
      headers: auth(org, ['FINANCE'], owner),
      payload: {
        toolName: 'contract_update',
        args: { contractId: contract, action: 'set_status', payload: { status: 'PENDING_REVIEW' } },
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().detail).toContain('edit:contract')
  })

  it('the tool→permission map is enforced per tool, not globally', async () => {
    // FINANCE lacks create:request as well — a different tool, a different
    // permission, the same refusal. This catches a fix that hardcodes one
    // permission for every write tool.
    const thread = await openThread(['FINANCE'])
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`,
      headers: auth(org, ['FINANCE'], owner),
      payload: { toolName: 'request_create', args: { title: 'nope', type: 'NDA' } },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().detail).toContain('create:request')
  })

  it('an unregistered tool is still rejected as a bad request, not a 403', async () => {
    const thread = await openThread(['ADMIN'])
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`,
      headers: auth(org, ['ADMIN'], owner),
      payload: { toolName: 'not_a_tool', args: {} },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a permissioned role still passes the permission gate', async () => {
    // Asserts only that we get past authorization — the downstream call needs
    // the agents stack, so a non-403 is the signal. A fix that denied everyone
    // would fail here.
    const thread = await openThread(['ADMIN'])
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`,
      headers: auth(org, ['ADMIN'], owner),
      payload: {
        toolName: 'contract_update',
        args: { contractId: contract, action: 'set_status', payload: { status: 'PENDING_REVIEW' } },
      },
    })
    expect(res.statusCode).not.toBe(403)
  })
})
