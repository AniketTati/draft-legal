/**
 * Z7 — the clause review drawer shows the clause's own thread. Comments name
 * a clause as "Section 8.2 — Limitation of Liability"; extraction names it
 * "Section 8.2". The thread for a reference is the comments anchored to it,
 * alone or followed by a title.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, contract: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Z7 Clause Comments Org')
  user = await makeUser(org)
  contract = await makeContract(org, user, { title: 'Z7 commented contract' })
  for (const clauseRef of ['Section 8.2 — Limitation of Liability', 'Section 8.2', 'Section 8.21 — Caps', 'Section 8', null]) {
    await prisma.contractComment.create({ data: { orgId: org, contractId: contract, authorId: user, body: `on ${clauseRef}`, clauseRef } })
  }
})
afterAll(async () => {
  await prisma.contractComment.deleteMany({ where: { contractId: contract } })
  await cleanupAll(); await closeApp()
})

describe('a clause\'s comment thread', () => {
  it('holds the comments anchored to its reference, with or without a title, and no other section\'s', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/contracts/${contract}/comments?clauseRef=${encodeURIComponent('Section 8.2')}`, headers: auth(org, ['ADMIN'], user),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.map((c: { clauseRef: string }) => c.clauseRef).sort()).toEqual(['Section 8.2', 'Section 8.2 — Limitation of Liability'])
  })
})
