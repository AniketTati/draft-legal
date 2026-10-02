/**
 * docs/41 Part 14 — renewal reminders reach the owner and watchers; an
 * undecided renewal close to its notice deadline is escalated to Legal Ops
 * once; and each person's calendar feed carries the dates of the contracts
 * they can see, stops working when revoked, and never crosses orgs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const sent = vi.hoisted(() => [] as Array<{ orgId: string; userId: string; type: string; resourceId?: string; title: string }>)
vi.mock('../lib/queue.js', async (orig) => ({
  ...(await orig<typeof import('../lib/queue.js')>()),
  queueNotification: (p: { orgId: string; userId: string; type: string; resourceId?: string; title: string }) => { sent.push(p) },
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, grantRole, auth, cleanupAll, prisma } from '../test-support/helpers.js'
import { scanRenewals } from '../lib/obligation-scanner.js'

const DAY = 24 * 60 * 60 * 1000
let orgA: string, orgB: string
let owner: string, watcher: string, legalOps: string, ownerB: string
let soon: string, decided: string, later: string, otherOrg: string

async function renewing(org: string, ownerId: string, title: string, deadlineInDays: number) {
  const id = await makeContract(org, ownerId, { title, status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id },
    data: {
      expiryDate: new Date(Date.now() + (deadlineInDays + 90) * DAY),
      keyTerms: { autoRenew: true, noticePeriodDays: 90 },
      renewalType: 'auto', noticeDays: 90, noticeDeadline: new Date(Date.now() + deadlineInDays * DAY),
    },
  })
  return id
}

const escalations = (id: string) => sent.filter(n => n.type === 'ESCALATION' && n.resourceId === id)
const reminders = (id: string) => sent.filter(n => n.type === 'RENEWAL_DUE' && n.resourceId === id)

beforeAll(async () => {
  await getApp()
  orgA = await makeOrg('Renewal Reminders A')
  orgB = await makeOrg('Renewal Reminders B')
  owner = await makeUser(orgA); await grantRole(orgA, owner, 'ADMIN')
  watcher = await makeUser(orgA); await grantRole(orgA, watcher, 'VIEWER')
  legalOps = await makeUser(orgA); await grantRole(orgA, legalOps, 'LEGAL_OPS')
  ownerB = await makeUser(orgB); await grantRole(orgB, ownerB, 'ADMIN')
  soon = await renewing(orgA, owner, 'Soon Deadline MSA', 10)
  decided = await renewing(orgA, owner, 'Already Decided MSA', 10)
  later = await renewing(orgA, owner, 'Later Deadline MSA', 20)
  otherOrg = await renewing(orgB, ownerB, 'Other Org Secret MSA', 10)
  await prisma.renewalDecision.create({ data: { orgId: orgA, contractId: decided, decision: 'renew', decidedById: owner } })
  await prisma.obligation.create({
    data: { orgId: orgA, contractId: soon, type: 'payment', description: 'Pay the annual fee', quote: 'Customer shall pay the annual fee.', dueDate: new Date(Date.now() + 30 * DAY) },
  })
})

afterAll(async () => {
  await prisma.calendarFeed.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await cleanupAll()
  await closeApp()
})

describe('watchers', () => {
  it('adds and removes a watcher, only from the same org', async () => {
    const app = await getApp()
    const h = auth(orgA, ['ADMIN'], owner)
    const add = await app.inject({ method: 'POST', url: `/api/v1/contracts/${soon}/watchers`, headers: h, payload: { userId: watcher } })
    expect(add.statusCode).toBe(201)
    expect(add.json().data.map((w: { userId: string }) => w.userId)).toEqual([watcher])
    const foreign = await app.inject({ method: 'POST', url: `/api/v1/contracts/${soon}/watchers`, headers: h, payload: { userId: ownerB } })
    expect(foreign.statusCode).toBe(404)
    const cross = await app.inject({ method: 'GET', url: `/api/v1/contracts/${soon}/watchers`, headers: auth(orgB, ['ADMIN'], ownerB) })
    expect(cross.statusCode).toBe(404)
    // Watch, then unwatch.
    await app.inject({ method: 'POST', url: `/api/v1/contracts/${later}/watchers`, headers: h, payload: { userId: watcher } })
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/contracts/${later}/watchers/${watcher}`, headers: h })
    expect(del.json().data).toEqual([])
  })
})

describe('the renewal scan', () => {
  it('reminds the owner and the watchers', async () => {
    sent.length = 0
    const res = await scanRenewals({ orgId: orgA })
    expect(res.errors).toEqual([])
    expect(reminders(soon).map(n => n.userId).sort()).toEqual([owner, watcher].sort())
  })

  it('escalates an undecided renewal inside 14 days of its deadline to Legal Ops, once', async () => {
    expect(escalations(soon).map(n => n.userId)).toEqual(expect.arrayContaining([legalOps]))
    expect(escalations(soon).map(n => n.userId)).not.toContain(watcher)
    expect(escalations(decided)).toEqual([])
    expect(escalations(later)).toEqual([])   // 20 days out, past the 14-day lead
    const md = (await prisma.contract.findUnique({ where: { id: soon }, select: { metadata: true } }))!.metadata as { renewalEscalatedFor?: string }
    expect(md.renewalEscalatedFor).toBe(new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10))

    sent.length = 0
    const again = await scanRenewals({ orgId: orgA, force: true })
    expect(again.escalated).toBe(0)
    expect(escalations(soon)).toEqual([])
    expect(reminders(soon).length).toBeGreaterThan(0)   // the reminder itself still goes out when forced
  })

  it('uses the org’s own lead time', async () => {
    await prisma.organization.update({ where: { id: orgA }, data: { settings: { renewalEscalationDays: 30 } } })
    sent.length = 0
    await scanRenewals({ orgId: orgA })
    expect(escalations(later).map(n => n.userId)).toContain(legalOps)
    await prisma.organization.update({ where: { id: orgA }, data: { settings: {} } })
  })
})

describe('the calendar feed', () => {
  const tokenOf = (url: string) => url.split('/calendar/')[1].replace(/\.ics$/, '')
  const feed = async (token: string) => (await getApp()).inject({ method: 'GET', url: `/api/v1/calendar/${token}.ics` })

  it('carries notice deadlines, end dates and obligation due dates for the person’s contracts', async () => {
    const app = await getApp()
    const made = await app.inject({ method: 'POST', url: '/api/v1/calendar-feed', headers: auth(orgA, ['ADMIN'], owner) })
    expect(made.statusCode).toBe(201)
    const res = await feed(tokenOf(made.json().url))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/calendar')
    const ics = res.body
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain(`UID:notice-${soon}@draftlegal`)
    expect(ics).toContain('SUMMARY:Last day to give notice: Soon Deadline MSA')
    expect(ics).toContain(`UID:expiry-${soon}@draftlegal`)
    expect(ics).toContain('SUMMARY:Due: Pay the annual fee')
    // Tenant isolation: another org's contract never appears.
    expect(ics).not.toContain('Other Org Secret MSA')
    expect(ics).not.toContain(otherOrg)
    // Only a hash is stored.
    const row = await prisma.calendarFeed.findFirst({ where: { orgId: orgA, userId: owner } })
    expect(row?.tokenHash).toBeTruthy()
    expect(row?.tokenHash).not.toContain(tokenOf(made.json().url))
  })

  it('shows the other org only its own dates', async () => {
    const app = await getApp()
    const made = await app.inject({ method: 'POST', url: '/api/v1/calendar-feed', headers: auth(orgB, ['ADMIN'], ownerB) })
    const ics = (await feed(tokenOf(made.json().url))).body
    expect(ics).toContain('Other Org Secret MSA')
    expect(ics).not.toContain('Soon Deadline MSA')
  })

  it('a new link ends the old one, and a revoked link is a 404', async () => {
    const app = await getApp()
    const h = auth(orgA, ['ADMIN'], watcher)
    const first = tokenOf((await app.inject({ method: 'POST', url: '/api/v1/calendar-feed', headers: h })).json().url)
    const second = tokenOf((await app.inject({ method: 'POST', url: '/api/v1/calendar-feed', headers: h })).json().url)
    expect((await feed(first)).statusCode).toBe(404)
    expect((await feed(second)).statusCode).toBe(200)
    const status = await app.inject({ method: 'GET', url: '/api/v1/calendar-feed', headers: h })
    expect(status.json().active).toBe(true)
    const revoked = await app.inject({ method: 'DELETE', url: '/api/v1/calendar-feed', headers: h })
    expect(revoked.json().active).toBe(false)
    expect((await feed(second)).statusCode).toBe(404)
    expect((await feed('not-a-real-token')).statusCode).toBe(404)
  })
})
