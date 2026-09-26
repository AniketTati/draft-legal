/**
 * X32 — the version diff runs on a worker thread with a time limit (see
 * lib/diff.test.ts). A pair that runs past it is refused with a 422 that says
 * why: the review UI, the agents service's redline analysis (which records
 * the reason) and the DOCX export all read it, and nothing is cached.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../lib/diff.js', async importOriginal => {
  const real = await importOriginal<typeof import('../lib/diff.js')>()
  const tooLarge = async () => { throw new real.DiffTooLargeError() }
  return { ...real, computeVersionDiff: vi.fn(tooLarge), htmlDiff: vi.fn(tooLarge) }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, contract: string, v1: string, v2: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Diff Limit Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Very long agreement' })
  const version = async (n: number, text: string) => (await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: n, createdById: owner, plainText: text, htmlContent: `<p>${text}</p>` },
  })).id
  v1 = await version(1, 'Liability is capped at twelve months of fees.')
  v2 = await version(2, 'Liability is capped at three months of fees.')
})

afterAll(async () => {
  await prisma.versionDiffCache.deleteMany({ where: { contractId: contract } })
  await cleanupAll()
  await closeApp()
})

describe('a diff past its time limit', () => {
  it('is a 422 that says why, for users, the agents service and the DOCX export, and is not cached', async () => {
    const url = `/api/v1/contracts/${contract}/versions/${v1}/diff/${v2}`
    const forUser = await app.inject({ method: 'GET', url, headers: auth(org, ['ADMIN'], owner) })
    expect(forUser.statusCode).toBe(422)
    expect(forUser.json().detail).toMatch(/too large to compare/)
    expect(await prisma.versionDiffCache.count({ where: { contractId: contract } })).toBe(0)

    const forAgents = await app.inject({
      method: 'GET', url,
      headers: { 'x-internal-service': 'agents', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string, 'x-org-id': org },
    })
    expect(forAgents.statusCode).toBe(422)

    const docx = await app.inject({ method: 'GET', url: `/api/v1/contracts/${contract}/versions/${v1}/redline-docx/${v2}`, headers: auth(org, ['ADMIN'], owner) })
    expect(docx.statusCode).toBe(422)
    expect(docx.json().detail).toMatch(/too large to compare/)
  })
})
