/**
 * X1 follow-up — the contract page enables its Original (PDF) view, and a
 * citation pill opens the cited page there, only when the latest version has
 * a stored file. It read that from GET /contracts/:id/versions, which never
 * returned the file's key: the view was disabled on every contract, and a
 * citation always fell back to the styled text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Versions List Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('GET /contracts/:id/versions', () => {
  it('says which versions have a stored file', async () => {
    const id = await makeContract(org, user, { title: 'Uploaded NDA' })
    const key = `${org}/contracts/${id}/original`
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: '<p>x</p>', plainText: 'x', createdById: user, mimeType: 'application/pdf', s3Key: key } })
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, htmlContent: '<p>y</p>', plainText: 'y', createdById: user, mimeType: 'text/html' } })

    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/versions`, headers: auth(org, ['LEGAL_OPS'], user) })
    expect(res.statusCode).toBe(200)
    const [latest, first] = res.json().data
    expect(latest).toMatchObject({ versionNumber: 2, mimeType: 'text/html', s3Key: null })
    expect(first).toMatchObject({ versionNumber: 1, mimeType: 'application/pdf', s3Key: key })
  })
})
