/**
 * The counterparty uploads a revised version through their link. Until the
 * parse job reads it, that version has no text, and the page said the other
 * side "has not uploaded a version for you to read". The page now shows the
 * last version with text and says the new one is being processed; the
 * download gives the same version.
 *
 * Also: analysing a later version (their return) renamed the contract after
 * their document. Title, type and counterparty stay as they were.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { signPortalToken } from './share.js'

let app: TestApp
let org: string, contract: string, portalToken: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Portal Pending Org')
  const owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Our title for the deal', status: 'UNDER_NEGOTIATION' })
  await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, htmlContent: '<p>The version we sent.</p>', plainText: 'The version we sent.', createdById: owner } })
  await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 2, htmlContent: '', plainText: '', createdById: `portal:test` } })
  const token = randomBytes(32).toString('hex')
  await prisma.contractShareLink.create({
    data: { orgId: org, contractId: contract, token, permissions: ['read', 'upload'], expiresAt: new Date(Date.now() + 3600_000), createdById: owner },
  })
  portalToken = signPortalToken({ token, contractId: contract, orgId: org, permissions: ['read', 'upload'] }, 3600)
})

afterAll(async () => { await cleanupAll(); await closeApp() })

describe('a counterparty version still being read', () => {
  it('shows the last version with text, says the new one is being processed, and downloads what it shows', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/${portalToken}/contract` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      htmlContent: '<p>The version we sent.</p>',
      versionNumber: 1,
      pending: { versionNumber: 2, failed: false },
    })
    const download = await app.inject({ method: 'GET', url: `/api/v1/portal/${portalToken}/download/docx` })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain('-v1.docx')
  })

  it('reports nothing pending once the version has been read', async () => {
    await prisma.contractVersion.updateMany({ where: { contractId: contract, versionNumber: 2 }, data: { htmlContent: '<p>Their return.</p>' } })
    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/${portalToken}/contract` })
    expect(res.json()).toMatchObject({ htmlContent: '<p>Their return.</p>', versionNumber: 2, pending: null })
  })
})

describe('analysing a later version', () => {
  it('leaves the title, type and counterparty the contract already has', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/contracts/${contract}`,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '', 'x-internal-service': 'agents', 'x-org-id': org },
      payload: { title: '[Company Name] - Their Title', type: 'OTHER', summary: 'Their return, analysed.' },
    })
    expect(res.statusCode, res.body).toBe(200)
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract } })
    expect(after).toMatchObject({ title: 'Our title for the deal', type: 'NDA', summary: 'Their return, analysed.' })
    // A person can still rename it.
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/contracts/${contract}`, headers: auth(org, ['ADMIN']), payload: { title: 'Renamed by a person' } })
    expect(renamed.statusCode).toBe(200)
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract } })).title).toBe('Renamed by a person')
  })
})

describe('DD4 — after an undo', () => {
  it('shows and downloads the version the contract stands on, not the undone internal redline', async () => {
    const owner = await makeUser(org)
    const id = await makeContract(org, owner, { title: 'DD4 portal', status: 'UNDER_NEGOTIATION' })
    const v1 = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: '<p>What we sent.</p>', plainText: 'What we sent.', createdById: owner } })
    await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 2, htmlContent: '<p>An internal redline, undone.</p>', plainText: 'An internal redline, undone.', createdById: owner, changeNote: 'redline_apply (moderate) (reverted via undo)' } })
    await prisma.contract.update({ where: { id }, data: { currentVersionId: v1.id } })
    const token = randomBytes(32).toString('hex')
    await prisma.contractShareLink.create({ data: { orgId: org, contractId: id, token, permissions: ['read'], expiresAt: new Date(Date.now() + 3600_000), createdById: owner } })
    const portal = signPortalToken({ token, contractId: id, orgId: org, permissions: ['read'] }, 3600)

    const res = await app.inject({ method: 'GET', url: `/api/v1/portal/${portal}/contract` })
    expect(res.json()).toMatchObject({ htmlContent: '<p>What we sent.</p>', versionNumber: 1, pending: null })
    const download = await app.inject({ method: 'GET', url: `/api/v1/portal/${portal}/download/docx` })
    expect(download.headers['content-disposition']).toContain('-v1.docx')
  })
})
