/**
 * docs/41 Part 17 — the Salesforce pieces with no database: the contract
 * record payload (stage, turn, links), the OAuth helpers (login URLs, org id),
 * the REST client's 401 refresh and API-limit handling, and the backoff.
 */
import { describe, it, expect, vi } from 'vitest'
import { contractSyncPayload, stageFor, turnFor, salesforceLinks } from './payload.js'
import { normaliseLoginUrl, orgIdFromIdentityUrl, sameSalesforceId, isSalesforceHost, authorizeUrl } from './oauth.js'
import { SalesforceClient, SalesforceRateLimitError, SalesforceApiError } from './client.js'
import { syncBackoff } from '../integrations/backoff.js'

const contract = {
  id: 'c1', title: 'Order Form — Acme', type: 'ORDER_FORM', status: 'PENDING_APPROVAL',
  value: 45000, currency: 'USD', effectiveDate: new Date('2026-11-01T00:00:00Z'), expiryDate: '2027-10-31T00:00:00.000Z',
  counterpartyName: 'Acme', owner: { name: 'Priya' }, approvals: { approved: 1, total: 2 },
  counterparty: { crmId: '001000000000001AAA' },
  metadata: { salesforce: { opportunityId: '006000000000001AAA', quoteId: 'not-an-id' } },
}

describe('contractSyncPayload', () => {
  it('upserts by our id with stage, turn, dates, value, counterparty, links and a way back', () => {
    const p = contractSyncPayload(contract, new Date('2026-10-01T00:00:00Z'))
    expect(p).toMatchObject({
      DL_Contract_Id__c: 'c1', Name: 'Order Form — Acme', DL_Status__c: 'PENDING_APPROVAL',
      DL_Stage__c: 'Approve', DL_Waiting_On__c: 'Approvers (1 of 2)', DL_Approvals__c: '1 of 2',
      DL_Effective_Date__c: '2026-11-01', DL_Expiry_Date__c: '2027-10-31', DL_Value__c: 45000,
      DL_Counterparty__c: 'Acme', DL_Account__c: '001000000000001AAA', DL_Opportunity__c: '006000000000001AAA',
    })
    expect(p.DL_Link__c).toMatch(/\/contracts\/c1$/)
    // An id that isn't a Quote id is never sent as one.
    expect(p).not.toHaveProperty('DL_Quote__c')
  })

  it('takes a stored stage and turn over the ones derived from status (docs/41 Part 18)', () => {
    expect(stageFor({ status: 'UNDER_NEGOTIATION', stage: 'Review' })).toBe('Review')
    expect(turnFor({ ...contract, status: 'UNDER_NEGOTIATION', turn: 'Counterparty (Acme)' })).toBe('Counterparty (Acme)')
  })

  it('names whose move it is from the status when nothing is stored', () => {
    expect(turnFor({ ...contract, status: 'DRAFT' })).toBe('Legal (Priya)')
    expect(turnFor({ ...contract, status: 'PENDING_SIGNATURE' })).toBe('Signers')
    expect(turnFor({ ...contract, status: 'EXECUTED' })).toBeNull()
    expect(stageFor({ status: 'EXECUTED' })).toBe('Signed')
  })

  it('names who an approval waits on, and sends since when the status stands (docs/41 P0.6, P0.10)', () => {
    const waiting = { ...contract, approvals: { approved: 1, total: 3, waitingOn: ['Sam', 'Lee'] }, statusSince: new Date('2026-09-30T10:00:00Z') }
    const p = contractSyncPayload(waiting)
    expect(p.DL_Waiting_On__c).toBe('Approvers: Sam, Lee (1 of 3)')
    expect(p.DL_Waiting_Since__c).toBe('2026-09-30T10:00:00.000Z')
    // A stored waitingSince (Part 18) wins.
    expect(contractSyncPayload({ ...waiting, waitingSince: '2026-09-01T00:00:00Z' }).DL_Waiting_Since__c).toBe('2026-09-01T00:00:00.000Z')
    expect(contractSyncPayload(contract).DL_Waiting_Since__c).toBeNull()
  })

  it('cuts a long title to Salesforce\'s 80-character Name', () => {
    expect((contractSyncPayload({ ...contract, title: 'x'.repeat(120) }).Name as string).length).toBe(80)
  })

  it('finds the account from the counterparty when the request carried none', () => {
    expect(salesforceLinks({ metadata: {}, counterparty: { crmId: '001000000000002AAA' } }).accountId).toBe('001000000000002AAA')
  })
})

describe('Salesforce OAuth helpers', () => {
  it('allows only Salesforce login hosts', () => {
    expect(normaliseLoginUrl(undefined)).toBe('https://login.salesforce.com')
    expect(normaliseLoginUrl('https://test.salesforce.com/')).toBe('https://test.salesforce.com')
    expect(normaliseLoginUrl('https://acme.my.salesforce.com')).toBe('https://acme.my.salesforce.com')
    expect(normaliseLoginUrl('https://acme--uat.sandbox.my.salesforce.com')).toBe('https://acme--uat.sandbox.my.salesforce.com')
    expect(normaliseLoginUrl('http://login.salesforce.com')).toBeNull()
    expect(normaliseLoginUrl('https://evil.example.com')).toBeNull()
    expect(normaliseLoginUrl('https://login.salesforce.com.evil.com')).toBeNull()
    expect(normaliseLoginUrl('https://login.salesforce.com/path')).toBeNull()
    expect(isSalesforceHost('https://acme.my.salesforce.com')).toBe(true)
    expect(isSalesforceHost('https://salesforce.com.evil.io')).toBe(false)
  })

  it('reads the org id from the identity URL and compares 15/18-character ids', () => {
    const id = orgIdFromIdentityUrl('https://login.salesforce.com/id/00D5g000004XyzAEAS/0055g00000ABCdeAAG')
    expect(id).toBe('00D5g000004XyzA')
    expect(sameSalesforceId('00D5g000004XyzAEAS', '00D5g000004XyzA')).toBe(true)
    expect(sameSalesforceId('00D5g000004XyzB', '00D5g000004XyzA')).toBe(false)
    expect(sameSalesforceId(null, '00D5g000004XyzA')).toBe(false)
    expect(orgIdFromIdentityUrl('https://login.salesforce.com/id/nope')).toBeNull()
  })

  it('asks for a refresh token with PKCE', () => {
    const u = new URL(authorizeUrl({ loginUrl: 'https://login.salesforce.com', clientId: 'cid', redirectUri: 'https://app/cb', state: 's', codeChallenge: 'ch' }))
    expect(u.searchParams.get('scope')).toContain('refresh_token')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('s')
  })
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('SalesforceClient', () => {
  it('refreshes the token once on a 401 and sends the call again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }]))
      .mockResolvedValueOnce(json(200, [{ id: 'a01', success: true, created: true }]))
    const refresh = vi.fn(async () => 'fresh-token')
    const client = new SalesforceClient('https://acme.my.salesforce.com', 'stale-token', { refresh, fetch: fetchMock as never })
    const r = await client.upsertContracts([{ DL_Contract_Id__c: 'c1' }])
    expect(r).toEqual([{ id: 'a01', success: true, created: true }])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-token')
    expect(fetchMock.mock.calls[0][0]).toContain('/composite/sobjects/DL_Contract__c/DL_Contract_Id__c')
  })

  it('does not loop when the refreshed token is refused too', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'no' }]))
    const client = new SalesforceClient('https://acme.my.salesforce.com', 't', { refresh: async () => 't2', fetch: fetchMock as never })
    await expect(client.describeGlobal()).rejects.toBeInstanceOf(SalesforceApiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops on the API limit, with Salesforce\'s retry-after', async () => {
    const limit = new SalesforceClient('https://acme.my.salesforce.com', 't', {
      refresh: async () => 't', fetch: vi.fn().mockResolvedValue(json(403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }])) as never,
    })
    await expect(limit.describeGlobal()).rejects.toBeInstanceOf(SalesforceRateLimitError)
    const tooMany = new SalesforceClient('https://acme.my.salesforce.com', 't', {
      refresh: async () => 't', fetch: vi.fn().mockResolvedValue(json(429, [], { 'retry-after': '120' })) as never,
    })
    const err = await tooMany.describeGlobal().catch(e => e)
    expect(err).toBeInstanceOf(SalesforceRateLimitError)
    expect(err.retryAfterMs).toBe(120_000)
  })

  it('sends at most 200 records a call', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => json(200, JSON.parse(init.body).records.map(() => ({ success: true }))))
    const client = new SalesforceClient('https://acme.my.salesforce.com', 't', { refresh: async () => 't', fetch: fetchMock as never })
    const r = await client.upsertContracts(Array.from({ length: 450 }, (_, i) => ({ DL_Contract_Id__c: `c${i}` })))
    expect(r).toHaveLength(450)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('tells a server error (retry) from a refused request (no retry)', () => {
    expect(new SalesforceApiError('x', 503).retryable).toBe(true)
    expect(new SalesforceApiError('x', 0).retryable).toBe(true)
    expect(new SalesforceApiError('x', 400, 'INVALID_FIELD').retryable).toBe(false)
  })
})

describe('sync backoff', () => {
  it('grows exponentially to a cap', () => {
    expect(syncBackoff(1)).toBe(15_000)
    expect(syncBackoff(2)).toBe(30_000)
    expect(syncBackoff(20)).toBe(30 * 60_000)
  })

  it('waits at least as long as Salesforce asked on the API limit', () => {
    expect(syncBackoff(1, new SalesforceRateLimitError('limit', 300_000))).toBe(300_000)
    expect(syncBackoff(1, new SalesforceRateLimitError('limit', 1_000))).toBe(60_000)
  })
})
