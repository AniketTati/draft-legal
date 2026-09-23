/**
 * X28 — in a SEQUENTIAL signature request, only signing checked the signer's
 * turn. A later signer's link could view the contract, and decline (which
 * voids the whole request), before the first signer had acted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, sr: string
const first = `it-x28-first-${Date.now()}`
const second = `it-x28-second-${Date.now()}`

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Signing Turn Org')
  const user = await makeUser(org)
  const contract = await makeContract(org, user, { title: 'Sequential NDA' })
  const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: user, plainText: 'CONFIDENTIAL TERMS', htmlContent: '<p>CONFIDENTIAL TERMS</p>' } })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
  sr = (await prisma.signatureRequest.create({
    data: { orgId: org, contractId: contract, versionId: v.id, createdById: user, signOrder: 'SEQUENTIAL',
      signers: { create: [
        { email: 'first@cp.test', name: 'First', signOrder: 1, token: first },
        { email: 'second@cp.test', name: 'Second', signOrder: 2, token: second },
      ] } },
  })).id
})

afterAll(async () => {
  await prisma.signatureEvent.deleteMany({ where: { signatureRequestId: sr } })
  await prisma.signer.deleteMany({ where: { signatureRequestId: sr } })
  await prisma.signatureRequest.deleteMany({ where: { orgId: org } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('a later sequential signer before their turn', () => {
  it('cannot read the contract or void the request; after the earlier signer, can', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/v1/sign/${second}` })
    expect(view.statusCode).toBe(403)
    expect(view.body).not.toContain('CONFIDENTIAL TERMS')

    const decline = await app.inject({ method: 'POST', url: `/api/v1/sign/${second}/decline`, payload: { reason: 'early' } })
    expect(decline.statusCode).toBe(403)
    expect((await prisma.signatureRequest.findUniqueOrThrow({ where: { id: sr } })).status).toBe('PENDING')

    expect((await app.inject({ method: 'GET', url: `/api/v1/sign/${first}` })).statusCode).toBe(200)
    await prisma.signer.updateMany({ where: { token: first }, data: { status: 'SIGNED', signedAt: new Date() } })
    const now = await app.inject({ method: 'GET', url: `/api/v1/sign/${second}` })
    expect(now.statusCode).toBe(200)
    expect(now.body).toContain('CONFIDENTIAL TERMS')
  })
})
