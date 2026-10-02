/**
 * docs/41 Part 14 — a renewal decision starts its action: a renewal letter,
 * a renegotiation draft from the agreement as it stands (reviewed against
 * it), or a notice of non-renewal tracked against the deadline and ending the
 * contract at its end date; none of it reachable from another org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { resolveBaseline } from '../lib/review-findings.js'
import { scanStageDates } from '../lib/lifecycle-dates.js'

const DAY = 86_400_000
let app: TestApp
let org: string, owner: string, otherOrg: string, otherUser: string

const admin = () => auth(org, ['ADMIN'], owner)
const decide = (id: string, decision: string, headers = admin()) =>
  app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/renewal-decision`, headers, payload: { decision, reason: 'Checked with the business' } })
const state = (id: string, headers = admin()) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/renewal`, headers })

/** A signed contract ending in `days`, with renewal values in its terms. */
async function signed(title: string, days: number, keyTerms: Record<string, unknown>, text?: string) {
  const id = await makeContract(org, owner, { title, type: 'MSA', status: 'EXECUTED' })
  await prisma.contract.update({
    where: { id },
    data: { stage: 'active', stageState: 'active', counterpartyName: 'Hooli', effectiveDate: new Date('2025-01-01'), expiryDate: new Date(Date.now() + days * DAY), keyTerms: keyTerms as object },
  })
  if (text) {
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: text, htmlContent: `<p>${text}</p>` } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'term', sectionRef: '2', content: 'The term is one year and renews only if both parties agree.', sortOrder: 0 } })
    await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'payment_terms', sectionRef: '5', content: 'Fees are payable within 30 days.', sortOrder: 1 } })
  }
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Renewal Decisions Org')
  owner = await makeUser(org)
  otherOrg = await makeOrg('Other Decisions Org')
  otherUser = await makeUser(otherOrg)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('renegotiate (the acceptance case)', () => {
  it('opens a renewal draft linked to the parent with its effective text, reviewed against the current terms', async () => {
    // Manual renewal, 90 days' notice, ending in 150 days: 60 days before the deadline.
    const parent = await signed('Hooli MSA', 150, { renewalType: 'By agreement', nonRenewalNotice: '90 days', renewalTerm: '12 months' }, 'Term and fees.')
    const s = (await state(parent)).json()
    expect(s.terms).toMatchObject({ renewalType: 'manual', noticeDays: 90 })
    expect(s.daysToDeadline).toBeGreaterThanOrEqual(59)
    expect(s.daysToDeadline).toBeLessThanOrEqual(61)
    expect(s.inWindow).toBe(true)
    expect(s.choices.map((c: { decision: string }) => c.decision)).toEqual(['renew', 'renegotiate', 'let_lapse', 'terminate'])

    const r = await decide(parent, 'renegotiate')
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body).toMatchObject({ decision: 'renegotiate', decidedInTime: true })
    const child = await prisma.contract.findUniqueOrThrow({ where: { id: body.actionContract.id }, select: { parentContractId: true, relationshipType: true, amendmentNumber: true, title: true, currentVersionId: true, metadata: true, stage: true } })
    expect(child).toMatchObject({ parentContractId: parent, relationshipType: 'renewal', amendmentNumber: 1, title: 'Renewal No. 1 of Hooli MSA', stage: 'draft' })
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: child.currentVersionId! } })
    expect(v.htmlContent).toContain('renews only if both parties agree')
    expect(v.htmlContent).toContain('Fees are payable within 30 days.')
    // Its first version is reviewed against the agreement it renews.
    const baseline = await resolveBaseline(body.actionContract.id, { id: v.id, versionNumber: 1 })
    const parentVersion = (await prisma.contract.findUniqueOrThrow({ where: { id: parent }, select: { currentVersionId: true } })).currentVersionId
    expect(baseline).toMatchObject({ reason: 'parent', versionId: parentVersion })
    // Created through the lifecycle: its starting stage is on the record.
    expect(await prisma.auditEvent.count({ where: { resourceId: body.actionContract.id, action: 'STAGE_CHANGED' } })).toBe(1)
    const row = await prisma.renewalDecision.findFirstOrThrow({ where: { contractId: parent } })
    expect(row).toMatchObject({ decision: 'renegotiate', decidedById: owner, reason: 'Checked with the business', actionContractId: body.actionContract.id, decidedInTime: true })
  })
})

describe('renew as is', () => {
  it('drafts a renewal letter extending the term when it renews only by agreement', async () => {
    const id = await signed('Pied Piper licence', 120, { renewalType: 'By agreement', nonRenewalNotice: '30 days', renewalTerm: '24 months' })
    const r = await decide(id, 'renew')
    expect(r.statusCode).toBe(201)
    const letter = await prisma.contract.findUniqueOrThrow({ where: { id: r.json().actionContract.id }, select: { relationshipType: true, title: true, expiryDate: true, currentVersionId: true } })
    expect(letter.relationshipType).toBe('renewal')
    expect(letter.title).toContain('renewal letter')
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: letter.currentVersionId! } })
    expect(v.htmlContent).toContain('24 months')
    expect(v.htmlContent).toContain('Hooli')
    expect(Math.round((letter.expiryDate!.getTime() - Date.now()) / DAY)).toBeGreaterThan(120 + 700)
  })

  it('records it and drafts nothing when it renews on its own', async () => {
    const id = await signed('Auto SaaS', 100, { renewalType: 'Automatic', nonRenewalNotice: '30 days' })
    const r = await decide(id, 'renew')
    expect(r.statusCode).toBe(201)
    expect(r.json().actionContract).toBeNull()
    expect(await prisma.contract.count({ where: { parentContractId: id } })).toBe(0)
  })

  it('starts nothing new for the same decision twice, and supersedes a different one', async () => {
    const id = await signed('Twice', 100, { renewalType: 'By agreement', nonRenewalNotice: '30 days' })
    const first = await decide(id, 'renew')
    const again = await decide(id, 'renew')
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ unchanged: true, actionContract: { id: first.json().actionContract.id } })
    expect(await prisma.contract.count({ where: { parentContractId: id } })).toBe(1)
    await decide(id, 'renegotiate')
    const rows = await prisma.renewalDecision.findMany({ where: { contractId: id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map(r => [r.decision, r.supersededAt != null])).toEqual([['renew', true], ['renegotiate', false]])
    expect((await state(id)).json().history).toHaveLength(1)
  })
})

describe('let it lapse, or end it', () => {
  it('drafts the notice, shows the contract as expiring, tracks the notice sent in time, and closes it at its end date', async () => {
    const id = await signed('Lapse me', 100, { renewalType: 'Automatic', nonRenewalNotice: '30 days' })
    const r = await decide(id, 'let_lapse')
    expect(r.statusCode).toBe(201)
    const notice = await prisma.contract.findUniqueOrThrow({ where: { id: r.json().actionContract.id }, select: { title: true, relationshipType: true, currentVersionId: true } })
    expect(notice).toMatchObject({ title: 'Notice of non-renewal: Lapse me', relationshipType: 'other' })
    const v = await prisma.contractVersion.findUniqueOrThrow({ where: { id: notice.currentVersionId! } })
    expect(v.htmlContent).toContain('will not renew')
    expect(v.htmlContent).toContain('30')
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('expiring')

    const sent = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/renewal-decision/notice-sent`, headers: admin(), payload: {} })
    expect(sent.statusCode).toBe(200)
    expect(sent.json().noticeSentInTime).toBe(true)
    expect((await state(id)).json().decision).toMatchObject({ decision: 'let_lapse', noticeSentInTime: true })

    // At its end date it expires instead of renewing on its own.
    const after = new Date(Date.now() + 101 * DAY)
    await scanStageDates({ orgId: org, now: after })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('expired')
  })

  it('closes an ended contract as terminated, and a notice sent late says so', async () => {
    const id = await signed('End me', 20, { renewalType: 'Automatic', nonRenewalNotice: '30 days' })
    const r = await decide(id, 'terminate')
    expect(r.json().decidedInTime).toBe(false)
    const sent = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/renewal-decision/notice-sent`, headers: admin(), payload: { sentAt: new Date().toISOString().slice(0, 10) } })
    expect(sent.json().noticeSentInTime).toBe(false)
    await scanStageDates({ orgId: org, now: new Date(Date.now() + 21 * DAY) })
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect([c.stage, c.stageState]).toEqual(['closed', 'terminated'])
  })

  it('renews on its own at its end date when the notice was never sent', async () => {
    const id = await signed('Forgot to send', 50, { renewalType: 'Automatic', nonRenewalNotice: '30 days' })
    await decide(id, 'let_lapse')
    await scanStageDates({ orgId: org, now: new Date(Date.now() + 51 * DAY) })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('auto_renewed')
  })

  it('moves the expiry on by the renewal term when it renews on its own, with the notice deadline and a record (fix-up 16)', async () => {
    const id = await signed('Renews yearly', 10, { renewalType: 'Automatic', renewalTerm: '12 months', nonRenewalNotice: '30 days' })
    const was = (await prisma.contract.findUniqueOrThrow({ where: { id } })).expiryDate!
    const day = (d: Date) => d.toISOString().slice(0, 10)
    const next = new Date(was); next.setUTCMonth(next.getUTCMonth() + 12)
    const r = await scanStageDates({ orgId: org, now: new Date(Date.now() + 11 * DAY) })
    expect(r.errors).toEqual([])
    const c = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(c.stageState).toBe('auto_renewed')
    expect(day(c.expiryDate!)).toBe(day(next))
    expect(day(c.noticeDeadline!)).toBe(day(new Date(c.expiryDate!.getTime() - 30 * DAY)))
    const fv = await prisma.contractFieldValue.findFirstOrThrow({ where: { contractId: id, fieldKey: 'expiryDate' } })
    expect(fv).toMatchObject({ source: 'renewal', value: day(next) })
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' }, orderBy: { createdAt: 'desc' } })
    expect(ev.metadata).toMatchObject({ source: 'auto_renewal', action: 'renewed_expiry', from: day(was), to: day(next), months: 12 })
    const moved = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'STAGE_CHANGED' }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(moved.metadata)).toContain(`it now runs to ${day(next)}`)
    // The renewed term nears its end like the first, and renews again.
    await scanStageDates({ orgId: org, now: new Date(c.expiryDate!.getTime() - 10 * DAY) })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('expiring')
    await scanStageDates({ orgId: org, now: new Date(c.expiryDate!.getTime() + DAY) })
    const again = await prisma.contract.findUniqueOrThrow({ where: { id } })
    expect(again.stageState).toBe('auto_renewed')
    expect(again.expiryDate!.getTime()).toBeGreaterThan(c.expiryDate!.getTime())
  })

  it('a change of mind to "renew" takes it out of Expiring soon, and the date job leaves it there (fix-up 18)', async () => {
    const id = await signed('Changed my mind', 20, { renewalType: 'Automatic', renewalTerm: '12 months', nonRenewalNotice: '10 days' })
    await decide(id, 'let_lapse')
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('expiring')
    expect((await decide(id, 'renew')).statusCode).toBe(201)
    expect(await prisma.contract.findUniqueOrThrow({ where: { id } })).toMatchObject({ stage: 'active', stageState: 'renewing' })
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'STAGE_CHANGED' }, orderBy: { createdAt: 'desc' } })
    expect(ev.metadata).toMatchObject({ toState: 'renewing' })
    // Inside the expiring window, still Renewing; at its end date it renews on its own.
    await scanStageDates({ orgId: org, now: new Date(Date.now() + 5 * DAY) })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('renewing')
    await scanStageDates({ orgId: org, now: new Date(Date.now() + 21 * DAY) })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).stageState).toBe('auto_renewed')
  })

  it('has no notice to mark sent without a decision not to renew', async () => {
    const id = await signed('No notice', 100, { renewalType: 'Automatic' })
    await decide(id, 'renew')
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/renewal-decision/notice-sent`, headers: admin(), payload: {} })
    expect(r.statusCode).toBe(409)
  })
})

describe('refusals and isolation', () => {
  it('refuses an unknown decision and a contract that isn’t running', async () => {
    const id = await signed('Draft one', 100, {})
    expect((await decide(id, 'maybe')).statusCode).toBe(400)
    await prisma.contract.update({ where: { id }, data: { stage: 'draft', stageState: 'drafting', status: 'DRAFT' } })
    expect((await decide(id, 'renew')).statusCode).toBe(409)
  })

  it('reads an older "let_expire" as letting it lapse', async () => {
    const id = await signed('Old client', 100, { renewalType: 'Automatic' })
    expect((await decide(id, 'let_expire')).json().decision).toBe('let_lapse')
  })

  it('another org can’t read or decide', async () => {
    const id = await signed('Private', 100, { renewalType: 'Automatic' })
    const outsider = auth(otherOrg, ['ADMIN'], otherUser)
    expect((await state(id, outsider)).statusCode).toBe(404)
    expect((await decide(id, 'terminate', outsider)).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/renewal-decision/notice-sent`, headers: outsider, payload: {} })).statusCode).toBe(404)
    expect(await prisma.renewalDecision.count({ where: { contractId: id } })).toBe(0)
  })
})
