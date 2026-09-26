/**
 * C6 — the daily renewal scan must alert on the auto-renewal NOTICE DEADLINE,
 * not only on expiry within 90 days. A contract with a 120-day notice period
 * used to be flagged 30 days after its opt-out date had passed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma } from '../test-support/helpers.js'
import { scanRenewals } from './obligation-scanner.js'

const DAY = 24 * 60 * 60 * 1000
let org: string, owner: string

async function executed(title: string, expiresInDays: number, keyTerms: Record<string, unknown>) {
  const id = await makeContract(org, owner, { title, status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id },
    data: { expiryDate: new Date(Date.now() + expiresInDays * DAY), keyTerms: keyTerms as object },
  })
  return id
}

const notifiedAt = async (id: string) =>
  ((await prisma.contract.findUnique({ where: { id }, select: { metadata: true } }))?.metadata as { renewalNotifiedAt?: string }).renewalNotifiedAt

let lockingSoon: string, plainExpiry: string, notYet: string, expiringSoon: string

beforeAll(async () => {
  await getApp()
  org = await makeOrg('Renewal Scan Org')
  owner = await makeUser(org)
  // 120 days' notice, expires in 140 → the deadline is in 20 days.
  lockingSoon  = await executed('Locks in soon', 140, { autoRenew: true, noticePeriodDays: 120 })
  // Same expiry, but does not auto-renew → nothing to serve notice on yet.
  plainExpiry  = await executed('Just expires', 140, { autoRenew: false, noticePeriodDays: 120 })
  // 120 days' notice, expires in 200 → the deadline is in 80 days: too early to nag.
  notYet       = await executed('Not yet', 200, { autoRenew: 'yes', noticePeriod: '120 days' })
  // Plain expiry inside the 90-day window keeps alerting as before.
  expiringSoon = await executed('Expires soon', 45, {})
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('scanRenewals', () => {
  it('alerts before a 120-day notice deadline, and keeps alerting on near expiry', async () => {
    const res = await scanRenewals({ orgId: org, leadDays: 90 })
    expect(res.errors).toEqual([])
    expect(await notifiedAt(lockingSoon)).toBeTruthy()
    expect(await notifiedAt(expiringSoon)).toBeTruthy()
    expect(await notifiedAt(plainExpiry)).toBeUndefined()
    expect(await notifiedAt(notYet)).toBeUndefined()
  })

  it('GET /renewals reports the same server-derived deadline', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/renewals', headers: auth(org, ['ADMIN'], owner) })
    expect(res.statusCode).toBe(200)
    const row = res.json().data.find((r: { id: string }) => r.id === lockingSoon)
    expect(row.notice).toMatchObject({ autoRenew: true, days: 120 })
    const expected = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10)
    expect(row.notice.deadline.slice(0, 10)).toBe(expected)
    const plain = res.json().data.find((r: { id: string }) => r.id === plainExpiry)
    expect(plain.notice).toMatchObject({ autoRenew: false, deadline: null })
  })
})
