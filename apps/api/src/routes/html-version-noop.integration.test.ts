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
  })

  it('a real edit, down to one space, still makes a version and returns an approved contract to DRAFT (X42)', async () => {
    const { id } = await approvedUpload('<p><strong>Acme</strong> <em>Corp</em> agrees.</p>')
    const res = await save(id, '<p><strong>Acme</strong><em>Corp</em> agrees.</p>')
    expect(res.statusCode).toBe(201)
    const after = await prisma.contract.findUniqueOrThrow({ where: { id }, select: { status: true, currentVersionId: true } })
    expect(after).toEqual({ status: 'DRAFT', currentVersionId: res.json().id })
  })
})
