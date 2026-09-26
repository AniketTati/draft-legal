/**
 * Z4 — Settings › Notifications and Team › Out of office do what they say.
 * "Daily digest" emailed everything at once, "A contract I own is updated"
 * was never sent, and approvals went to approvers who were away.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const sent: Array<{ to: string; subject: string; text: string }> = []
vi.mock('./mailer.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./mailer.js')>()),
  isEmailConfigured: () => true,
  sendEmail: async (args: { to: string; subject: string; text: string }) => { sent.push(args); return { sent: true, via: 'smtp' } },
}))
// Kept off the shared Redis queue, which the dev API's workers also consume.
vi.mock('./queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  queueNotification: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { deliverNotification } from './notification-delivery.js'
import { sendDueDigests } from './notification-digest.js'
import { queueNotification } from './queue.js'

let app: TestApp
let org: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Z4 Notifications Org')
})
afterAll(async () => { await cleanupAll(); await closeApp() })

/** A moment in Asia/Kolkata (UTC+5:30), as UTC. */
const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 8, day, hh, mm) - 330 * 60_000)

describe('the daily digest', () => {
  it('holds each chosen email and sends them together once a day, from 9am in the person\'s timezone', async () => {
    const user = await makeUser(org)
    const { email } = await prisma.user.update({
      where: { id: user },
      data:  { preferences: { notifications: { digest: 'daily' }, general: { timezone: 'Asia/Kolkata' } } },
    })
    const notify = (type: string, title: string) => deliverNotification({
      orgId: org, userId: user, type, title, body: `${title} body`, resourceType: 'contract', resourceId: 'c1', email,
    })
    sent.length = 0

    expect(await notify('APPROVAL_REQUEST', 'Z4 first')).toMatchObject({ notified: true, emailed: false })
    expect(await notify('RENEWAL_DUE', 'Z4 second')).toMatchObject({ emailed: false })
    // An escalation is a direct assignment: it never waits.
    expect(await notify('ESCALATION', 'Z4 escalated')).toMatchObject({ emailed: true })
    expect(sent.map(s => s.subject)).toEqual(['Z4 escalated'])
    sent.length = 0

    await sendDueDigests(ist(20, 8, 45))
    expect(sent).toEqual([])

    await sendDueDigests(ist(20, 9, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: email, subject: 'Your DraftLegal digest: 2 updates' })
    expect(sent[0].text).toContain('Z4 first')
    expect(sent[0].text).toContain('Z4 second')
    expect(await prisma.notification.count({ where: { userId: user, emailDigest: true } })).toBe(0)

    // Later the same day: held for tomorrow, not sent again today.
    await notify('APPROVAL_DECIDED', 'Z4 third')
    await sendDueDigests(ist(20, 15, 0))
    expect(sent).toHaveLength(1)
    await sendDueDigests(ist(21, 9, 15))
    expect(sent).toHaveLength(2)
    expect(sent[1].subject).toBe('Your DraftLegal digest: 1 update')
    expect(sent[1].text).toContain('Z4 third')
  })
})

describe('"A contract I own is updated"', () => {
  it('tells the owner when a colleague changes their contract, at most once an hour', async () => {
    const owner = await makeUser(org)
    const colleague = await makeUser(org)
    const contract = await makeContract(org, owner, { title: 'Z4 owned contract' })
    const edit = (by: string, title: string) => app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN'], by), payload: { title },
    })
    const notices = () => vi.mocked(queueNotification).mock.calls
      .map(([job]) => job)
      .filter(job => job.type === 'CONTRACT_UPDATED' && job.resourceId === contract)

    expect((await edit(owner, 'Z4 owned contract (owner edit)')).statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    expect(notices()).toEqual([])

    expect((await edit(colleague, 'Z4 owned contract (colleague edit)')).statusCode).toBe(200)
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 3000 })
    expect(notices()[0]).toMatchObject({ userId: owner, title: expect.stringContaining('was updated') })

    expect((await edit(colleague, 'Z4 owned contract (again)')).statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    expect(notices()).toHaveLength(1)
  })
})

describe('out of office', () => {
  it('sends an approval to the delegate of an approver who is away, and back once they return', async () => {
    const admin = await makeUser(org)
    const away = await makeUser(org)
    const delegate = await makeUser(org)
    await prisma.user.update({ where: { id: away }, data: { outOfOffice: true, outOfOfficeUntil: new Date(Date.now() + 86_400_000), delegateToId: delegate } })
    const wf = await app.inject({
      method: 'POST', url: '/api/v1/approvals/workflows', headers: auth(org, ['ADMIN'], admin),
      payload: { name: 'Z4 OOO', isDefault: true, steps: [{ order: 0, name: 'Review', approverId: away, executionMode: 'sequential', requiredApprovals: 1, dueSoonHours: 48 }] },
    })
    expect(wf.statusCode).toBe(201)
    const assignee = async () => {
      const contract = await makeContract(org, admin, { title: 'Z4 OOO contract' })
      const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${contract}/submit-approval`, headers: auth(org, ['ADMIN'], admin), payload: {} })
      expect(res.statusCode, res.body).toBe(201)
      return (await prisma.approvalStep.findMany({ where: { instance: { contractId: contract }, status: 'PENDING' } })).map(s => s.approverId)
    }

    expect(await assignee()).toEqual([delegate])
    await prisma.user.update({ where: { id: away }, data: { outOfOfficeUntil: new Date(Date.now() - 60_000) } })
    expect(await assignee()).toEqual([away])
  })
})
