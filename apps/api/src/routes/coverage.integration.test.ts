/**
 * V2 — list answers carry their coverage, and date/value questions are
 * answered by filters with true counts rather than by sorting a sample.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string
const DAY = 24 * 60 * 60 * 1000
const iso = (d: Date) => d.toISOString().slice(0, 10)

const tool = (name: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/api/internal/ai/tools/${name}`,
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, ...payload },
})

async function executed(title: string, expiresInDays: number, value: number) {
  const id = await makeContract(org, owner, { title, status: 'EXECUTED' })
  await prisma.contract.update({ where: { id }, data: { expiryDate: new Date(Date.now() + expiresInDays * DAY), value } })
  return id
}

let soonest: string[] = []

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Coverage Org')
  owner = await makeUser(org)
  // 4 upcoming within 90 days, 3 lapsed within the last 30, 5 far out.
  soonest = [await executed('Up A', 10, 500_000), await executed('Up B', 20, 2_000_000), await executed('Up C', 40, 1_500_000)]
  await executed('Up D', 80, 100_000)
  for (const d of [-5, -10, -25]) await executed(`Lapsed ${d}`, d, 50_000)
  for (let i = 0; i < 5; i++) await executed(`Far ${i}`, 400 + i, 3_000_000)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('contract_search coverage and ranges', () => {
  it('a page says it is a page', async () => {
    const res = (await tool('contract_search', { limit: 5 })).json()
    expect(res.totalMatching).toBe(12)
    expect(res.coverage).toEqual({ returned: 5, totalMatching: 12, complete: false, note: 'Showing 5 of 12 matching contracts. Say there are 12, and that these are 5 of them.' })
  })

  it('"expiring in the next 90 days" is a filter with a true count', async () => {
    const today = new Date()
    const res = (await tool('contract_search', {
      expiryDateFrom: iso(today), expiryDateTo: iso(new Date(Date.now() + 90 * DAY)), limit: 50,
    })).json()
    expect(res.totalMatching).toBe(4)
    expect(res.coverage.complete).toBe(true)
    expect(res.results.map((r: { title: string }) => r.title).sort()).toEqual(['Up A', 'Up B', 'Up C', 'Up D'])
  })

  it('"worth over $1M" is a filter too, and composes with a date range', async () => {
    const big = (await tool('contract_search', { valueMin: 1_000_000, limit: 50 })).json()
    expect(big.totalMatching).toBe(7) // Up B, Up C, Far ×5
    const bigAndSoon = (await tool('contract_search', {
      valueMin: 1_000_000, expiryDateFrom: iso(new Date()), expiryDateTo: iso(new Date(Date.now() + 90 * DAY)),
    })).json()
    expect(bigAndSoon.totalMatching).toBe(2)
  })

  it('rejects a malformed date instead of silently ignoring it', async () => {
    expect((await tool('contract_search', { expiryDateFrom: 'next spring' })).statusCode).toBe(400)
  })
})

describe('renewal_advice', () => {
  it('lists upcoming renewals first and reports true counts, not page counts', async () => {
    const res = (await tool('renewal_advice', { leadDays: 90, limit: 3 })).json()
    expect(res.items.map((i: { contractId: string }) => i.contractId)).toEqual(soonest)
    expect(res).toMatchObject({ expiringSoon: 4, recentlyExpired: 3, totalMatching: 7 })
    expect(res.coverage).toMatchObject({ returned: 3, totalMatching: 7, complete: false })
    expect(res.windowNote).toMatch(/Only 3 of the 7/)
  })
})

describe('portfolio_search', () => {
  it('always says whether its ranked hits are complete', async () => {
    const res = (await tool('portfolio_search', { query: 'termination for convenience' })).json()
    expect(res.coverage).toBeDefined()
    expect(typeof res.coverage.complete).toBe('boolean')
    if (res.coverage.totalMatching == null) expect(res.coverage.note).toMatch(/sample/)
  })
})
