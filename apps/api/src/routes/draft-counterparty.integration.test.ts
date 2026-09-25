/**
 * Z6 — Counterparties › New contract opened the contract list and nothing
 * else. It now starts a draft for that counterparty, and the contract the
 * draft creates is linked to it, so it shows on the counterparty's page.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueClassifyDocument: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
}))

import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, counterparty: string, elsewhere: string
const draftCalls: string[] = []

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Z6 Draft Org')
  user = await makeUser(org)
  counterparty = (await prisma.counterparty.create({ data: { orgId: org, name: 'Initech Ltd' } })).id
  const other = await makeOrg('Z6 Other Org')
  elsewhere = (await prisma.counterparty.create({ data: { orgId: other, name: 'Someone Else Inc' } })).id

  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/draft')) {
      draftCalls.push(url)
      return new Response(JSON.stringify({ html: '<p>Mutual non-disclosure.</p>', contractType: 'NDA', usedTemplateName: 'NDA' }), { status: 200 })
    }
    return realFetch(input, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.counterparty.deleteMany({ where: { id: { in: [counterparty, elsewhere] } } }).catch(() => {})
  await cleanupAll(); await closeApp()
})

const draft = (saveAs: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/v1/agent/draft', headers: auth(org, ['ADMIN'], user),
  payload: { userMessage: 'Draft a mutual NDA for Initech Ltd', saveAs },
})

describe('a draft started from a counterparty', () => {
  it('creates a contract linked to that counterparty', async () => {
    const res = await draft({ title: 'Z6 Initech NDA', counterpartyId: counterparty })
    expect(res.statusCode, res.body).toBe(200)
    const created = await prisma.contract.findUniqueOrThrow({ where: { id: res.json().contractId } })
    expect(created).toMatchObject({ counterpartyId: counterparty, counterpartyName: 'Initech Ltd', ownerId: user })
  })

  it('refuses another organization\'s counterparty before running the agent', async () => {
    const calls = draftCalls.length
    const res = await draft({ title: 'Z6 foreign', counterpartyId: elsewhere })
    expect(res.statusCode).toBe(404)
    expect(draftCalls.length).toBe(calls)
  })
})
