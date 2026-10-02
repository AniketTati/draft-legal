/**
 * docs/41 Part 14 — the renewal columns follow the values people confirm and
 * the amendments that get signed, and the renewals list reads them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { setFieldValues } from './field-store.js'
import { transition } from './lifecycle.js'
import { syncRenewalTerms } from './renewal-terms.js'

const DAY = 86_400_000
let app: TestApp
let org: string, owner: string, parent: string, otherOrg: string

const cols = (id: string) => prisma.contract.findUniqueOrThrow({
  where: { id }, select: { renewalType: true, noticeDays: true, noticeDeadline: true, renewalTermMonths: true, priceUpliftCap: true, renewalConfirmed: true },
})
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null
const expiry = new Date(Date.now() + 200 * DAY)

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Renewal Terms Org')
  owner = await makeUser(org)
  otherOrg = await makeOrg('Other Renewal Org')
  parent = await makeContract(org, owner, { title: 'Initech Licence', status: 'EXECUTED' })
  await prisma.contract.update({ where: { id: parent }, data: { stage: 'active', stageState: 'active', expiryDate: expiry } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('renewal columns', () => {
  it('are worked out when a person sets the renewal values, and say they were confirmed', async () => {
    const r = await setFieldValues({
      orgId: org, contractId: parent, userId: owner, audit: { source: 'test' } as never,
      values: [
        { key: 'renewalType', raw: 'Automatic' },
        { key: 'nonRenewalNotice', raw: '30 days' },
        { key: 'renewalTerm', raw: '12 months' },
        { key: 'priceUpliftCap', raw: '5%' },
      ],
    })
    expect(r.ok).toBe(true)
    const c = await cols(parent)
    expect(c).toMatchObject({ renewalType: 'auto', noticeDays: 30, renewalTermMonths: 12, priceUpliftCap: 5, renewalConfirmed: true })
    expect(day(c.noticeDeadline)).toBe(day(new Date(expiry.getTime() - 30 * DAY)))
  })

  it('move the parent’s deadline when an amendment changing the notice is signed, not before', async () => {
    const a = await makeContract(org, owner, { title: 'Amendment No. 1', status: 'OUT_FOR_SIGNATURE' })
    await prisma.contract.update({
      where: { id: a },
      data: { parentContractId: parent, relationshipType: 'amendment', stage: 'sign', stageState: 'out_for_signature', keyTerms: { nonRenewalNotice: '90 days' } },
    })
    await syncRenewalTerms(org, parent)
    expect((await cols(parent)).noticeDays).toBe(30)
    const moved = await transition({ orgId: org, contractId: a, to: { stage: 'active' }, source: 'signature' })
    expect(moved.ok && moved.changed).toBe(true)
    const c = await cols(parent)
    expect(c.noticeDays).toBe(90)
    expect(day(c.noticeDeadline)).toBe(day(new Date(expiry.getTime() - 90 * DAY)))
  })

  it('are what the renewals list shows', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/renewals', headers: auth(org, ['ADMIN'], owner) })
    expect(r.statusCode).toBe(200)
    const rows = r.json().data as Array<{ id: string; notice: { days: number; deadline: string } }>
    const row = rows.find(x => x.id === parent)
    expect(row?.notice.days).toBe(90)
    expect(row?.notice.deadline.slice(0, 10)).toBe(day(new Date(expiry.getTime() - 90 * DAY)))
  })

  it('aren’t synced across orgs', async () => {
    expect(await syncRenewalTerms(otherOrg, parent)).toBeNull()
  })
})
