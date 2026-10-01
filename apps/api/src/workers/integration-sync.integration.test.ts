/**
 * docs/41 Part 17 (S1) — the sync worker against a real database and a
 * mocked Salesforce (fetch). No network: every call goes to the mock.
 *
 *   - a failed attempt is logged and retried; the retry refreshes an expired
 *     token, upserts by our external id and is logged as a success;
 *   - a payload Salesforce already has is skipped;
 *   - a refused record ends the job (no pointless retries); the API limit
 *     waits as long as Salesforce asks;
 *   - an executed contract's signed PDF is filed once, on the record and the
 *     Opportunity;
 *   - Integration health shows the failure, and its retry re-queues the sync;
 *   - a contract event queues a sync only for an org with Salesforce connected.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { UnrecoverableError } from 'bullmq'

// Importing the worker module starts a BullMQ worker; the test calls the
// handler directly (with a mocked Salesforce) instead.
vi.mock('bullmq', async importOriginal => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: class { on() { return this } },
}))
vi.mock('../lib/storage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/storage.js')>()),
  s3: { send: vi.fn(async () => ({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('%PDF-1.7 signed')) } })) },
}))

if (Buffer.from(process.env.AI_KEY_ENCRYPTION_KEY ?? '', 'base64').length !== 32) process.env.AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64')
process.env.SALESFORCE_CLIENT_ID = 'test-client-id'
process.env.SALESFORCE_CLIENT_SECRET = 'test-client-secret'

import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { encrypt, decrypt } from '../lib/encryption.js'
import { handleIntegrationSync } from './integration-sync.worker.js'
import { integrationSyncQueue, noteIntegrationEvent, syncBackoff } from '../lib/integrations/sync-queue.js'
import { SalesforceRateLimitError } from '../lib/salesforce/client.js'

let app: TestApp
let org: string, admin: string, contract: string, unconnectedOrg: string

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

type Call = { url: string; method: string; body: any; auth: string | undefined }
let calls: Call[] = []
/** A Salesforce that answers each call with the next handler's response. */
function salesforce(handlers: Array<(c: Call) => Response>) {
  let i = 0
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const raw = typeof init?.body === 'string' ? init.body : ''
    let body: any = raw
    try { body = raw && headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) } catch { /* as is */ }
    const call = { url: String(input), method: init?.method ?? 'GET', body, auth: headers.authorization }
    calls.push(call)
    const h = handlers[Math.min(i++, handlers.length - 1)]
    return h(call)
  })
}
const upsertOk = (c: Call) => json(200, c.body.records.map((_: unknown, i: number) => ({ id: `a0X00000000000${i}AAA`, success: true, created: true })))

async function setStatus(status: string) {
  await prisma.contract.update({ where: { id: contract }, data: { status } })
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('SF Sync Org')
  unconnectedOrg = await makeOrg('SF Sync No Connection')
  admin = await makeUser(org)
  await grantRole(org, admin, 'ADMIN')
  contract = await makeContract(org, admin, { title: 'Acme Order Form', type: 'ORDER_FORM', status: 'UNDER_NEGOTIATION' })
  await prisma.contract.update({ where: { id: contract }, data: { value: 45000, metadata: { salesforce: { opportunityId: '006000000000001AAA' } } } })
  await prisma.integrationConnection.create({
    data: {
      orgId: org, provider: 'salesforce', status: 'connected', externalOrgId: '00D000000000001',
      instanceUrl: 'https://acme.my.salesforce.com', loginUrl: 'https://login.salesforce.com',
      encryptedAccessToken: encrypt('expired-access'), encryptedRefreshToken: encrypt('refresh-1'),
      connectedById: admin, connectedAt: new Date(),
    },
  })
  await prisma.integrationFieldMapping.create({
    data: { orgId: org, provider: 'salesforce', externalObject: 'Opportunity', externalField: 'Amount', dlField: 'value', direction: 'outbound' },
  })
})

beforeEach(() => { calls = [] })

afterAll(async () => {
  await integrationSyncQueue.obliterate({ force: true }).catch(() => undefined)
  for (const orgId of [org, unconnectedOrg]) {
    await prisma.integrationSyncLog.deleteMany({ where: { orgId } })
    await prisma.integrationFieldMapping.deleteMany({ where: { orgId } })
    await prisma.integrationConnection.deleteMany({ where: { orgId } })
  }
  await prisma.signatureRequest.deleteMany({ where: { contractId: contract } }).catch(() => undefined)
  await cleanupAll()
  await closeApp()
})

const job = (attemptsMade: number, contractId = contract) => ({ name: 'contract', attemptsMade, data: { provider: 'salesforce', orgId: org, contractId, event: 'contract.updated' } })

describe('syncing a contract to Salesforce', () => {
  it('logs a failed attempt and lets it retry, then refreshes the token and succeeds', async () => {
    const down = salesforce([() => json(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Down for maintenance' }])])
    await expect(handleIntegrationSync(job(0), down as never)).rejects.not.toBeInstanceOf(UnrecoverableError)
    const failed = await prisma.integrationSyncLog.findFirstOrThrow({ where: { orgId: org, contractId: contract }, orderBy: { at: 'desc' } })
    expect(failed).toMatchObject({ status: 'failed', attempt: 1, direction: 'outbound', object: 'DL_Contract__c' })
    expect(failed.error).toContain('Down for maintenance')

    calls = []
    const sf = salesforce([
      () => json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]),
      () => json(200, { access_token: 'fresh-access', instance_url: 'https://acme.my.salesforce.com', id: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA' }),
      upsertOk,
    ])
    const outcome = await handleIntegrationSync(job(1), sf as never)
    expect(outcome).toMatchObject({ synced: 1, failed: 0 })
    // The refresh went to Salesforce's token endpoint with the stored refresh token.
    expect(calls[1].url).toBe('https://login.salesforce.com/services/oauth2/token')
    expect(calls[1].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'test-client-id' })
    // The upsert is by our external id, with the new token.
    expect(calls[2].url).toContain('/composite/sobjects/DL_Contract__c/DL_Contract_Id__c')
    expect(calls[2].auth).toBe('Bearer fresh-access')
    expect(calls[2].body.records[0]).toMatchObject({ DL_Contract_Id__c: contract, DL_Stage__c: 'Negotiate', DL_Value__c: 45000, DL_Opportunity__c: '006000000000001AAA' })

    const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { orgId: org, provider: 'salesforce' } })
    expect(decrypt(conn.encryptedAccessToken!)).toBe('fresh-access')
    expect(conn.lastSyncAt).not.toBeNull()
    const ok = await prisma.integrationSyncLog.findFirstOrThrow({ where: { orgId: org, contractId: contract, status: 'success' } })
    expect(ok).toMatchObject({ attempt: 2, externalId: 'a0X000000000000AAA' })
    expect(ok.payloadHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('skips a payload the record already shows', async () => {
    const sf = salesforce([upsertOk])
    const outcome = await handleIntegrationSync(job(0), sf as never)
    expect(outcome).toMatchObject({ synced: 0, skipped: 1 })
    expect(sf).not.toHaveBeenCalled()
  })

  it('ends the job when Salesforce refuses the request itself', async () => {
    await setStatus('PENDING_REVIEW')
    const sf = salesforce([() => json(400, [{ errorCode: 'INVALID_FIELD', message: 'No such column DL_Stage__c' }])])
    await expect(handleIntegrationSync(job(0), sf as never)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('backs off as long as Salesforce asks when the API limit is reached', async () => {
    const sf = salesforce([() => json(403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }], { 'retry-after': '600' })])
    const err = await handleIntegrationSync(job(2), sf as never).catch(e => e)
    expect(err).toBeInstanceOf(SalesforceRateLimitError)
    expect(syncBackoff(3, err)).toBe(600_000)
  })

  it('files the signed PDF once, on the record and the Opportunity', async () => {
    await setStatus('EXECUTED')
    await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 7, createdById: admin, s3Key: `signed/${contract}/sr1.pdf`, mimeType: 'application/pdf' } })
    const sf = salesforce([
      upsertOk,                                                                       // record
      (c) => c.url.endsWith('/sobjects/Opportunity/006000000000001AAA') ? new Response(null, { status: 204 }) : json(500, []),  // Amount, draftLegal-owned after signing
      () => json(201, { id: '068000000000001AAA', success: true }),                   // ContentVersion
      () => json(200, { ContentDocumentId: '069000000000001AAA' }),                   // its document
      () => json(201, { id: '06A000000000001AAA', success: true }),                   // link to the Opportunity
    ])
    const outcome = await handleIntegrationSync(job(0), sf as never)
    expect(outcome).toMatchObject({ synced: 1, filesUploaded: 1 })
    expect(calls[1].body).toEqual({ Amount: 45000 })
    const upload = calls.find(c => c.url.endsWith('/sobjects/ContentVersion'))!
    expect(upload.body).toMatchObject({ PathOnClient: 'Acme Order Form.pdf', FirstPublishLocationId: 'a0X000000000000AAA' })
    expect(Buffer.from(upload.body.VersionData, 'base64').toString()).toBe('%PDF-1.7 signed')
    const link = calls.find(c => c.url.endsWith('/sobjects/ContentDocumentLink'))!
    expect(link.body).toMatchObject({ ContentDocumentId: '069000000000001AAA', LinkedEntityId: '006000000000001AAA' })

    // Already filed: a later sync of the same contract doesn't upload again.
    calls = []
    const again = await handleIntegrationSync(job(0), salesforce([upsertOk]) as never)
    expect(again?.filesUploaded).toBe(0)
    expect(calls.some(c => c.url.includes('ContentVersion'))).toBe(false)
  })
})

describe('Integration health', () => {
  it('shows the last failure with a retry that re-queues the sync', async () => {
    await setStatus('PENDING_SIGNATURE')
    await handleIntegrationSync(job(0), salesforce([() => json(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Down again' }])]) as never).catch(() => undefined)
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations/health', headers: auth(org, ['ADMIN'], admin) })
    expect(res.statusCode).toBe(200)
    const sf = res.json().integrations.find((i: { provider: string }) => i.provider === 'salesforce')
    expect(sf).toMatchObject({ status: 'connected', health: 'degraded' })
    expect(sf.syncs24h.failed).toBeGreaterThan(0)
    expect(sf.lastFailure.error).toContain('Down again')

    const retry = await app.inject({ method: 'POST', url: `/api/v1/admin/integrations/salesforce/sync-log/${sf.lastFailure.id}/retry`, headers: auth(org, ['ADMIN'], admin) })
    expect(retry.statusCode).toBe(200)
    const waiting = await integrationSyncQueue.getJobs(['delayed', 'waiting'])
    expect(waiting.some(j => j.data.contractId === contract && j.data.event === 'retry')).toBe(true)

    // Another org's log row is not found, let alone retried.
    const other = await makeUser(unconnectedOrg)
    const cross = await app.inject({ method: 'POST', url: `/api/v1/admin/integrations/salesforce/sync-log/${sf.lastFailure.id}/retry`, headers: auth(unconnectedOrg, ['ADMIN'], other) })
    expect(cross.statusCode).toBe(404)
  })
})

describe('queueing from events', () => {
  it('queues a contract event for a connected org only, batched by contract', async () => {
    await integrationSyncQueue.obliterate({ force: true })
    await noteIntegrationEvent(org, 'contract.updated', { contractId: contract })
    await noteIntegrationEvent(org, 'signature.sent', { contractId: contract })
    await noteIntegrationEvent(org, 'invoice.created', { contractId: contract })
    await noteIntegrationEvent(unconnectedOrg, 'contract.updated', { contractId: 'elsewhere' })
    const jobs = await integrationSyncQueue.getJobs(['delayed', 'waiting'])
    expect(jobs.map(j => j.data.contractId)).toEqual([contract])
  })
})
