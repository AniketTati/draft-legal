/**
 * X47 — opening a contract in the web app saved a new "Edited in-place"
 * version: the editor reported its mount as an edit, and
 * POST /contracts/:id/html-version made a version of whatever it was sent.
 * Each view moved the current version off the uploaded PDF, rendered a PDF
 * and, since X42, would send an approved contract back to DRAFT. A save that
 * changes nothing now makes nothing; a real edit still counts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/gotenberg.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/gotenberg.js')>()),
  renderHtmlToPdfAndStore: vi.fn(async () => ({ s3Key: 'rendered/test.pdf' })),
}))

import { renderHtmlToPdfAndStore } from '../lib/gotenberg.js'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Html Version Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

/** An approved contract whose only version is an uploaded PDF, with the HTML the extractor wrote. */
async function approvedUpload(html: string) {
  const id = await makeContract(org, user, { title: 'Approved NDA', status: 'APPROVED' })
  const v = await prisma.contractVersion.create({
    data: { contractId: id, versionNumber: 1, htmlContent: html, plainText: 'x', createdById: user, mimeType: 'application/pdf', s3Key: `${org}/contracts/${id}/original` },
  })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return { id, versionId: v.id }
}

const save = (id: string, htmlContent: string) => app.inject({
  method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: auth(org, ['LEGAL_OPS'], user),
  payload: { htmlContent, changeNote: 'Edited in-place' },
})

describe('saving a contract\'s HTML', () => {
  it('the same document, as the editor re-serializes it, makes no version and keeps the approval', async () => {
    const { id, versionId } = await approvedUpload('<h1>Globex — Mutual NDA</h1>\n<p>MUTUAL NON-DISCLOSURE AGREEMENT</p>\n')
    vi.mocked(renderHtmlToPdfAndStore).mockClear()
    const res = await save(id, '<h1>Globex — Mutual NDA</h1><p>MUTUAL NON-DISCLOSURE AGREEMENT</p>')
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(versionId)
    const after = await prisma.contract.findUniqueOrThrow({
      where: { id }, select: { status: true, currentVersionId: true, _count: { select: { versions: true } } },
    })
    expect(after).toEqual({ status: 'APPROVED', currentVersionId: versionId, _count: { versions: 1 } })
    expect(renderHtmlToPdfAndStore).not.toHaveBeenCalled()
    expect(await prisma.auditEvent.count({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })).toBe(0)
  })

  it('a real edit, down to one space, still makes a version and returns an approved contract to DRAFT (X42)', async () => {
    const { id } = await approvedUpload('<p><strong>Acme</strong> <em>Corp</em> agrees.</p>')
    const res = await save(id, '<p><strong>Acme</strong><em>Corp</em> agrees.</p>')
    expect(res.statusCode).toBe(201)
    const after = await prisma.contract.findUniqueOrThrow({ where: { id }, select: { status: true, currentVersionId: true } })
    expect(after).toEqual({ status: 'DRAFT', currentVersionId: res.json().id })
    // X47 follow-up — the edit, and the approval it undid, are on the record.
    // Part 16 (C1) also records how the version was made and its note.
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })
    expect(audit.userId).toBe(user)
    expect(audit.metadata).toEqual({ action: 'document_edited', versionNumber: 2, statusFrom: 'APPROVED', statusTo: 'DRAFT', via: 'editor', changeNote: 'Edited in-place' })
  })

  it('an edit to a draft records no status change it did not make', async () => {
    const id = await makeContract(org, user, { title: 'Draft NDA', status: 'DRAFT' })
    const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: '<p>Old</p>', plainText: 'Old', createdById: user } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
    expect((await save(id, '<p>New</p>')).statusCode).toBe(201)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { orgId: org, resourceId: id, action: 'CONTRACT_UPDATED' } })
    expect(audit.metadata).toEqual({ action: 'document_edited', versionNumber: 2, via: 'editor', changeNote: 'Edited in-place' })
  })

  it('is judged against the version the contract stands on: after an undo, saving the latest again is a change', async () => {
    const id = await makeContract(org, user, { title: 'Redlined NDA', status: 'DRAFT' })
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: '<p>Before</p>', plainText: 'Before', createdById: user } })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, htmlContent: '<p>After</p>', plainText: 'After', createdById: user } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })   // an undo put it back on v1

    const again = await save(id, '<p>After</p>')
    expect(again.statusCode).toBe(201)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id } })).currentVersionId).toBe(again.json().id)

    const same = await save(id, '<p>After</p>')
    expect(same.statusCode).toBe(200)
    expect(same.json().id).toBe(again.json().id)
    expect(v2.id).not.toBe(again.json().id)
  })

  // X67 — the stored text read every tag as a space, so an SSN whose last
  // group was bolded was stored as `219-09- 9999`, which the PII patterns
  // don't match, and reached models raw from there.
  it('stores the text as it reads: inline markup doesn\'t split a value', async () => {
    const id = await makeContract(org, user, { title: 'Employment agreement', status: 'DRAFT' })
    const res = await save(id, '<p>Employee SSN 219-09-<strong>9999</strong>.</p><p>Paid monthly.</p>')
    expect(res.statusCode).toBe(201)
    const { plainText } = await prisma.contractVersion.findUniqueOrThrow({ where: { id: res.json().id } })
    expect(plainText).toBe('Employee SSN 219-09-9999.\nPaid monthly.')
  })
})
