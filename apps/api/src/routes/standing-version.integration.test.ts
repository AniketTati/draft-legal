/**
 * DD4 — after "Undo" on an applied redline, the contract stands on the
 * version before it; the undone version stays, as the newest. The download
 * (and the page's PDF view, which uses it) served the newest: the undone
 * text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('DD4 Standing Version Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('the version a contract stands on', () => {
  it('is what the download serves after an undo', async () => {
    const id = await makeContract(org, user)
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, s3Key: `${org}/dd4/v1.pdf`, mimeType: 'application/pdf', plainText: 'one' } })
    await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: 2, createdById: user, renderedPdfKey: `${org}/dd4/v2-undone.pdf`, plainText: 'two', changeNote: 'redline_apply (moderate) (reverted via undo)' },
    })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })

    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/download`, headers: auth(org, ['ADMIN'], user) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().url).toContain('dd4/v1.pdf')
  })

  it('falls back only to a file at or before it', async () => {
    const id = await makeContract(org, user)
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, createdById: user, s3Key: `${org}/dd4b/v1.pdf`, mimeType: 'application/pdf', plainText: 'one' } })
    const v2 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, createdById: user, plainText: 'two, edited, not rendered yet' } })
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 3, createdById: user, renderedPdfKey: `${org}/dd4b/v3-undone.pdf`, plainText: 'three' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v2.id } })

    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/download`, headers: auth(org, ['ADMIN'], user) })
    expect(res.json().url).toContain('dd4b/v1.pdf')
  })
})
