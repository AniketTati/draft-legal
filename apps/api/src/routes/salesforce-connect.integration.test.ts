/**
 * Connecting Salesforce (docs/41 Part 17): a workspace bound to one
 * Salesforce org is never moved to another without disconnecting first. A
 * second Connect is refused with a 409; signing in again (reconnect) to a
 * different org changes nothing; after a disconnect another org may connect,
 * and the old org's open conflicts are dismissed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// The code exchange and revoke go to Salesforce: answer them here.
const exchange = vi.hoisted(() => ({ orgId: '00D000000000001AAA' }))
vi.mock('../lib/salesforce/oauth.js', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    exchangeCode: vi.fn(async () => ({
      access_token: 'access', refresh_token: 'refresh', instance_url: 'https://acme.my.salesforce.com',
      id: `https://login.salesforce.com/id/${exchange.orgId}/005000000000001AAA`,
    })),
    revokeToken: vi.fn(async () => undefined),
  }
})

process.env.SALESFORCE_CLIENT_ID ??= 'test-client'
process.env.SALESFORCE_CLIENT_SECRET ??= 'test-secret'
if (Buffer.from(process.env.AI_KEY_ENCRYPTION_KEY ?? '', 'base64').length !== 32) process.env.AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { encrypt } from '../lib/encryption.js'

let app: TestApp
let orgA: string, adminA: string
const SF_A = '00D000000000001AAA'
const SF_B = '00D000000000002AAA'
const base = '/api/v1/admin/integrations/salesforce'

/** Start a sign-in and come back from Salesforce signed in to `sfOrg`. */
async function signIn(sfOrg: string, payload: Record<string, unknown> = {}) {
  const start = await app.inject({ method: 'POST', url: `${base}/connect`, headers: auth(orgA, ['ADMIN'], adminA), payload })
  if (start.statusCode !== 200) return { start, back: null as URLSearchParams | null }
  const state = new URL(start.json().url).searchParams.get('state')!
  exchange.orgId = sfOrg
  const cb = await app.inject({ method: 'GET', url: `/api/v1/integrations/salesforce/oauth/callback?code=c&state=${encodeURIComponent(state)}` })
  expect(cb.statusCode).toBe(302)
  return { start, back: new URL(cb.headers.location as string).searchParams }
}

const connection = () => prisma.integrationConnection.findFirst({ where: { orgId: orgA, provider: 'salesforce' } })

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('SF Connect A')
  adminA = await makeUser(orgA)
  await grantRole(orgA, adminA, 'ADMIN')
  await prisma.integrationConnection.create({
    data: {
      orgId: orgA, provider: 'salesforce', status: 'connected', externalOrgId: SF_A.slice(0, 15),
      instanceUrl: 'https://acme.my.salesforce.com', loginUrl: 'https://login.salesforce.com',
      encryptedAccessToken: encrypt('access'), encryptedRefreshToken: encrypt('refresh'),
      connectedById: adminA, connectedAt: new Date(), config: { selfServeTypes: ['NDA'] },
    },
  })
})

afterAll(async () => {
  await prisma.integrationConflict.deleteMany({ where: { orgId: orgA } })
  await prisma.integrationConnection.deleteMany({ where: { orgId: orgA } })
  await cleanupAll()
  await closeApp()
})

describe('one Salesforce org per workspace, disconnect first', () => {
  it('refuses a second Connect while connected, saying to disconnect first', async () => {
    const { start } = await signIn(SF_B)
    expect(start.statusCode).toBe(409)
    expect(start.json().detail).toMatch(/disconnect this one first/i)
    expect((await connection())!.externalOrgId).toBe(SF_A.slice(0, 15))
  })

  it('signing in again to a different org changes nothing; to the same org it reconnects', async () => {
    const other = await signIn(SF_B, { reconnect: true })
    expect(other.back!.get('error')).toMatch(/different Salesforce org.*disconnect Salesforce first/i)
    expect((await connection())!.externalOrgId).toBe(SF_A.slice(0, 15))

    const same = await signIn(SF_A, { reconnect: true })
    expect(same.back!.get('connected')).toBe('1')
    expect((await connection())!).toMatchObject({ status: 'connected', externalOrgId: SF_A.slice(0, 15) })
  })

  it('after a disconnect another org connects, and the old org\'s open conflicts are dismissed', async () => {
    const contractId = await makeContract(orgA, adminA, { title: 'Old org conflict' })
    const conflict = await prisma.integrationConflict.create({
      data: { orgId: orgA, provider: 'salesforce', contractId, externalObject: 'Opportunity', externalField: 'Amount', dlField: 'value', currentValue: 1, incomingValue: 2 },
    })
    expect((await app.inject({ method: 'DELETE', url: base, headers: auth(orgA, ['ADMIN'], adminA) })).statusCode).toBe(204)

    const next = await signIn(SF_B)
    expect(next.start.statusCode).toBe(200)
    expect(next.back!.get('connected')).toBe('1')
    expect((await connection())!).toMatchObject({ status: 'connected', externalOrgId: SF_B.slice(0, 15) })
    expect((await prisma.integrationConflict.findUnique({ where: { id: conflict.id } }))!.status).toBe('dismissed')
  })
})
