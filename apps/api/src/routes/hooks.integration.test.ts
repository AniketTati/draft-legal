/**
 * docs/41 Part 20 — REST hooks (Zapier): a key with the `hooks` scope
 * subscribes and unsubscribes on top of the webhooks we already deliver;
 * samples cover every event; another org's subscription is out of reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, grantRole, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { hashApiKey } from '../middleware/auth.js'

let app: TestApp
let orgA: string, orgB: string, adminA: string
let hooksKey: string, readKey: string, otherKey: string

async function makeKey(orgId: string, userId: string, scopes: string[]): Promise<string> {
  const key = `clm_live_${randomBytes(24).toString('base64url')}`
  await prisma.apiKey.create({ data: { orgId, createdById: userId, name: 'Zapier', keyHash: hashApiKey(key), prefix: key.slice(0, 12), scopes } })
  return key
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('Hooks A')
  orgB = await makeOrg('Hooks B')
  adminA = await makeUser(orgA)
  const adminB = await makeUser(orgB)
  await grantRole(orgA, adminA, 'ADMIN')
  await grantRole(orgB, adminB, 'ADMIN')
  hooksKey = await makeKey(orgA, adminA, ['hooks'])
  readKey = await makeKey(orgA, adminA, ['contracts:read'])
  otherKey = await makeKey(orgB, adminB, ['hooks'])
})

afterAll(async () => {
  for (const orgId of [orgA, orgB]) {
    await prisma.webhook.deleteMany({ where: { orgId } })
    await prisma.apiKey.deleteMany({ where: { orgId } })
  }
  await cleanupAll()
  await closeApp()
})

describe('REST hooks', () => {
  let hookId: string

  it('subscribes: a webhook for one event, owned by the key\'s maker, signed like any other', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/hooks', headers: bearer(hooksKey), payload: { target_url: 'https://hooks.zapier.com/hooks/standard/1/abc', event: 'contract.executed' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({ event: 'contract.executed', target_url: 'https://hooks.zapier.com/hooks/standard/1/abc' })
    expect(body.secret).toMatch(/^whsec_/)
    hookId = body.id
    const wh = await prisma.webhook.findFirstOrThrow({ where: { id: hookId } })
    expect(wh).toMatchObject({ orgId: orgA, events: ['contract.executed'], enabled: true, createdById: adminA })
  })

  it('refuses an unknown event and a private address', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/hooks', headers: bearer(hooksKey), payload: { target_url: 'https://hooks.zapier.com/x', event: 'contract.exploded' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/hooks', headers: bearer(hooksKey), payload: { target_url: 'http://169.254.169.254/latest', event: 'contract.created' } })).statusCode).toBe(400)
  })

  it('refuses a key without the hooks scope', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/hooks', headers: bearer(readKey), payload: { target_url: 'https://hooks.zapier.com/x', event: 'contract.created' } })).statusCode).toBe(403)
  })

  it('serves a sample for each event, in the delivery envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/hooks/samples/approval.decided', headers: bearer(hooksKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([expect.objectContaining({ event: 'approval.decided', data: expect.objectContaining({ decision: 'APPROVED' }) })])
    expect((await app.inject({ method: 'GET', url: '/api/v1/hooks/samples/nope', headers: bearer(hooksKey) })).statusCode).toBe(404)
  })

  it('another org can neither list nor unsubscribe it', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/hooks', headers: bearer(otherKey) })
    expect(list.json().data.map((h: { id: string }) => h.id)).not.toContain(hookId)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/hooks/${hookId}`, headers: bearer(otherKey) })).statusCode).toBe(404)
  })

  it('unsubscribes', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/hooks/${hookId}`, headers: bearer(hooksKey) })).statusCode).toBe(204)
    const wh = await prisma.webhook.findFirstOrThrow({ where: { id: hookId } })
    expect(wh.deletedAt).not.toBeNull()
    expect(wh.enabled).toBe(false)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/hooks/${hookId}`, headers: bearer(hooksKey) })).statusCode).toBe(404)
  })
})
