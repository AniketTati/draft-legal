/**
 * X28 — in a SEQUENTIAL signature request, only signing checked the signer's
 * turn. A later signer's link could view the contract, and decline (which
 * voids the whole request), before the first signer had acted.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Completing a request queues the PDF seal; the tests don't need the job.
vi.mock('../lib/queue.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  queueSealSignedPdf: vi.fn(),
}))

import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, sr: string, user: string
const first = `it-x28-first-${Date.now()}`
const second = `it-x28-second-${Date.now()}`

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Signing Turn Org')
  user = await makeUser(org)
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
  await prisma.signatureEvent.deleteMany({ where: { signatureRequest: { orgId: org } } })
  await prisma.signer.deleteMany({ where: { signatureRequest: { orgId: org } } })
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

describe('X28 follow-up — expiry and racing state changes', () => {
  /** A request of its own, on a contract of its own. */
  async function request(signers: Array<{ token: string; order: number }>, extra: { signOrder?: string; expiresAt?: Date } = {}) {
    const contract = await makeContract(org, user, { title: 'Signing race' })
    const v = await prisma.contractVersion.create({ data: { contractId: contract, versionNumber: 1, createdById: user, plainText: 'Terms', htmlContent: '<p>Terms</p>' } })
    return (await prisma.signatureRequest.create({
      data: {
        orgId: org, contractId: contract, versionId: v.id, createdById: user, signOrder: extra.signOrder ?? 'ANY', expiresAt: extra.expiresAt,
        signers: { create: signers.map(sg => ({ email: `${sg.token}@cp.test`, name: sg.token, signOrder: sg.order, token: sg.token })) },
      },
    })).id
  }
  const tok = (name: string) => `it-x28-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  it('an expired link can neither sign nor decline, and the request is marked EXPIRED', async () => {
    const past = new Date(Date.now() - 60_000)
    const signTok = tok('late-sign')
    const signReq = await request([{ token: signTok, order: 1 }], { expiresAt: past })
    const signed = await app.inject({ method: 'POST', url: `/api/v1/sign/${signTok}/sign`, payload: { signedName: 'Late', consent: true } })
    expect(signed.statusCode).toBe(410)
    expect((await prisma.signatureRequest.findUniqueOrThrow({ where: { id: signReq } })).status).toBe('EXPIRED')
    expect((await prisma.signer.findUniqueOrThrow({ where: { token: signTok } })).status).toBe('PENDING')

    const declineTok = tok('late-decline')
    const declineReq = await request([{ token: declineTok, order: 1 }], { expiresAt: past })
    const declined = await app.inject({ method: 'POST', url: `/api/v1/sign/${declineTok}/decline`, payload: { reason: 'late' } })
    expect(declined.statusCode).toBe(410)
    expect((await prisma.signatureRequest.findUniqueOrThrow({ where: { id: declineReq } })).status).toBe('EXPIRED')
  })

  it('two final signatures at the same moment complete the request once', async () => {
    const [a, b] = [tok('a'), tok('b')]
    const id = await request([{ token: a, order: 1 }, { token: b, order: 1 }])
    const results = await Promise.all([a, b].map(t => app.inject({ method: 'POST', url: `/api/v1/sign/${t}/sign`, payload: { signedName: 'Signer', consent: true } })))
    expect(results.map(r => r.statusCode)).toEqual([200, 200])
    expect((await prisma.signatureRequest.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED')
    expect(await prisma.signatureEvent.count({ where: { signatureRequestId: id, kind: 'COMPLETED' } })).toBe(1)
  })

  // X65 — the void wins, as it should, but the sign call answered 200 with
  // allSigned: true, so the signer and any API client were told the request
  // was fully signed.
  it('a void landing just after the last signature wins, and the sign call says so', async () => {
    const last = tok('last')
    const id = await request([{ token: last, order: 1 }])
    // The void lands after the signature, just before the transaction that
    // would complete the request (the sign call's first transaction).
    const transaction = prisma.$transaction.bind(prisma)
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
      await prisma.signatureRequest.update({ where: { id }, data: { status: 'VOIDED', voidedAt: new Date(), voidedReason: 'Voided by sender' } })
      return transaction(...args)
    }) as never)
    const res = await app.inject({ method: 'POST', url: `/api/v1/sign/${last}/sign`, payload: { signedName: 'Last', consent: true } })
    spy.mockRestore()
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toBe('This signing request changed meanwhile. Reload the page.')
    const stored = await prisma.signatureRequest.findUniqueOrThrow({ where: { id } })
    expect(stored.status).toBe('VOIDED')
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: stored.contractId } })).status).not.toBe('EXECUTED')
    expect(await prisma.signatureEvent.count({ where: { signatureRequestId: id, kind: 'COMPLETED' } })).toBe(0)
  })
})
