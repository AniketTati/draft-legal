/**
 * X8 — the agents service keys each chat's history by (org, user, session),
 * so the owner it is told about must be the verified caller. This checks the
 * API half: POST /agent/chat forwards user_id / org_id from the JWT, and a
 * client body naming someone else changes nothing. (The Python half is the
 * tripwire in lib/agents-session-binding.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string
const forwarded: Array<Record<string, unknown>> = []

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Agent Chat Identity Org')
  user = await makeUser(org)
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/agent/chat')) {
      forwarded.push(JSON.parse(String(init?.body)))
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await cleanupAll()
  await closeApp()
})

describe('POST /agent/chat forwards the verified caller as the history owner', () => {
  it('user_id and org_id come from the token, not the body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agent/chat', headers: auth(org, ['LEGAL_OPS'], user),
      payload: {
        message: 'hello', sessionId: 'someone-elses-thread', agentMode: true,
        userId: 'victim-user', orgId: 'victim-org', user_id: 'victim-user', org_id: 'victim-org',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({ user_id: user, org_id: org, session_id: 'someone-elses-thread' })
  })
})
