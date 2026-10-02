/**
 * docs/41 Part 19 — the decision-led analytics sections against real rows:
 * each section's figures, its filters, the CSV, the contracts behind a bar
 * (and the contract list filtered to them), and nothing from another org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY)
let app: TestApp
let org: string, owner: string, approver: string, otherOrg: string, otherUser: string
const ids: Record<string, string> = {}

const admin = () => auth(org, ['ADMIN'], owner)
const get = (path: string, headers = admin()) => app.inject({ method: 'GET', url: `/api/v1/analytics/${path}`, headers })

async function move(contractId: string, daysAgo: number, m: Record<string, unknown>, orgId = org) {
  await prisma.auditEvent.create({ data: { orgId, action: 'STAGE_CHANGED', resourceType: 'contract', resourceId: contractId, metadata: m as object, createdAt: ago(daysAgo) } })
}

async function contract(key: string, o: { type?: string; created: number; executed?: number; stage: string; turn?: string; turnSince?: number; template?: boolean; noticeDeadline?: Date; renewalType?: string; counterparty?: string }, orgId = org, ownerId = owner) {
  const id = await makeContract(orgId, ownerId, { title: `Analytics ${key}`, type: o.type ?? 'NDA', status: o.executed != null ? 'EXECUTED' : 'DRAFT' })
  await prisma.contract.update({
    where: { id },
    data: {
      createdAt: ago(o.created), stage: o.stage, turn: o.turn ?? 'internal', turnSince: ago(o.turnSince ?? o.created),
      counterpartyName: o.counterparty ?? 'Acme', executedAt: o.executed != null ? ago(o.executed) : null,
      metadata: o.template ? { _origin: { templateId: 'tpl-nda', templateName: 'Mutual NDA' } } : {},
      noticeDeadline: o.noticeDeadline ?? null, renewalType: o.renewalType ?? null,
    },
  })
  ids[key] = id
  return id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Analytics Sections Org')
  owner = await makeUser(org)
  approver = await makeUser(org)
  await prisma.user.update({ where: { id: approver }, data: { name: 'Priya Approver' } })
  otherOrg = await makeOrg('Analytics Other Org')
  otherUser = await makeUser(otherOrg)

  // Our paper, 15 days request to executed, through every stage.
  const a = await contract('ours', { created: 20, executed: 5, stage: 'active', template: true })
  await move(a, 20, { from: null, toStage: 'request', toTurn: 'internal', created: true })
  await move(a, 18, { fromStage: 'request', toStage: 'draft', fromTurn: 'internal', toTurn: 'internal' })
  await move(a, 15, { fromStage: 'draft', toStage: 'negotiate', fromTurn: 'internal', toTurn: 'counterparty' })
  await move(a, 10, { fromStage: 'negotiate', toStage: 'negotiate', fromTurn: 'counterparty', toTurn: 'internal' })
  await move(a, 9, { fromStage: 'negotiate', toStage: 'approve', fromTurn: 'internal', toTurn: 'approvers' })
  await move(a, 7, { fromStage: 'approve', toStage: 'sign', fromTurn: 'approvers', toTurn: 'signers' })
  await move(a, 5, { fromStage: 'sign', toStage: 'active', fromTurn: 'signers', toTurn: 'none' })
  // Their paper, 38 days, with a required clause still missing when signed.
  const b = await contract('theirs', { type: 'MSA', created: 40, executed: 2, stage: 'active', counterparty: 'Globex' })
  // With the counterparty for 3 days now.
  await contract('waiting', { created: 6, stage: 'negotiate', turn: 'counterparty', turnSince: 3 })
  // Renewals: one deadline ahead and undecided, one passed without a decision.
  await contract('renewSoon', { created: 400, executed: 380, stage: 'active', noticeDeadline: new Date(Date.now() + 20 * DAY), renewalType: 'auto' })
  await contract('renewMissed', { created: 400, executed: 390, stage: 'active', noticeDeadline: ago(10), renewalType: 'auto' })

  // Versions and findings at signature.
  for (const [cid, key] of [[a, 'ours'], [b, 'theirs']] as const) {
    const v = await prisma.contractVersion.create({ data: { contractId: cid, versionNumber: 1, createdById: owner, plainText: 'x', htmlContent: '<p>x</p>' } })
    await prisma.contract.update({ where: { id: cid }, data: { currentVersionId: v.id } })
    ids[`${key}Version`] = v.id
  }
  const finding = (contractId: string, versionId: string, o: Record<string, unknown>) => prisma.reviewFinding.create({ data: {
    orgId: org, contractId, versionId, kind: 'modified', key: `k-${Math.random()}`, clauseType: 'limitation_of_liability', severity: 'high', title: 't', explanation: 'e', evidence: {}, source: 'deterministic', ...o,
  } })
  const countered = await finding(a, ids.oursVersion, { status: 'resolved', resolvedById: owner, resolvedAt: ago(9) })
  await finding(b, ids.theirsVersion, { kind: 'missing_required', clauseType: 'confidentiality', severity: 'high', status: 'open' })

  // An approval: submitted 9 days ago, decided by Priya a day later; and an exception she granted.
  const wf = await makeWorkflow(org, owner, approver)
  const inst = await prisma.approvalInstance.create({ data: { orgId: org, contractId: a, workflowDefinitionId: wf, status: 'APPROVED', currentStepOrder: 0, submittedById: owner, submittedAt: ago(9), decidedAt: ago(8) } })
  await prisma.approvalStep.create({ data: { orgId: org, approvalInstanceId: inst.id, contractId: a, stepOrder: 0, stepName: 'Legal Review', approverId: approver, status: 'APPROVED', decision: 'APPROVED', decidedAt: ago(8), createdAt: ago(9) } })
  await prisma.approvalStep.create({ data: { orgId: org, kind: 'clause_exception', contractId: a, findingId: countered.id, clauseType: 'limitation_of_liability', stepOrder: 0, stepName: 'Exception', approverId: approver, status: 'APPROVED', decision: 'APPROVED', decidedAt: ago(9), createdAt: ago(10) } })

  // Another org's executed contract, renewal and finding: never in this org's figures.
  ids.foreign = await contract('foreign', { created: 30, executed: 1, stage: 'active', noticeDeadline: new Date(Date.now() + 10 * DAY), renewalType: 'auto' }, otherOrg, otherUser)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

type Bar = { key: string; label: string; value: number | null; n: number; extra?: Record<string, unknown> }
const bar = (bars: Bar[], key: string) => bars.find(b => b.key === key)

describe('speed', () => {
  it('measures request to executed by type and paper, and filters by paper and type', async () => {
    const r = await get('speed')
    expect(r.statusCode).toBe(200)
    const cycle = r.json().parts.cycle
    expect(cycle.headline).toMatchObject({ executed: 2 })
    expect(bar(cycle.charts.byType, 'NDA')!.value).toBeCloseTo(15, 0)
    expect(bar(cycle.charts.byPaper, 'theirs')!.value).toBeCloseTo(38, 0)
    // Bars go out without their contract ids; the drill-down serves those.
    expect(cycle.charts.byType[0]).not.toHaveProperty('ids')
    expect(r.json().parts.templates.charts.byTemplate[0]).toMatchObject({ key: 'tpl-nda', label: 'Mutual NDA', extra: { executed: 1, medianTurns: 1 } })

    expect((await get('speed?paperSource=ours')).json().parts.cycle.headline.executed).toBe(1)
    expect((await get('speed?type=MSA')).json().parts.cycle.headline.executed).toBe(1)
    expect((await get(`speed?from=${ago(3).toISOString()}`)).json().parts.cycle.headline.executed).toBe(1)
  })

  it('refuses a bad filter', async () => {
    expect((await get('speed?paperSource=mine')).statusCode).toBe(400)
    expect((await get(`speed?from=${ago(1).toISOString()}&to=${ago(5).toISOString()}`)).statusCode).toBe(400)
  })
})

describe('bottlenecks', () => {
  it('times each stage from the stage events and each approver from when the step became theirs', async () => {
    const p = (await get('bottlenecks')).json().parts
    const negotiate = bar(p.stages.charts.byStage, 'negotiate')!
    expect(negotiate.n).toBe(2)
    expect(negotiate.extra).toMatchObject({ inStageNow: 1 })
    expect(bar(p.stages.charts.byStage, 'approve')!.value).toBeCloseTo(2, 0)
    const priya = bar(p.approvals.charts.byApprover, approver)!
    expect(priya).toMatchObject({ label: 'Priya Approver', n: 2 })
    expect(bar(p.approvals.charts.byStep, 'Legal Review')!.value).toBeCloseTo(1, 0)
  })
})

describe('workload', () => {
  it('shows Legal Ops the team\'s waiting work by who holds it', async () => {
    const p = (await get('workload')).json().parts
    expect(p.mine).toBeDefined()
    expect(bar(p.team.charts.byHolder, 'counterparty')).toMatchObject({ n: 1 })
    expect(bar(p.team.charts.byAge, '3-7')!.n).toBeGreaterThanOrEqual(1)
  })
})

describe('negotiation', () => {
  it('measures counterparty turnaround and the clauses negotiated', async () => {
    const p = (await get('negotiation')).json().parts
    expect(p.turns.headline).toMatchObject({ turnsReturned: 1, withCounterpartyNow: 1 })
    expect(p.turns.headline.turnaroundMedianDays).toBeCloseTo(5, 0)
    expect(bar(p.clauses.charts.byClause, 'limitation_of_liability')).toMatchObject({ label: 'Limitation of liability', n: 1, extra: { countered: 1 } })
  })
})

describe('risk', () => {
  it('reads adherence at the signed version and the exceptions granted', async () => {
    const p = (await get('risk')).json().parts
    expect(p.adherence.headline).toMatchObject({ executed: 2, reviewed: 2, adherent: 1, rate: 0.5 })
    expect(bar(p.adherence.charts.openByClause, 'confidentiality')!.n).toBe(1)
    expect(p.exceptions.headline).toMatchObject({ requested: 1, granted: 1, grantRate: 1 })
  })
})

describe('renewals', () => {
  it('lists the undecided deadline ahead and the missed one', async () => {
    const p = (await get('renewals')).json().parts.renewals
    expect(bar(p.charts.upcoming, '0-30')!.n).toBe(1)
    expect(p.headline).toMatchObject({ missed: 1, missedAutoRenewing: 1 })
  })
})

describe('AI acceptance', () => {
  it('says it is not available while suggestion outcomes are not recorded here', async () => {
    const [{ t }] = await prisma.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('ai_suggestion_events')::text AS t`
    const p = (await get('ai')).json().parts.acceptance
    if (!t) expect(p.available).toBe(false)
    else expect(p.available).toBe(true)
  })
})

describe('CSV and drill-down', () => {
  it('exports a section as CSV, a row per bar', async () => {
    const r = await get('speed?format=csv')
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.headers['content-disposition']).toContain('analytics-speed-')
    const lines = r.body.trim().split('\n')
    expect(lines[0]).toMatch(/^chart,key,label,value,n,/)
    expect(lines.some(l => l.startsWith('cycle.byType,NDA,NDA,15'))).toBe(true)
  })

  it('lists the contracts behind a bar, and the contract list shows just those', async () => {
    const d = (await get('drilldown?metric=speed.cycle.byPaper&key=ours')).json()
    expect(d).toMatchObject({ label: 'Our paper', total: 1, ids: [ids.ours] })
    expect((await get('drilldown?metric=renewals.renewals.outcome&key=missed')).json().ids).toEqual([ids.renewMissed])
    expect((await get('drilldown?metric=speed.nope.byType&key=x')).statusCode).toBe(404)
    expect((await get('drilldown?metric=speed.cycle.byType')).statusCode).toBe(400)

    const list = await app.inject({ method: 'GET', url: `/api/v1/contracts?ids=${ids.ours},${ids.theirs},${ids.foreign}`, headers: admin() })
    expect(list.json().data.map((c: { id: string }) => c.id).sort()).toEqual([ids.ours, ids.theirs].sort())
  })
})

describe('isolation and permissions', () => {
  it('never counts or lists another org\'s contracts', async () => {
    const theirs = (path: string) => get(path, auth(otherOrg, ['ADMIN'], otherUser))
    expect((await theirs('speed')).json().parts.cycle.headline.executed).toBe(1)
    expect((await theirs('drilldown?metric=speed.cycle.byType&key=NDA')).json().ids).toEqual([ids.foreign])
    expect((await get('drilldown?metric=speed.cycle.byType&key=NDA')).json().ids).not.toContain(ids.foreign)
    expect((await get('drilldown?metric=renewals.renewals.upcoming&key=0-30')).json().ids).toEqual([ids.renewSoon])
    expect((await theirs('risk')).json().parts.exceptions.headline.requested).toBe(0)
  })

  it('needs permission to view contracts', async () => {
    expect((await get('speed', auth(org, [], owner))).statusCode).toBe(403)
  })
})
