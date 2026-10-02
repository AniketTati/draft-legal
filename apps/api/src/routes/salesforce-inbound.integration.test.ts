/**
 * docs/41 Part 17 (S2) — Salesforce → draftLegal, against a real database.
 *
 *   - Only Salesforce's own key (the `salesforce` scope) from the connected
 *     Salesforce org may call: a mismatched or missing org id, a key without
 *     the scope, or a signed-in user is refused.
 *   - A launch becomes a request pre-filled through the field map, its
 *     counterparty linked by the Account id; each org gets its own.
 *   - A later Salesforce change is written before signing and held as a
 *     conflict after, which the contract's owner then decides.
 *   - The embed token opens one contract's preview, and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

// Hermetic: no parse, draft or classification jobs leave the test.
vi.mock('../lib/queue.js', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' && k.startsWith('queue') ? vi.fn(async () => ({ id: 'job' })) : v]))
})
vi.mock('../lib/elasticsearch.js', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => ({})) : v]))
})

// Token encryption needs a 32-byte key; a local .env may hold none (or a bad one).
if (Buffer.from(process.env.AI_KEY_ENCRYPTION_KEY ?? '', 'base64').length !== 32) process.env.AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { hashApiKey } from '../middleware/auth.js'
import { encrypt } from '../lib/encryption.js'
import { integrationSyncQueue } from '../lib/integrations/sync-queue.js'

let app: TestApp
let orgA: string, orgB: string, adminA: string, adminB: string
let keyA: string, keyB: string, readOnlyKeyA: string
const SF_A = '00D000000000001AAA'
const SF_B = '00D000000000002AAA'

async function makeKey(orgId: string, userId: string, scopes: string[]): Promise<string> {
  const key = `clm_live_${randomBytes(24).toString('base64url')}`
  await prisma.apiKey.create({ data: { orgId, createdById: userId, name: 'Salesforce', keyHash: hashApiKey(key), prefix: key.slice(0, 12), scopes } })
  return key
}

async function connect(orgId: string, sfOrgId: string, userId: string) {
  await prisma.integrationConnection.create({
    data: {
      orgId, provider: 'salesforce', status: 'connected', externalOrgId: sfOrgId.slice(0, 15),
      instanceUrl: 'https://acme.my.salesforce.com', loginUrl: 'https://login.salesforce.com',
      encryptedAccessToken: encrypt('access'), encryptedRefreshToken: encrypt('refresh'),
      connectedById: userId, connectedAt: new Date(), config: { selfServeTypes: ['NDA'] },
    },
  })
}

const sf = (key: string, sfOrg: string | null = SF_A) => ({
  authorization: `Bearer ${key}`,
  ...(sfOrg ? { 'x-salesforce-org-id': sfOrg } : {}),
})

const launch = (over: Record<string, unknown> = {}) => ({
  contractType: 'MSA',
  records: {
    Opportunity: { Id: '006000000000001AAA', Name: 'Acme expansion', Amount: 40000, CloseDate: '2026-12-01' },
    Account: { Id: '001000000000001AAA', Name: 'Acme Corp' },
  },
  requestedBy: { email: 'rep@acme-sales.example' },
  ...over,
})

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('SF Inbound A')
  orgB = await makeOrg('SF Inbound B')
  adminA = await makeUser(orgA)
  adminB = await makeUser(orgB)
  await grantRole(orgA, adminA, 'ADMIN')
  await grantRole(orgB, adminB, 'ADMIN')
  keyA = await makeKey(orgA, adminA, ['salesforce'])
  keyB = await makeKey(orgB, adminB, ['salesforce'])
  readOnlyKeyA = await makeKey(orgA, adminA, ['contracts:read', 'requests:write'])
  await connect(orgA, SF_A, adminA)
  await connect(orgB, SF_B, adminB)
  for (const orgId of [orgA, orgB]) {
    await prisma.integrationFieldMapping.createMany({
      data: [
        { orgId, provider: 'salesforce', externalObject: 'Opportunity', externalField: 'Amount', dlField: 'value', direction: 'both', locked: true },
        { orgId, provider: 'salesforce', externalObject: 'Opportunity', externalField: 'CloseDate', dlField: 'effectiveDate', direction: 'inbound' },
        { orgId, provider: 'salesforce', contractType: 'NDA', externalObject: 'Opportunity', externalField: 'Name', dlField: 'var:purpose', direction: 'inbound' },
      ],
    })
  }
})

afterAll(async () => {
  await integrationSyncQueue.obliterate({ force: true }).catch(() => undefined)
  for (const orgId of [orgA, orgB]) {
    await prisma.integrationConflict.deleteMany({ where: { orgId } })
    await prisma.integrationSyncLog.deleteMany({ where: { orgId } })
    await prisma.integrationFieldMapping.deleteMany({ where: { orgId } })
    await prisma.integrationConnection.deleteMany({ where: { orgId } })
    await prisma.contractRequest.deleteMany({ where: { orgId } })
    await prisma.apiKey.deleteMany({ where: { orgId } })
  }
  await cleanupAll()
  await closeApp()
})

describe('who may call', () => {
  it('refuses a call without the Salesforce org id, or from another Salesforce org', async () => {
    for (const headers of [sf(keyA, null), sf(keyA, SF_B), sf(keyA, '00D999999999999')]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers, payload: launch() })
      expect(res.statusCode).toBe(403)
    }
  })

  it('refuses a key without the salesforce scope, and a signed-in user', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(readOnlyKeyA), payload: launch() })
    expect(res.statusCode).toBe(403)
    const user = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: { ...auth(orgA, ['ADMIN'], adminA), 'x-salesforce-org-id': SF_A }, payload: launch() })
    expect(user.statusCode).toBe(403)
  })

  it('refuses another org\'s key even with this org\'s Salesforce id (tenant isolation)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyB, SF_A), payload: launch() })
    expect(res.statusCode).toBe(403)
  })

  it('a salesforce key cannot reach the rest of the API beyond its scope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/salesforce', headers: sf(keyA) })
    expect(res.statusCode).toBe(403)
  })
})

describe('a launch from an Opportunity', () => {
  let firstCounterparty: string

  it('creates a pre-filled request, linked to the Account', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyA), payload: launch() })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.deepLink).toContain(`/requests?request=${body.requestId}`)
    expect(body.prefilled.sort()).toEqual(['effectiveDate', 'value'])
    const req = await prisma.contractRequest.findFirstOrThrow({ where: { id: body.requestId, orgId: orgA } })
    expect(req.source).toBe('salesforce')
    expect(Number(req.estimatedValue)).toBe(40000)
    expect(req.counterpartyName).toBe('Acme Corp')
    const meta = req.metadata as Record<string, any>
    expect(meta.prefill).toMatchObject({ value: 40000, effectiveDate: '2026-12-01' })
    expect(meta.locked).toEqual(['value'])
    expect(meta.salesforce).toMatchObject({ opportunityId: '006000000000001AAA', accountId: '001000000000001AAA' })
    // Not a member: recorded as who asked, the request is the key maker's.
    expect(meta.salesforce.requestedBy).toEqual({ email: 'rep@acme-sales.example' })
    expect(req.requestedById).toBe(adminA)
    const cp = await prisma.counterparty.findFirstOrThrow({ where: { id: body.counterpartyId, orgId: orgA } })
    expect(cp.crmId).toBe('001000000000001AAA')
    firstCounterparty = cp.id
    const log = await prisma.integrationSyncLog.findFirst({ where: { orgId: orgA, requestId: body.requestId } })
    expect(log).toMatchObject({ direction: 'inbound', status: 'success' })
  })

  it('links the same counterparty by Account id even when the name changed in Salesforce', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyA),
      payload: launch({ records: { Account: { Id: '001000000000001', Name: 'Acme Corporation' } } }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().counterpartyId).toBe(firstCounterparty)
  })

  it('gives each org its own counterparty for the same Account', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyB, SF_B), payload: launch() })
    expect(res.statusCode).toBe(201)
    expect(res.json().counterpartyId).not.toBe(firstCounterparty)
    const cp = await prisma.counterparty.findFirst({ where: { id: res.json().counterpartyId } })
    expect(cp?.orgId).toBe(orgB)
  })

  it('makes a member rep the requester', async () => {
    const rep = await prisma.user.create({ data: { orgId: orgA, email: `rep-${randomBytes(4).toString('hex')}@test.local`, passwordHash: 'x', name: 'Rep' } })
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyA), payload: launch({ requestedBy: { email: rep.email.toUpperCase() } }) })
    const req = await prisma.contractRequest.findFirstOrThrow({ where: { id: res.json().requestId } })
    expect(req.requestedById).toBe(rep.id)
  })

  it('generates a self-serve type at once through the request conversion, and refuses others', async () => {
    const nda = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyA), payload: launch({ contractType: 'NDA', generateNow: true }) })
    expect(nda.statusCode).toBe(201)
    expect(nda.json().contractId).toBeTruthy()
    const c = await prisma.contract.findFirstOrThrow({ where: { id: nda.json().contractId, orgId: orgA } })
    expect((c.metadata as Record<string, any>).salesforce.opportunityId).toBe('006000000000001AAA')
    const req = await prisma.contractRequest.findFirstOrThrow({ where: { id: nda.json().requestId } })
    expect(req.status).toBe('ACCEPTED')
    expect((req.metadata as Record<string, any>).variables).toEqual({ purpose: 'Acme expansion' })

    const msa = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/requests', headers: sf(keyA), payload: launch({ generateNow: true }) })
    expect(msa.statusCode).toBe(201)
    expect(msa.json().contractId).toBeUndefined()
    expect(msa.json().generateRefused).toMatch(/goes to Legal/)
  })

  it('serves the launch form from the field map', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations/salesforce/launch-form?contractType=NDA', headers: sf(keyA) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.selfServe).toBe(true)
    expect(body.fields.map((f: { dlField: string }) => f.dlField).sort()).toEqual(['effectiveDate', 'value', 'var:purpose'])
    expect(body.fields.find((f: { dlField: string }) => f.dlField === 'value').locked).toBe(true)
    // The change Flow asks for every mapped field, once each.
    const all = await app.inject({ method: 'GET', url: '/api/v1/integrations/salesforce/launch-form?all=1', headers: sf(keyA) })
    expect(all.json().fields.map((f: { externalField: string }) => f.externalField).sort()).toEqual(['Amount', 'CloseDate', 'Name'])
  })

  it('refuses a mapping to something that is not a draftLegal field', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/integrations/salesforce/mappings', headers: auth(orgA, ['ADMIN'], adminA),
      payload: { mappings: [{ externalObject: 'Opportunity', externalField: 'Amount', dlField: 'ownerId', direction: 'inbound' }] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('a later Salesforce change', () => {
  let draft: string, signing: string

  beforeAll(async () => {
    draft = await makeContract(orgA, adminA, { title: 'Acme MSA (draft)', type: 'MSA', status: 'DRAFT' })
    signing = await makeContract(orgA, adminA, { title: 'Acme MSA (signing)', type: 'MSA', status: 'PENDING_SIGNATURE' })
    for (const id of [draft, signing]) {
      await prisma.contract.update({ where: { id }, data: { value: 40000, metadata: { salesforce: { opportunityId: '006000000000009AAA' } } } })
    }
    // The other org's contract on the same Opportunity id is never touched.
    const other = await makeContract(orgB, adminB, { title: 'B contract', type: 'MSA', status: 'DRAFT' })
    await prisma.contract.update({ where: { id: other }, data: { value: 1, metadata: { salesforce: { opportunityId: '006000000000009AAA' } } } })
  })

  it('is written before signing and held as a conflict after', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/integrations/salesforce/changes', headers: sf(keyA),
      payload: { object: 'Opportunity', record: { Id: '006000000000009AAA', Amount: 45000 } },
    })
    expect(res.statusCode).toBe(200)
    const byId = Object.fromEntries(res.json().contracts.map((c: { contractId: string }) => [c.contractId, c]))
    expect(Object.keys(byId).sort()).toEqual([draft, signing].sort())
    expect(byId[draft].written).toEqual(['value'])
    expect(byId[signing].conflicts).toEqual(['value'])

    expect(Number((await prisma.contract.findFirstOrThrow({ where: { id: draft } })).value)).toBe(45000)
    expect(Number((await prisma.contract.findFirstOrThrow({ where: { id: signing } })).value)).toBe(40000)
    const k = await prisma.integrationConflict.findFirstOrThrow({ where: { orgId: orgA, contractId: signing, status: 'open' } })
    expect(k).toMatchObject({ dlField: 'value', currentValue: 40000, incomingValue: 45000 })
    const otherOrg = await prisma.contract.findFirstOrThrow({ where: { orgId: orgB, title: 'B contract' } })
    expect(Number(otherOrg.value)).toBe(1)
  })

  it('a newer change replaces the pending one rather than piling up', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/changes', headers: sf(keyA), payload: { object: 'Opportunity', record: { Id: '006000000000009AAA', Amount: 47000 } } })
    const open = await prisma.integrationConflict.findMany({ where: { orgId: orgA, contractId: signing, status: 'open' } })
    expect(open).toHaveLength(1)
    expect(open[0].incomingValue).toBe(47000)
  })

  it('the owner applies it; another org cannot see or decide it', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/contracts/${signing}/integration-conflicts`, headers: auth(orgA, ['ADMIN'], adminA) })
    expect(list.json().data).toHaveLength(1)
    const conflictId = list.json().data[0].id
    expect(list.json().data[0].label).toBe('Contract value')

    const cross = await app.inject({ method: 'POST', url: `/api/v1/contracts/${signing}/integration-conflicts/${conflictId}/resolve`, headers: auth(orgB, ['ADMIN'], adminB), payload: { action: 'apply' } })
    expect(cross.statusCode).toBe(404)

    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${signing}/integration-conflicts/${conflictId}/resolve`, headers: auth(orgA, ['ADMIN'], adminA), payload: { action: 'apply' } })
    expect(res.statusCode).toBe(200)
    expect(Number((await prisma.contract.findFirstOrThrow({ where: { id: signing } })).value)).toBe(47000)
    const again = await app.inject({ method: 'POST', url: `/api/v1/contracts/${signing}/integration-conflicts/${conflictId}/resolve`, headers: auth(orgA, ['ADMIN'], adminA), payload: { action: 'dismiss' } })
    expect(again.statusCode).toBe(400)
  })
})

describe('the embedded document preview', () => {
  let contract: string

  beforeAll(async () => {
    contract = await makeContract(orgA, adminA, { title: 'Embed me' })
    const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: adminA, htmlContent: '<p>Hello</p>' } })
    await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
  })

  it('a token opens that contract, read-only, and nothing else', async () => {
    const mint = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/embed-token', headers: sf(keyA), payload: { contractId: contract } })
    expect(mint.statusCode).toBe(200)
    const url = new URL(mint.json().url)
    expect(url.pathname).toBe(`/embed/contracts/${contract}`)
    const token = url.searchParams.get('token')!

    const ok = await app.inject({ method: 'GET', url: `/api/v1/embed/contracts/${contract}?token=${encodeURIComponent(token)}` })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.json()).toMatchObject({ contract: { id: contract, title: 'Embed me' }, version: { html: '<p>Hello</p>' } })

    const other = await makeContract(orgA, adminA, { title: 'Not this one' })
    expect((await app.inject({ method: 'GET', url: `/api/v1/embed/contracts/${other}?token=${encodeURIComponent(token)}` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/v1/embed/contracts/${contract}` })).statusCode).toBe(401)
  })

  it('another org cannot mint a token for this contract', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/integrations/salesforce/embed-token', headers: sf(keyB, SF_B), payload: { contractId: contract } })
    expect(res.statusCode).toBe(404)
  })
})
