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
import { authenticateCollab, checkCollabMessage } from '../lib/collab-server.js'

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
  // May work requests, but not create contracts.
  await prisma.role.create({ data: { orgId: org, name: 'REQUEST_EDITOR', permissions: [
    { action: 'view', resource: 'request', scope: 'org' },
    { action: 'edit', resource: 'request', scope: 'org' },
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

describe('the Sign link goes to exactly one person, on their turn', () => {
  const versionOf = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId!
  const emailOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).email
  const rowFor = async (user: string, srId: string) => ((await app.inject({ method: 'GET', url: '/api/v1/signature-requests', headers: as(user) })).json().data as Array<{ id: string; mySignPath: string | null }>)
    .find(r => r.id === srId)

  it('a signer can only be linked to the member whose address it is', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${theirs}/send-for-signature`, headers: as(legal, ['LEGAL_OPS']),
      payload: { signers: [{ name: 'Counterparty CEO', email: 'ceo@counterparty.test', userId: rep }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a row linked to one user and addressed to another is only the linked user\'s', async () => {
    const sr = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await versionOf(theirs), createdById: rep2,
        signers: { create: [{ email: await emailOf(rep), userId: rep2, name: 'Mixed', token: `it-x21-mixed-${Date.now()}` }] } },
    })
    expect((await rowFor(rep, sr.id))?.mySignPath ?? null).toBeNull()
  })

  it('sequential signing: no link before the caller\'s group is being asked, none after expiry', async () => {
    const sr = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await versionOf(theirs), createdById: rep2, signOrder: 'SEQUENTIAL',
        signers: { create: [
          { email: 'first@counterparty.test', name: 'First', signOrder: 1, token: `it-x21-seq1-${Date.now()}` },
          { email: await emailOf(rep), name: 'Rep', signOrder: 2, token: `it-x21-seq2-${Date.now()}` },
        ] } },
    })
    expect((await rowFor(rep, sr.id))?.mySignPath).toBeNull()
    await prisma.signer.updateMany({ where: { signatureRequestId: sr.id, signOrder: 1 }, data: { status: 'SIGNED', signedAt: new Date() } })
    expect((await rowFor(rep, sr.id))?.mySignPath).toMatch(/^\/sign\/it-x21-seq2-/)
    await prisma.signatureRequest.update({ where: { id: sr.id }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    expect((await rowFor(rep, sr.id))?.mySignPath).toBeNull()
  })

  it('an underscore in the caller\'s address matches only an underscore', async () => {
    const tag = Date.now().toString(36)
    const underscored = (await prisma.user.create({ data: { orgId: org, email: `it_x21_${tag}@test.local`, passwordHash: 'x', name: 'Underscore' } })).id
    const lookalike = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await versionOf(theirs), createdById: rep2,
        signers: { create: [{ email: `itXx21X${tag}@test.local`, name: 'Lookalike', token: `it-x21-look-${tag}` }] } },
    })
    const exact = await prisma.signatureRequest.create({
      data: { orgId: org, contractId: theirs, versionId: await versionOf(theirs), createdById: rep2,
        signers: { create: [{ email: `IT_X21_${tag}@TEST.LOCAL`, name: 'Exact', token: `it-x21-exact-${tag}` }] } },
    })
    const ids = ((await app.inject({ method: 'GET', url: '/api/v1/signature-requests', headers: as(underscored) })).json().data as Array<{ id: string }>).map(r => r.id)
    expect(ids).not.toContain(lookalike.id)
    expect(ids).toContain(exact.id)   // the address itself, in any case, still matches
  })
})

describe('request conversion', () => {
  it('needs create:contract as well as request rights', async () => {
    const request = await prisma.contractRequest.create({
      data: { orgId: org, title: 'Keyed NDA', type: 'NDA', requestedById: rep, description: 'x' },
    })
    const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${request.id}/convert`, headers: as(legal, ['REQUEST_EDITOR']) })
    expect(res.statusCode).toBe(403)
    expect((await prisma.contractRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('SUBMITTED')
  })

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

  it('an open connection loses its rights with its token, its user or its contract (X29)', async () => {
    const ctx = await authenticateCollab({ token: tokenOf(editor, ['OWN_EDITOR']), documentName: `contract:${editorsOwn}`, connectionConfig: { readOnly: false } })
    await expect(checkCollabMessage({ ...ctx })).resolves.toBeUndefined()
    await expect(checkCollabMessage({ ...ctx }, (ctx.exp + 1) * 1000)).rejects.toThrow('Session expired')

    await prisma.contract.update({ where: { id: editorsOwn }, data: { ownerId: rep2 } })
    try {
      await expect(checkCollabMessage({ ...ctx }, ctx.checkedAt + 30_000)).resolves.toBeUndefined()   // not re-checked yet
      await expect(checkCollabMessage({ ...ctx }, ctx.checkedAt + 61_000)).rejects.toThrow('Access revoked')
    } finally {
      await prisma.contract.update({ where: { id: editorsOwn }, data: { ownerId: editor } })
    }

    await prisma.user.update({ where: { id: editor }, data: { status: 'DEACTIVATED' } })
    try {
      await expect(checkCollabMessage({ ...ctx }, ctx.checkedAt + 61_000)).rejects.toThrow('Access revoked')
    } finally {
      await prisma.user.update({ where: { id: editor }, data: { status: 'ACTIVE' } })
    }
    await expect(checkCollabMessage({ ...ctx }, ctx.checkedAt + 61_000)).resolves.toBeUndefined()
  })
})
