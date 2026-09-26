/**
 * Y2 — every call to a model passes one boundary, which holds the org's PII
 * policy once more over what leaves: a call site whose own redaction missed a
 * value still doesn't send it raw, and the audit trail names the surface that
 * missed it. What the internal tools return to the agents service, which
 * hands it to the model, passes the same check.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { AuditAction } from '@clm/types'
import { getApp, closeApp, makeOrg, makeUser, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { modelFetch } from './model-boundary.js'

const SSN = '123-45-6789'
const AGENTS = 'http://agents.test'
let app: TestApp
let org: string, offOrg: string, tokenizeOrg: string, user: string, offUser: string
const sent: Array<{ url: string; body: string }> = []

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Y2 Boundary Org')
  offOrg = await makeOrg('Y2 Boundary Off Org')
  tokenizeOrg = await makeOrg('Y2 Boundary Tokenize Org')
  await prisma.organization.update({ where: { id: offOrg }, data: { settings: { piiRedactionMode: 'off' } } })
  await prisma.organization.update({ where: { id: tokenizeOrg }, data: { settings: { piiRedactionMode: 'tokenize' } } })
  user = await makeUser(org)
  offUser = await makeUser(offOrg)
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (!url.startsWith(AGENTS)) return realFetch(input, init)
    sent.push({ url, body: String(init?.body) })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

afterEach(() => { sent.length = 0 })

afterAll(async () => {
  vi.restoreAllMocks()
  await cleanupAll()
  await closeApp()
})

const boundaryEvents = (orgId: string, surface: string) => prisma.auditEvent.findMany({
  where: { orgId, action: AuditAction.PII_BOUNDARY_REDACTED, metadata: { path: ['surface'], equals: surface } },
})

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('modelFetch', () => {
  it('replaces a raw value its call site missed, and records which surface missed it', async () => {
    await modelFetch(`${AGENTS}/check`, post({
      plainText:   `The Employee's SSN is ${SSN}.`,
      schedules:   [{ note: `Employee SSN ${SSN}` }],
      contractId:  'c-1',
      callbackUrl: 'http://10.1.2.3/hook',
    }), { orgId: org, surface: 'y2_missed' })

    const body = JSON.parse(sent[0].body)
    expect(body.plainText).toBe('The Employee\'s SSN is [REDACTED:SSN].')
    expect(body.schedules[0].note).toBe('Employee SSN [REDACTED:SSN]')
    // An id, and a URL whose host an IP pattern would otherwise take.
    expect(body.contractId).toBe('c-1')
    expect(body.callbackUrl).toBe('http://10.1.2.3/hook')

    const [event, ...more] = await boundaryEvents(org, 'y2_missed')
    expect(more).toEqual([])
    expect(event.metadata).toMatchObject({ surface: 'y2_missed', mode: 'redact', counts: { SSN: 2 }, total: 2 })
    expect(JSON.stringify(event)).not.toContain(SSN)
  })

  it('leaves the user\'s own words and round-trip tokens as they are, and records nothing', async () => {
    const original = JSON.stringify({
      message:    `Put my SSN ${SSN} in the recital`,
      clauseText: 'Paid to [PII:SSN:0123456789abcdef] monthly; see [REDACTED:CC].',
      session_id: 's-1',
    })
    await modelFetch(`${AGENTS}/agent/chat`, { method: 'POST', body: original }, { orgId: org, surface: 'y2_clean', userAuthored: ['message'] })
    expect(sent[0].body).toBe(original)
    expect(await boundaryEvents(org, 'y2_clean')).toEqual([])
  })

  it('in tokenize mode, a missed value becomes the org\'s token', async () => {
    await modelFetch(`${AGENTS}/check`, post({ plainText: `SSN ${SSN}` }), { orgId: tokenizeOrg, surface: 'y2_tokenize' })
    expect(JSON.parse(sent[0].body).plainText).toMatch(/^SSN \[PII:SSN:[0-9a-f]+\]$/)
    expect(await boundaryEvents(tokenizeOrg, 'y2_tokenize')).toHaveLength(1)
  })

  it('in off mode, sends the body as it is', async () => {
    const original = JSON.stringify({ plainText: `SSN ${SSN}` })
    await modelFetch(`${AGENTS}/check`, { method: 'POST', body: original }, { orgId: offOrg, surface: 'y2_off' })
    expect(sent[0].body).toBe(original)
    expect(await boundaryEvents(offOrg, 'y2_off')).toEqual([])
  })
})

describe('what an internal tool returns to the agents service', () => {
  const matterList = (orgId: string, filters: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/api/internal/ai/tools/matter_list',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId, ...filters },
  })

  it('a matter description with a raw SSN reaches the agents service redacted, on the record', async () => {
    const matter = await prisma.matter.create({ data: { orgId: org, name: 'Y2 matter', description: `Employee SSN ${SSN}`, ownerId: user, createdById: user } })
    const res = await matterList(org)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(SSN)
    expect(res.json().items.find((m: { id: string }) => m.id === matter.id).description).toBe('Employee SSN [REDACTED:SSN]')
    // Written behind the response.
    await vi.waitFor(async () => {
      const [event] = await boundaryEvents(org, 'tool:matter_list')
      expect(event?.metadata).toMatchObject({ counts: { SSN: 1 }, total: 1 })
    })
  })

  // A value the request carried is one the model has (X23: a new value the
  // user asks for comes back in a redline proposal); anything else is still
  // checked. Judged by the request's text: a card number is only recognised
  // near the word "card", and the request carries it bare.
  it('a value the tool\'s request carried comes back as it is', async () => {
    const asked = '345-67-8901', card = '4012 8888 8888 1881', other = '234-56-7890'
    const bySsn = await prisma.matter.create({ data: { orgId: org, name: 'Y2 lookup', description: `Employee SSN ${asked}; spouse SSN ${other}`, ownerId: user, createdById: user } })
    const byCard = await prisma.matter.create({ data: { orgId: org, name: 'Y2 card', description: `Paid to card ${card}; spouse SSN ${other}`, ownerId: user, createdById: user } })
    const found = async (query: string) => (await matterList(org, { query })).json().items.map((m: { id: string; description: string }) => [m.id, m.description])
    expect(await found(asked)).toEqual([[bySsn.id, `Employee SSN ${asked}; spouse SSN [REDACTED:SSN]`]])
    expect(await found(card)).toEqual([[byCard.id, `Paid to card ${card}; spouse SSN [REDACTED:SSN]`]])
  })

  it('in off mode, it is sent as it is', async () => {
    await prisma.matter.create({ data: { orgId: offOrg, name: 'Y2 off matter', description: `Employee SSN ${SSN}`, ownerId: offUser, createdById: offUser } })
    const res = await matterList(offOrg)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(SSN)
  })
})
