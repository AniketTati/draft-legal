/**
 * X7 — REST must honour `own` scope beyond the contracts list. A SALES_REP
 * (view:contract at `own`) could open any contract by id (with every version's
 * text and its comments / signature requests), export the org's contracts,
 * and see other reps' contracts through search, counterparty and matter views
 * — and, found in review, through the review queue, obligations, renewals,
 * diligence rooms, invoices, requests by id, a contract's precedents and
 * family, and the dashboard's activity feed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { AuditAction } from '@clm/types'
import { createAuditEvent } from '../lib/audit.js'

const DIM = 1536
const VEC = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`
const IN_60_DAYS = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)

let app: TestApp
let org: string, repA: string, repB: string, mine: string, theirs: string, counterparty: string, matter: string
let oblMine: string, oblTheirs: string, roomA: string, roomB: string, invMine: string, invTheirs: string
let reqA: string, reqB: string, childB: string, siblingB: string

const as = (user: string, roles = ['SALES_REP']) => auth(org, roles, user)
const get = (url: string, user: string, roles?: string[]) => app.inject({ method: 'GET', url, headers: as(user, roles) })

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Own Scope REST Org')
  repA = await makeUser(org)
  repB = await makeUser(org)
  // A custom role with own-scope write access — no default role has one, but
  // the write routes must still stop at the caller's own records.
  await prisma.role.create({
    data: {
      orgId: org, name: 'OWN_EDITOR',
      permissions: [
        { action: 'view', resource: 'contract', scope: 'own' },
        { action: 'edit', resource: 'contract', scope: 'own' },
        { action: 'delete', resource: 'contract', scope: 'own' },
      ],
    },
  })
  counterparty = (await prisma.counterparty.create({ data: { orgId: org, name: 'Globex' } })).id
  matter = (await prisma.matter.create({ data: { orgId: org, name: 'Globex rollout', ownerId: repA, createdById: repA } })).id
  mine = await makeContract(org, repA, { title: 'Alpha Globex MSA', type: 'MSA', status: 'EXECUTED' })
  theirs = await makeContract(org, repB, { title: 'Bravo Globex Secret Terms', type: 'MSA', status: 'EXECUTED' })
  for (const [id, owner, quote] of [[mine, repA, 'ALPHA QUOTE'], [theirs, repB, 'BRAVO SECRET QUOTE']] as const) {
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: owner, plainText: `${id} confidential body` } })
    await prisma.contract.update({
      where: { id },
      data: {
        counterpartyId: counterparty, counterpartyName: 'Globex', matterId: matter, currentVersionId: v.id,
        expiryDate: IN_60_DAYS, analysisStatus: 'DONE', value: id === mine ? 100 : 9_999_999,
        fieldConfidence: { governingLaw: { confidence: 0.2, quote } },
      },
    })
    await prisma.$executeRaw`
      INSERT INTO contract_clauses (id, "versionId", "clauseType", content, embedding)
      VALUES (${`it-x7-${v.id}`}, ${v.id}, 'limitation_of_liability', ${`${quote} clause`}, ${VEC}::vector)
    `
  }
  // Family: mine is an amendment of theirs; B also owns a sibling and a child of mine.
  await prisma.contract.update({ where: { id: mine }, data: { parentContractId: theirs } })
  siblingB = await makeContract(org, repB, { title: 'Bravo Sibling Order Form' })
  childB = await makeContract(org, repB, { title: 'Bravo Child SOW' })
  await prisma.contract.update({ where: { id: siblingB }, data: { parentContractId: theirs } })
  await prisma.contract.update({ where: { id: childB }, data: { parentContractId: mine } })

  const obl = (contractId: string, description: string) => prisma.obligation.create({
    data: { orgId: org, contractId, type: 'payment', description, quote: description, dueDate: IN_60_DAYS },
  })
  oblMine = (await obl(mine, 'Alpha pays monthly')).id
  oblTheirs = (await obl(theirs, 'Bravo secret payment obligation')).id

  roomA = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Alpha room', createdById: repA } })).id
  roomB = (await prisma.diligenceRoom.create({ data: { orgId: org, name: 'Bravo secret room', createdById: repB } })).id

  const inv = (contractId: string, createdById: string, vendorName: string) => prisma.invoice.create({
    data: { orgId: org, contractId, createdById, vendorName, amount: 100, invoiceDate: new Date() },
  })
  invMine = (await inv(mine, repA, 'Alpha Vendor')).id
  invTheirs = (await inv(theirs, repB, 'Bravo Secret Vendor')).id

  const request = (requestedById: string, title: string) => prisma.contractRequest.create({
    data: { orgId: org, requestedById, title, type: 'NDA', description: `${title} details`, matterId: matter },
  })
  reqA = (await request(repA, 'Alpha request')).id
  reqB = (await request(repB, 'Bravo secret request')).id

  await createAuditEvent({ orgId: org, userId: repB, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: theirs })
  await createAuditEvent({ orgId: org, userId: repB, action: AuditAction.REQUEST_CREATED, resourceType: 'contract_request', resourceId: reqB })
  await createAuditEvent({ orgId: org, userId: repA, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: mine })
})

afterAll(async () => {
  const srs = await prisma.signatureRequest.findMany({ where: { orgId: org }, select: { id: true } })
  await prisma.signer.deleteMany({ where: { signatureRequestId: { in: srs.map(r => r.id) } } })
  await prisma.signatureRequest.deleteMany({ where: { orgId: org } })
  await prisma.invoice.deleteMany({ where: { orgId: org } })
  await prisma.obligation.deleteMany({ where: { orgId: org } })
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await prisma.$executeRaw`DELETE FROM contract_clauses WHERE id LIKE 'it-x7-%'`
  await prisma.contract.updateMany({ where: { orgId: org }, data: { matterId: null, counterpartyId: null, parentContractId: null, currentVersionId: null } })
  await prisma.diligenceRoom.deleteMany({ where: { orgId: org } })
  await prisma.matter.deleteMany({ where: { orgId: org } })
  await prisma.counterparty.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('own-scope caller (SALES_REP) over REST', () => {
  it('cannot open another rep\'s contract or its sub-resources by id', async () => {
    for (const url of [`/api/v1/contracts/${theirs}`, `/api/v1/contracts/${theirs}/versions`, `/api/v1/contracts/${theirs}/comments`, `/api/v1/contracts/${theirs}/signature-requests`]) {
      const res = await get(url, repA)
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('confidential body')
    }
  })

  it('still opens their own contract', async () => {
    expect((await get(`/api/v1/contracts/${mine}`, repA)).statusCode).toBe(200)
    expect((await get(`/api/v1/contracts/${mine}/versions`, repA)).statusCode).toBe(200)
  })

  it('export, search, counterparty and matter views show only their own contracts', async () => {
    const csv = await get('/api/v1/contracts/export', repA)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Alpha Globex MSA')
    expect(csv.body).not.toContain('Bravo Globex Secret Terms')

    // (Their id can appear as my contract's parentContractId — assert on rows and titles.)
    const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id)
    const search = await app.inject({ method: 'POST', url: '/api/v1/search', headers: as(repA), payload: { q: 'Globex' } })
    expect(search.statusCode).toBe(200)
    expect(ids(search.json().data)).toEqual([mine])
    expect(search.body).not.toContain('Bravo Globex Secret Terms')

    const cp = await get(`/api/v1/counterparties/${counterparty}`, repA)
    expect(cp.statusCode).toBe(200)
    expect(cp.body).toContain('Alpha Globex MSA')
    expect(cp.body).not.toContain('Bravo Globex Secret Terms')

    const m = await get(`/api/v1/matters/${matter}`, repA)
    expect(m.statusCode).toBe(200)
    expect(ids(m.json().contracts)).toEqual([mine])
    expect(ids(m.json().requests)).toEqual([reqA])
  })

  it('the org-wide signature list shows own contracts, plus requests where they sign', async () => {
    const vOf = async (id: string) => (await prisma.contractVersion.findFirstOrThrow({ where: { contractId: id } })).id
    const theirsSr = await prisma.signatureRequest.create({ data: { orgId: org, contractId: theirs, versionId: await vOf(theirs), createdById: repB } })
    const mineSr = await prisma.signatureRequest.create({ data: { orgId: org, contractId: mine, versionId: await vOf(mine), createdById: repA } })
    const repAEmail = (await prisma.user.findUniqueOrThrow({ where: { id: repA } })).email
    const signingForB = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await vOf(theirs), createdById: repB,
        signers: { create: [{ email: repAEmail.toUpperCase(), name: 'Rep A', token: `it-${Date.now()}-a` }] } },
    })
    const linkedForB = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await vOf(theirs), createdById: repB,
        signers: { create: [{ email: 'rep.a.alias@test.local', userId: repA, name: 'Rep A', token: `it-${Date.now()}-b` }] } },
    })
    const res = await get('/api/v1/signature-requests', repA)
    expect(res.statusCode).toBe(200)
    const ids = res.json().data.map((r: { id: string }) => r.id)
    expect(ids).toContain(mineSr.id)
    expect(ids, 'signer email typed in another case').toContain(signingForB.id)
    expect(ids, 'signer linked by user id').toContain(linkedForB.id)
    expect(ids).not.toContain(theirsSr.id)
  })

  it('the org-wide portfolio query is refused rather than widened', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search/portfolio-query', headers: as(repA), payload: { query: 'all Globex contracts' } })
    expect(res.statusCode).toBe(403)
  })

  it('the review queue lists only their own contracts\' fields', async () => {
    const all = await get('/api/v1/review-queue?threshold=1', repA)
    expect(all.statusCode).toBe(200)
    expect(all.body).toContain('ALPHA QUOTE')
    expect(all.body).not.toContain('BRAVO SECRET QUOTE')
    const byId = await get(`/api/v1/review-queue?threshold=1&contractId=${theirs}`, repA)
    expect(byId.json().items).toEqual([])
  })

  it('obligations: list, export, stats and by-id cover only their own contracts', async () => {
    const list = await get('/api/v1/obligations', repA)
    expect(list.statusCode).toBe(200)
    const ids = list.json().data.map((o: { id: string }) => o.id)
    expect(ids).toContain(oblMine)
    expect(ids).not.toContain(oblTheirs)
    const csv = await get('/api/v1/obligations/export', repA)
    expect(csv.body).toContain('Alpha pays monthly')
    expect(csv.body).not.toContain('Bravo secret payment obligation')
    expect((await get('/api/v1/obligations/stats', repA)).json().open).toBe(1)
    expect((await get(`/api/v1/obligations/${oblTheirs}`, repA)).statusCode).toBe(404)
    expect((await get(`/api/v1/obligations/${oblTheirs}/evidence`, repA)).statusCode).toBe(404)
    expect((await get(`/api/v1/obligations/${oblMine}`, repA)).statusCode).toBe(200)
  })

  it('renewals: list, export and stats cover only their own contracts', async () => {
    const list = await get('/api/v1/renewals', repA)
    expect(list.statusCode).toBe(200)
    const ids = list.json().data.map((r: { id: string }) => r.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
    const csv = await get('/api/v1/renewals/export', repA)
    expect(csv.body).toContain('Alpha Globex MSA')
    expect(csv.body).not.toContain('Bravo Globex Secret Terms')
    expect((await get('/api/v1/renewals/stats', repA)).json().next90).toBe(1)
  })

  it('diligence: only the rooms they created', async () => {
    const list = await get('/api/v1/diligence', repA)
    expect(list.statusCode).toBe(200)
    const ids = list.json().data.map((r: { id: string }) => r.id)
    expect(ids).toContain(roomA)
    expect(ids).not.toContain(roomB)
    for (const sub of ['', '/documents', '/results', '/export']) {
      expect((await get(`/api/v1/diligence/${roomB}${sub}`, repA)).statusCode, sub || '/').toBe(404)
    }
    expect((await get(`/api/v1/diligence/${roomA}`, repA)).statusCode).toBe(200)
  })

  it('invoices: only those on their own contracts', async () => {
    const list = await get('/api/v1/invoices', repA)
    expect(list.statusCode).toBe(200)
    const ids = list.json().data.map((i: { id: string }) => i.id)
    expect(ids).toContain(invMine)
    expect(ids).not.toContain(invTheirs)
    expect(list.body).not.toContain('Bravo Globex Secret Terms')
    expect((await get('/api/v1/invoices/stats', repA)).json().pending).toBe(1)
    expect((await get(`/api/v1/invoices/${invTheirs}`, repA)).statusCode).toBe(404)
    expect((await get(`/api/v1/invoices/${invMine}`, repA)).statusCode).toBe(200)
  })

  it('requests by id: only the ones they raised', async () => {
    expect((await get(`/api/v1/requests/${reqB}`, repA)).statusCode).toBe(404)
    expect((await get(`/api/v1/requests/${reqA}`, repA)).statusCode).toBe(200)
  })

  it('a contract\'s family and precedents name only contracts they own', async () => {
    const fam = await get(`/api/v1/contracts/${mine}/family`, repA)
    expect(fam.statusCode).toBe(200)
    // P0.9 added how it relates to its parent; with none, there is no relation.
    expect(fam.json()).toEqual({ parent: null, children: [], siblings: [], relationshipType: null, splitFromParent: false })

    const prec = await get(`/api/v1/contracts/${mine}/precedents`, repA)
    expect(prec.statusCode).toBe(200)
    expect(prec.body).not.toContain(theirs)
    expect(prec.body).not.toContain('Bravo Globex Secret Terms')
  })

  it('the dashboard counts and feed cover only their own contracts and requests', async () => {
    // A busy org must not push the rep's own activity out of the feed's window.
    for (let i = 0; i < 41; i++) {
      await createAuditEvent({ orgId: org, userId: repB, action: AuditAction.CONTRACT_UPDATED, resourceType: 'contract', resourceId: theirs })
    }
    const dash = await get('/api/v1/dashboard', repA)
    expect(dash.statusCode).toBe(200)
    const body = dash.json()
    expect(body.activeContracts).toBe(1)
    expect(body.expiringSoon).toBe(1)
    expect(body.openRequests).toBe(1)
    const titles = body.recentActivity.map((e: { entityTitle: string }) => e.entityTitle)
    expect(titles).toContain('Alpha Globex MSA')
    expect(titles).not.toContain('Bravo Globex Secret Terms')
    expect(titles).not.toContain('Bravo secret request')

    // A role with no view:request counts only the requests it raised.
    expect((await get('/api/v1/dashboard', repA, ['VIEWER'])).json().openRequests).toBe(1)
  })

  it('analytics and list counts cover only their own contracts', async () => {
    const summary = (await get('/api/v1/analytics/summary', repA)).json()
    expect(summary.totalContracts).toBe(1)
    const top = (await get('/api/v1/analytics/top-counterparties', repA)).json().data
    expect(top).toEqual([expect.objectContaining({ counterparty: 'Globex', count: 1, value: 100 })])
    const dist = (await get('/api/v1/analytics/distributions', repA)).json()
    expect(dist.byType).toEqual([{ key: 'MSA', count: 1 }])

    const cps = (await get('/api/v1/counterparties', repA)).json().data
    expect(cps.find((c: { id: string }) => c.id === counterparty).contractCount).toBe(1)
    const matters = (await get('/api/v1/matters', repA)).json().items
    expect(matters.find((m: { id: string }) => m.id === matter)).toMatchObject({ contractCount: 1, requestCount: 1 })
  })

  it('a custom own-scope editor cannot write to another rep\'s records by id', async () => {
    const editor = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers: as(repA, ['OWN_EDITOR']), ...(payload ? { payload } : {}) })
    expect((await editor('DELETE', `/api/v1/contracts/${theirs}`)).statusCode).toBe(404)
    expect((await editor('POST', `/api/v1/review-queue/${theirs}/verify`, { field: 'governingLaw' })).statusCode).toBe(404)
    expect((await editor('POST', `/api/v1/obligations/${oblTheirs}/complete`, { note: 'x' })).statusCode).toBe(404)
    expect((await editor('POST', `/api/v1/invoices/${invTheirs}/dispute`, { reason: 'x' })).statusCode).toBe(404)
    expect((await editor('PATCH', `/api/v1/diligence/${roomB}`, { name: 'renamed' })).statusCode).toBe(404)
    const theirClause = `it-x7-${(await prisma.contract.findUniqueOrThrow({ where: { id: theirs } })).currentVersionId}`
    expect((await editor('PATCH', `/api/v1/contracts/clauses/${theirClause}/review-state`, { state: 'reviewed' })).statusCode).toBe(404)
    const otherMatter = (await prisma.matter.create({ data: { orgId: org, name: 'Other matter', ownerId: repA, createdById: repA } })).id
    expect((await editor('POST', `/api/v1/matters/${otherMatter}/attach`, { kind: 'contract', entityId: theirs })).statusCode).toBe(404)

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: theirs }, select: { deletedAt: true, fieldConfidence: true } })
    expect(after.deletedAt).toBeNull()
    expect(JSON.stringify(after.fieldConfidence)).not.toContain('verifiedAt')
    expect((await prisma.obligation.findUniqueOrThrow({ where: { id: oblTheirs } })).status).toBe('OPEN')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invTheirs } })).status).toBe('PENDING')
    expect((await prisma.diligenceRoom.findUniqueOrThrow({ where: { id: roomB } })).name).toBe('Bravo secret room')
    expect((await prisma.contractClause.findUniqueOrThrow({ where: { id: theirClause } })).reviewState).toBe('unreviewed')
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: theirs } })).matterId).toBe(matter)
  })
})

describe('unaffected callers', () => {
  it('the owner and an ADMIN still reach the contract', async () => {
    expect((await get(`/api/v1/contracts/${theirs}`, repB)).statusCode).toBe(200)
    expect((await get(`/api/v1/contracts/${theirs}`, repA, ['ADMIN'])).statusCode).toBe(200)
    const csv = await get('/api/v1/contracts/export', repA, ['ADMIN'])
    expect(csv.body).toContain('Bravo Globex Secret Terms')
  })

  it('an ADMIN still sees the whole org on every surface narrowed above', async () => {
    const admin = (url: string) => get(url, repA, ['ADMIN'])
    expect((await admin(`/api/v1/obligations/${oblTheirs}`)).statusCode).toBe(200)
    expect((await admin(`/api/v1/invoices/${invTheirs}`)).statusCode).toBe(200)
    expect((await admin(`/api/v1/diligence/${roomB}`)).statusCode).toBe(200)
    expect((await admin(`/api/v1/requests/${reqB}`)).statusCode).toBe(200)
    expect((await admin('/api/v1/renewals')).json().data.map((r: { id: string }) => r.id)).toContain(theirs)
    expect((await admin('/api/v1/review-queue?threshold=1')).body).toContain('BRAVO SECRET QUOTE')

    const fam = (await admin(`/api/v1/contracts/${mine}/family`)).json()
    expect(fam.parent?.id).toBe(theirs)
    expect(fam.children.map((c: { id: string }) => c.id)).toEqual([childB])
    expect(fam.siblings.map((c: { id: string }) => c.id)).toEqual([siblingB])
    expect((await admin(`/api/v1/contracts/${mine}/precedents`)).body).toContain(theirs)

    expect((await admin('/api/v1/analytics/summary')).json().totalContracts).toBeGreaterThan(1)
    const dash = (await admin('/api/v1/dashboard')).json()
    expect(dash.activeContracts).toBeGreaterThan(1)
    expect(dash.recentActivity.map((e: { entityTitle: string }) => e.entityTitle)).toContain('Bravo Globex Secret Terms')
  })
})
