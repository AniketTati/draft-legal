/**
 * docs/41 Part 16 (C1) — typing autosaves to a working copy, and a version is
 * made only with a note, on submit, on send or after inactivity. These run the
 * routes against the database: the conflict a second editor gets, the one
 * version a save makes (through the same edit path as every other version),
 * the moments that save on their own, and that another org can't reach any
 * of it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/gotenberg.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/gotenberg.js')>()),
  renderHtmlToPdfAndStore: vi.fn(async () => ({ s3Key: 'rendered/test.pdf' })),
}))
// The edit pipeline's follow-up (clause carry, analysis checkpoint) is
// watched, not run: what matters here is that a working-copy version goes
// through it like any other edit.
vi.mock('../lib/version-refresh.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/version-refresh.js')>()),
  afterEdit: vi.fn(async () => null),
}))

import { afterEdit } from '../lib/version-refresh.js'
import { AUTO_NOTES, idleJobId, runIdleCheckpoint } from '../lib/working-copy.js'
import { agentQueue } from '../lib/queue.js'
import { getApp, closeApp, makeOrg, makeUser, makeContract, makeWorkflow, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, other: string
let otherOrg: string, outsider: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Working Copy Org')
  user = await makeUser(org)
  other = await makeUser(org)
  await prisma.user.update({ where: { id: other }, data: { name: 'Priya Shah' } })
  otherOrg = await makeOrg('Working Copy Other Org')
  outsider = await makeUser(otherOrg)
})

afterAll(async () => {
  const contracts = await prisma.contract.findMany({ where: { orgId: org }, select: { id: true } })
  for (const c of contracts) await agentQueue.getJob(idleJobId(c.id)).then(j => j?.remove()).catch(() => {})
  await prisma.approvalStep.deleteMany({ where: { orgId: org } })
  await prisma.approvalInstance.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

/** A draft contract standing on v1. */
async function draft(title = 'Working copy NDA', html = '<p>The term is one year.</p>') {
  const id = await makeContract(org, user, { title, status: 'DRAFT' })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: html, plainText: 'x', createdById: user } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return { id, v1: v.id }
}

const as = (sub: string, roles = ['LEGAL_OPS'], o = org) => auth(o, roles, sub)
const put = (id: string, html: string, revision: number, sub = user, o = org) => app.inject({
  method: 'PUT', url: `/api/v1/contracts/${id}/working-copy`, headers: as(sub, ['LEGAL_OPS'], o), payload: { html, revision },
})
const get = (id: string, sub = user, o = org) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/working-copy`, headers: as(sub, ['LEGAL_OPS'], o) })
const saveVersion = (id: string, payload: Record<string, unknown>, headers = as(user)) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${id}/versions/from-working-copy`, headers, payload,
})
const versionCount = (id: string) => prisma.contractVersion.count({ where: { contractId: id } })

describe('autosaving the working copy', () => {
  it('saves, reads back, and refuses a save made on an older revision with who saved since', async () => {
    const { id, v1 } = await draft()
    expect((await get(id)).json()).toEqual({ workingCopy: null })

    const first = await put(id, '<p>The term is two years.</p>', 0)
    expect(first.statusCode).toBe(200)
    expect(first.json().workingCopy).toMatchObject({ revision: 1, baseVersionId: v1, baseVersionNumber: 1, stale: false })

    // Priya saves on revision 1 too, and lands first.
    const theirs = await put(id, '<p>The term is three years.</p>', 1, other)
    expect(theirs.statusCode).toBe(200)
    expect(theirs.json().workingCopy.revision).toBe(2)

    const mine = await put(id, '<p>The term is two years and a day.</p>', 1)
    expect(mine.statusCode).toBe(409)
    expect(mine.json()).toMatchObject({
      code: 'WORKING_COPY_CONFLICT',
      detail: expect.stringContaining('Priya Shah'),
      current: { revision: 2, updatedBy: { id: other, name: 'Priya Shah' } },
    })

    const read = (await get(id)).json().workingCopy
    expect(read).toMatchObject({ html: '<p>The term is three years.</p>', revision: 2, updatedBy: { name: 'Priya Shah' } })
    // Typing makes no versions.
    expect(await versionCount(id)).toBe(1)
  })

  it('discards the draft changes', async () => {
    const { id } = await draft()
    await put(id, '<p>Changed.</p>', 0)
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/contracts/${id}/working-copy`, headers: as(user) })
    expect(res.json()).toEqual({ discarded: true })
    expect((await get(id)).json().workingCopy).toBeNull()
    // Gone means a save still holding revision 1 is told so.
    expect((await put(id, '<p>Again.</p>', 1)).statusCode).toBe(409)
  })
})

describe('Save as version', () => {
  it('needs a note', async () => {
    const { id } = await draft()
    await put(id, '<p>The term is two years.</p>', 0)
    for (const note of [undefined, '', 'ok']) {
      const res = await saveVersion(id, { note })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('NOTE_REQUIRED')
    }
    expect(await versionCount(id)).toBe(1)
  })

  it('makes exactly one version, through the edit pipeline, and clears the draft changes', async () => {
    const { id, v1 } = await draft()
    await put(id, '<p>The term is two years.</p>', 0)
    vi.mocked(afterEdit).mockClear()

    const res = await saveVersion(id, { note: 'Term extended to two years' })
    expect(res.statusCode).toBe(201)
    const { version, created, approvals } = res.json()
    expect({ versionNumber: version.versionNumber, created, approvals }).toEqual({ versionNumber: 2, created: true, approvals: 'rules' })

    expect(await versionCount(id)).toBe(2)
    const saved = await prisma.contractVersion.findUniqueOrThrow({ where: { id: version.id } })
    expect(saved).toMatchObject({ htmlContent: '<p>The term is two years.</p>', changeNote: 'Term extended to two years', createdById: user })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId).toBe(version.id)
    expect(afterEdit).toHaveBeenCalledTimes(1)
    expect(afterEdit).toHaveBeenCalledWith(expect.objectContaining({ contractId: id, versionId: version.id, fromVersionId: v1 }))
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })
    expect(audit.metadata).toMatchObject({ action: 'document_edited', versionNumber: 2, via: 'working_copy' })

    expect((await get(id)).json().workingCopy).toBeNull()
    expect(await agentQueue.getJob(idleJobId(id))).toBeFalsy()
    // Nothing left to save.
    expect((await saveVersion(id, { note: 'Again please' })).json().code).toBe('NO_WORKING_COPY')
  })

  it('sending to the counterparty hands them the turn', async () => {
    const { id } = await draft()
    await put(id, '<p>The term is two years.</p>', 0)
    const res = await saveVersion(id, { note: 'Our counter on the term', sendToCounterparty: { method: 'pdf' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().send).toMatchObject({ method: 'pdf', ok: true })
    expect(res.json().contract).toMatchObject({ stage: 'negotiate', stageState: 'with_counterparty', turn: 'counterparty' })
    expect(await prisma.auditEvent.count({ where: { orgId: org, resourceId: id, action: 'STAGE_CHANGED' } })).toBe(1)
  })

  it('"Reset approvals" counts only from someone who configures workflows', async () => {
    const { id } = await draft()
    await put(id, '<p>The term is two years.</p>', 0)
    const manager = await saveVersion(id, { note: 'Term extended', resetApprovals: true }, as(user, ['CONTRACT_MANAGER']))
    expect(manager.statusCode).toBe(201)
    expect(manager.json().approvals).toBe('rules')
    const meta = (await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })).metadata as Record<string, unknown>
    expect(meta.approvals).toBeUndefined()

    await put(id, '<p>The term is three years.</p>', 0)
    const ops = await saveVersion(id, { note: 'Term extended again', resetApprovals: true }, as(user, ['LEGAL_OPS']))
    expect(ops.statusCode).toBe(201)
    expect(ops.json().approvals).toBe('reset_all')
  })
})

describe('draft changes saved on their own', () => {
  it('submitting for approval saves pending draft changes as the version submitted', async () => {
    const { id } = await draft('Submit NDA')
    await put(id, '<p>The term is two years.</p>', 0)
    const approver = await makeUser(org)
    const workflowDefinitionId = await makeWorkflow(org, user, approver)
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/submit-approval`, headers: as(user, ['ADMIN']), payload: { workflowDefinitionId },
    })
    expect(res.statusCode).toBe(201)
    expect(await versionCount(id)).toBe(2)
    const v2 = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: id, versionNumber: 2 } })
    expect(v2).toMatchObject({ htmlContent: '<p>The term is two years.</p>', changeNote: AUTO_NOTES.submit })
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId).toBe(v2.id)
    expect((await get(id)).json().workingCopy).toBeNull()
  })

  it('the idle checkpoint makes a version of draft changes left alone, and not of newer ones', async () => {
    const { id } = await draft('Idle NDA')
    await put(id, '<p>The term is two years.</p>', 0)
    const job = await agentQueue.getJob(idleJobId(id))
    expect(job?.name).toBe('working-copy-idle')
    expect(job?.data).toEqual({ orgId: org, contractId: id, revision: 1 })

    // Saved again before it fired: the old job leaves the newer save alone.
    await put(id, '<p>The term is three years.</p>', 1)
    expect(await runIdleCheckpoint({ orgId: org, contractId: id, revision: 1 })).toBe('saved again since')
    expect(await versionCount(id)).toBe(1)

    expect(await runIdleCheckpoint({ orgId: org, contractId: id, revision: 2 })).toBe('saved as v2')
    const v2 = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: id, versionNumber: 2 } })
    expect(v2).toMatchObject({ htmlContent: '<p>The term is three years.</p>', changeNote: AUTO_NOTES.idle, createdById: user })
    expect((await get(id)).json().workingCopy).toBeNull()
  })
})

describe('tenant isolation', () => {
  it('another org can\'t read, save, discard or version this contract\'s draft changes', async () => {
    const { id } = await draft('Isolated NDA')
    await put(id, '<p>Secret change.</p>', 0)
    const headers = as(outsider, ['ADMIN'], otherOrg)
    expect((await get(id, outsider, otherOrg)).statusCode).toBe(404)
    expect((await put(id, '<p>Theirs.</p>', 1, outsider, otherOrg)).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/contracts/${id}/working-copy`, headers })).statusCode).toBe(404)
    expect((await saveVersion(id, { note: 'Not yours' }, headers)).statusCode).toBe(404)
    expect((await get(id)).json().workingCopy).toMatchObject({ html: '<p>Secret change.</p>', revision: 1 })
    expect(await versionCount(id)).toBe(1)
  })
})
