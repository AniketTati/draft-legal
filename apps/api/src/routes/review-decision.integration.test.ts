/**
 * EE1 — the review drawer's Reject is a decision of its own. The API took
 * only unreviewed | reviewed | resolved, so the page stored a rejection as a
 * plain "reviewed", and nothing could tell a rejected clause from a read one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, user: string, clauseId: string

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('EE1 Review Decision Org')
  user = await makeUser(org)
  const contractId = await makeContract(org, user)
  const v1 = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: user, plainText: 'Liability is unlimited.' } })
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v1.id } })
  clauseId = (await prisma.contractClause.create({
    data: { versionId: v1.id, clauseType: 'limitation_of_liability', content: 'Liability is unlimited.', sortOrder: 0, riskRating: 'unfavorable' },
  })).id
})
afterAll(async () => { await cleanupAll(); await closeApp() })

const mark = (state: string) => app.inject({
  method: 'PATCH', url: `/api/v1/contracts/clauses/${clauseId}/review-state`, headers: auth(org, ['ADMIN'], user), payload: { state },
})

describe('a clause\'s review decision', () => {
  it('can be a rejection, kept as one', async () => {
    const res = await mark('rejected')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ reviewState: 'rejected', reviewedById: user })
    expect(await prisma.contractClause.findUnique({ where: { id: clauseId } })).toMatchObject({ reviewState: 'rejected', reviewedById: user })
  })

  it('can be reopened, which puts the clause back in the queue', async () => {
    expect((await mark('unreviewed')).json()).toMatchObject({ reviewState: 'unreviewed', reviewedById: null, reviewedAt: null })
  })

  it('refuses a state that is not one', async () => {
    const res = await mark('done')
    expect(res.statusCode).toBe(400)
    expect(res.json().detail).toContain('rejected')
  })
})
