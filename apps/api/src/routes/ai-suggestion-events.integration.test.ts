/**
 * docs/41 Part 16 — the AI suggestion log: the web posts outcomes in batches,
 * only for contracts of the caller's org it can see; the table is under
 * tenant row-level security like every org table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, other: string, owner: string, contract: string, theirs: string, v1: string

const post = (events: unknown, headers = auth(org, ['ADMIN'], owner)) =>
  app.inject({ method: 'POST', url: '/api/v1/ai-suggestion-events', headers, payload: { events } })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('AI Events Org')
  other = await makeOrg('AI Events Other Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Events MSA' })
  theirs = await makeContract(other, await makeUser(other), { title: 'Not yours' })
  v1 = (await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, htmlContent: '<p>x</p>', plainText: 'x', createdById: owner } })).id
})
afterAll(async () => { await cleanupAll(); await closeApp() })

describe('POST /ai-suggestion-events', () => {
  it('records a batch, with who and when', async () => {
    const r = await post([
      { contractId: contract, versionId: v1, feature: 'ask_ai', outcome: 'shown', suggestionId: 's1' },
      { contractId: contract, versionId: v1, feature: 'ask_ai', outcome: 'accepted', suggestionId: 's1' },
      { contractId: contract, feature: 'counter', outcome: 'dismissed', suggestionId: 's2' },
    ])
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toEqual({ recorded: 3 })
    const rows = await prisma.aiSuggestionEvent.findMany({ where: { orgId: org, contractId: contract }, orderBy: { at: 'asc' } })
    expect(rows.map(e => `${e.feature}:${e.outcome}`)).toEqual(['ask_ai:shown', 'ask_ai:accepted', 'counter:dismissed'])
    expect(rows.every(e => e.userId === owner && e.at instanceof Date)).toBe(true)
  })

  it('refuses an unknown feature or outcome, an empty batch, and a version of another contract', async () => {
    expect((await post([{ contractId: contract, feature: 'magic', outcome: 'shown' }])).statusCode).toBe(400)
    expect((await post([{ contractId: contract, feature: 'ask_ai', outcome: 'loved' }])).statusCode).toBe(400)
    expect((await post([])).statusCode).toBe(400)
    const c2 = await makeContract(org, owner, { title: 'Other contract' })
    expect((await post([{ contractId: c2, versionId: v1, feature: 'ask_ai', outcome: 'shown' }])).statusCode).toBe(400)
  })

  it('another org\'s contract is not found, and nothing of the batch is written', async () => {
    const before = await prisma.aiSuggestionEvent.count({ where: { orgId: org } })
    const r = await post([{ contractId: contract, feature: 'ask_ai', outcome: 'shown' }, { contractId: theirs, feature: 'ask_ai', outcome: 'shown' }])
    expect(r.statusCode).toBe(404)
    expect(await prisma.aiSuggestionEvent.count({ where: { orgId: org } })).toBe(before)
    expect(await prisma.aiSuggestionEvent.count({ where: { contractId: theirs } })).toBe(0)
  })

  it('needs to be signed in', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/ai-suggestion-events', payload: { events: [] } })
    expect(r.statusCode).toBe(401)
  })

  it('is under tenant row-level security', async () => {
    const rows = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ai_suggestion_events'`
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const policies = await prisma.$queryRaw<Array<{ policyname: string }>>`SELECT policyname FROM pg_policies WHERE tablename = 'ai_suggestion_events'`
    expect(policies.map(p => p.policyname)).toContain('tenant_isolation')
  })
})
