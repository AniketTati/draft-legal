/**
 * X18 — a signer's token is the whole credential for the public signing
 * routes (`POST /sign/:token/sign`). GET /contracts/:id/signature-requests
 * returned every signer row whole, so anyone who could view the contract —
 * a VIEWER, any org-scope role, a `contracts:read` API key — could sign as
 * the counterparty. Only a caller who may send for signature (and so needs to
 * re-share the link) gets tokens now; an internal signer still sees their own.
 * The link is also kept out of logs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, grantRole, prisma, type TestApp } from '../test-support/helpers.js'
import { hashApiKey } from '../middleware/auth.js'

let app: TestApp
let org: string, owner: string, viewer: string, contract: string, othersContract: string, token: string, viewerToken: string

async function requestWithSigners(contractId: string, createdById: string, signers: Array<{ email: string; name: string; token: string; userId?: string }>) {
  const v = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById, plainText: 'x' } })
  await prisma.signatureRequest.create({
    data: { orgId: org, contractId, versionId: v.id, createdById, signers: { create: signers } },
  })
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Signing Token Org')
  owner = await makeUser(org)
  viewer = await makeUser(org)
  await prisma.role.create({
    data: {
      orgId: org, name: 'OWN_SIGNER',
      permissions: [
        { action: 'view', resource: 'contract', scope: 'org' },
        { action: 'sign', resource: 'contract', scope: 'own' },
      ],
    },
  })
  contract = await makeContract(org, owner, { title: 'Token probe' })
  othersContract = await makeContract(org, viewer, { title: 'Someone else owns this' })
  token = `it-x18-${Date.now()}`
  viewerToken = `it-x18-viewer-${Date.now()}`
  const viewerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: viewer } })).email
  await requestWithSigners(contract, owner, [
    { email: 'counterparty@example.com', name: 'Counterparty', token },
    // An internal signer, typed with a different case than their account.
    { email: viewerEmail.toUpperCase(), name: 'Internal Viewer', token: viewerToken },
  ])
  await requestWithSigners(othersContract, viewer, [{ email: 'other@example.com', name: 'Other', token: `it-x18-other-${Date.now()}` }])
})

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

const list = (headers: Record<string, string>, id = contract) =>
  app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/signature-requests`, headers })
const tokensIn = (body: { data: Array<{ signers: Array<{ token?: string }> }> }) =>
  body.data.flatMap(r => r.signers.map(s => s.token)).filter(Boolean)

describe('signature request tokens', () => {
  it('a VIEWER sees who is signing and their status, but not the signing token', async () => {
    const res = await list(auth(org, ['VIEWER'], owner))
    expect(res.statusCode).toBe(200)
    const signer = res.json().data[0].signers.find((s: { email: string }) => s.email === 'counterparty@example.com')
    expect(signer).toMatchObject({ email: 'counterparty@example.com', status: 'PENDING' })
    expect(signer.token).toBeUndefined()
    expect(res.body).not.toContain(token)
  })

  it('an internal signer who can\'t send still gets their own link, and only theirs', async () => {
    const res = await list(auth(org, ['VIEWER'], viewer))
    expect(tokensIn(res.json())).toEqual([viewerToken])
  })

  it('a role that can send for signature still gets the links to re-share', async () => {
    const res = await list(auth(org, ['LEGAL_OPS'], owner))
    expect(tokensIn(res.json()).sort()).toEqual([token, viewerToken].sort())
  })

  it('own-scope signing covers only contracts the caller owns', async () => {
    expect(tokensIn((await list(auth(org, ['OWN_SIGNER'], owner))).json())).toHaveLength(2)
    expect(tokensIn((await list(auth(org, ['OWN_SIGNER'], owner), othersContract)).json())).toEqual([])
  })

  it('a contracts:read API key gets no tokens', async () => {
    const key = `clm_${randomBytes(24).toString('hex')}`
    const keyAdmin = await makeUser(org)
    await grantRole(org, keyAdmin, 'ADMIN')   // X46 — a key works while its maker can make keys
    await prisma.apiKey.create({
      data: { orgId: org, name: 'x18', keyHash: hashApiKey(key), prefix: key.slice(0, 8), scopes: ['contracts:read'], createdById: keyAdmin },
    })
    const res = await list({ authorization: `Bearer ${key}` })
    expect(res.statusCode).toBe(200)
    expect(tokensIn(res.json())).toEqual([])
  })

  it('the signing email\'s log line does not carry the link\'s token', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fresh = await makeContract(org, owner, { title: 'Log probe', status: 'APPROVED' })
    const v = await prisma.contractVersion.create({ data: { contractId: fresh, versionNumber: 1, createdById: owner, plainText: 'x' } })
    await prisma.contract.update({ where: { id: fresh }, data: { currentVersionId: v.id } })
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${fresh}/send-for-signature`, headers: auth(org, ['LEGAL_OPS'], owner),
      payload: { signers: [{ name: 'Log Probe', email: 'log-probe@example.com' }] },
    })
    expect(res.statusCode).toBe(201)
    const sent = res.json().signers[0].token as string
    const lines = info.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[signing]'))
    info.mockRestore()
    expect(lines.some(l => l.includes('log-probe@example.com') && l.includes('/sign/[REDACTED]'))).toBe(true)
    expect(lines.join('\n')).not.toContain(sent)
  })
})
