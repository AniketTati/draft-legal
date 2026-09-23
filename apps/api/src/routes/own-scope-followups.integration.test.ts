/**
 * X21 — own-scope follow-ups from the X7 review:
 *   - the dashboard's org-wide approval count and /team/workload counted the
 *     whole org for own-scope callers;
 *   - the Signatures page linked a signer who doesn't own the contract to a
 *     contract page that 404s for them;
 *   - a converted request became the converter's contract, so its requester
 *     (own scope) could never open it;
 *   - the collaboration server let any org member join any contract's
 *     document.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueDraftContract: vi.fn(),
  queueParseDocument: vi.fn(),
}))
vi.mock('../lib/elasticsearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/elasticsearch.js')>()),
  indexContract: vi.fn(async () => {}),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { authenticateCollab } from '../lib/collab-server.js'

let app: TestApp
let org: string, rep: string, rep2: string, legal: string, viewer: string, editor: string
let mine: string, theirs: string, editorsOwn: string

const as = (user: string, roles = ['SALES_REP']) => auth(org, roles, user)
const tokenOf = (user: string, roles = ['SALES_REP']) => as(user, roles).authorization.replace(/^Bearer /, '')

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Own Scope Follow-ups Org')
  ;[rep, rep2, legal, viewer, editor] = await Promise.all([makeUser(org), makeUser(org), makeUser(org), makeUser(org), makeUser(org)])
  // May view and edit, but only contracts it owns (created before any request:
  // role permissions are cached per org).
  await prisma.role.create({ data: { orgId: org, name: 'OWN_EDITOR', permissions: [
    { action: 'view', resource: 'contract', scope: 'own' },
    { action: 'edit', resource: 'contract', scope: 'own' },
  ] } })
  editorsOwn = await makeContract(org, editor, { title: 'Editor contract' })
  mine = await makeContract(org, rep, { title: 'Rep contract', status: 'IN_NEGOTIATION' })
  theirs = await makeContract(org, rep2, { title: 'Other rep contract', status: 'IN_NEGOTIATION' })
  for (const c of [mine, theirs]) {
    const v = await prisma.contractVersion.create({ data: { contractId: c, versionNumber: 1, createdById: rep, plainText: 'x' } })
    await prisma.contract.update({ where: { id: c }, data: { currentVersionId: v.id } })
  }
})

afterAll(async () => {
  const srs = await prisma.signatureRequest.findMany({ where: { orgId: org }, select: { id: true } })
  await prisma.signer.deleteMany({ where: { signatureRequestId: { in: srs.map(r => r.id) } } })
  await prisma.signatureRequest.deleteMany({ where: { orgId: org } })
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
  await prisma.workflowDefinition.deleteMany({ where: { orgId: org } })
  await prisma.contractRequest.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await prisma.role.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('aggregates count only what the caller could open', () => {
  it('the dashboard\'s org approval count, for an own-scope caller, is their contracts\' approvals', async () => {
    const wf = await makeWorkflow(org, legal, legal)
    for (const contractId of [mine, theirs]) {
      await prisma.approvalInstance.create({ data: { orgId: org, contractId, workflowDefinitionId: wf, submittedById: legal } })
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: as(rep) })).json().orgPendingApprovals).toBe(1)
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: as(legal, ['LEGAL_OPS']) })).json().orgPendingApprovals).toBe(2)
  })

  it('team workload: other members\' counts are hidden from an own-scope caller, not faked', async () => {
    type Row = { id: string; activeContracts: number | null; pendingApprovals: number | null }
    const byId = (rows: Row[]) => new Map(rows.map(r => [r.id, r]))
    const forRep = byId((await app.inject({ method: 'GET', url: '/api/v1/team/workload', headers: as(rep) })).json())
    expect(forRep.get(rep)?.activeContracts).toBe(1)
    expect(forRep.get(rep2)?.activeContracts).toBeNull()
    expect(forRep.get(legal)?.pendingApprovals).toBeNull()
    const forLegal = byId((await app.inject({ method: 'GET', url: '/api/v1/team/workload', headers: as(legal, ['LEGAL_OPS']) })).json())
    expect(forLegal.get(rep2)?.activeContracts).toBe(1)
    expect(forLegal.get(rep)?.pendingApprovals).toBe(0)
  })
})

describe('the Signatures page', () => {
  it('sends a signer who can\'t open the contract to their own signing page', async () => {
    const versionOf = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId!
    const repEmail = (await prisma.user.findUniqueOrThrow({ where: { id: rep } })).email
    const signing = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await versionOf(theirs), createdById: rep2,
        signers: { create: [
          { email: repEmail, name: 'Rep', token: `it-x21-${Date.now()}-rep` },
          { email: 'someone@else.test', name: 'Other', token: `it-x21-${Date.now()}-other` },
        ] } },
    })
    const own = await prisma.signatureRequest.create({ data: { orgId: org, contractId: mine, versionId: await versionOf(mine), createdById: rep } })

    const rows = (await app.inject({ method: 'GET', url: '/api/v1/signature-requests', headers: as(rep) })).json().data as Array<{
      id: string; canOpenContract: boolean; mySignPath: string | null; signers: Array<Record<string, unknown>>
    }>
    const row = rows.find(r => r.id === signing.id)!
    expect(row.canOpenContract).toBe(false)
    expect(row.mySignPath).toMatch(/^\/sign\/it-x21-\d+-rep$/)   // their own row's token, nobody else's
    expect(JSON.stringify(row.signers)).not.toContain('it-x21-')   // no tokens in the list
    expect(rows.find(r => r.id === own.id)!.canOpenContract).toBe(true)
    // The contract page is indeed closed to them, and the signing page open.
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${theirs}`, headers: as(rep) })).statusCode).toBe(404)
  })
})

describe('request conversion', () => {
  it('the contract belongs to whoever asked for it', async () => {
    const request = await prisma.contractRequest.create({
      data: { orgId: org, title: 'New NDA', type: 'NDA', requestedById: rep, description: 'Please draft an NDA' },
    })
    const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${request.id}/convert`, headers: as(legal, ['LEGAL_OPS']) })
    expect(res.statusCode).toBe(201)
    const contractId = res.json().contractId as string
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).ownerId).toBe(rep)
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${contractId}`, headers: as(rep) })).statusCode).toBe(200)
  })
})

describe('the collaboration server', () => {
  const join = (user: string, roles: string[], contractId: string) => {
    const connectionConfig = { readOnly: false }
    return authenticateCollab({ token: tokenOf(user, roles), documentName: `contract:${contractId}`, connectionConfig })
      .then(() => connectionConfig)
  }

  it('refuses an own-scope member on a contract they don\'t own', async () => {
    await expect(join(rep, ['SALES_REP'], theirs)).rejects.toThrow()
    await expect(join(editor, ['OWN_EDITOR'], theirs)).rejects.toThrow()
  })

  it('lets an editor in read-write, and anyone who may only view in read-only', async () => {
    expect(await join(editor, ['OWN_EDITOR'], editorsOwn)).toEqual({ readOnly: false })
    expect(await join(legal, ['LEGAL_OPS'], theirs)).toEqual({ readOnly: false })
    expect(await join(viewer, ['VIEWER'], theirs)).toEqual({ readOnly: true })
    expect(await join(rep, ['SALES_REP'], mine)).toEqual({ readOnly: true })   // SALES_REP has no edit:contract
  })
})
