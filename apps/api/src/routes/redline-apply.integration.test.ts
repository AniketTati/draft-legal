/**
 * C9 — applying a redline variant. The apply route accepts one vocabulary,
 * least | moderate | aggressive (what redline_propose returns and the UI
 * labels). The agent's redline_apply tool told the model 'conservative',
 * which this route rejects — so the model's applies 400'd.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string
const ORIGINAL = "The Supplier's aggregate liability is unlimited."

async function contractWithClause(title: string) {
  const contractId = await makeContract(org, owner, { title, status: 'UNDER_NEGOTIATION' })
  const v = await prisma.contractVersion.create({
    data: { contractId, versionNumber: 1, createdById: owner, htmlContent: `<p>${ORIGINAL}</p>`, plainText: ORIGINAL },
  })
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
  const clause = await prisma.contractClause.create({
    data: { versionId: v.id, clauseType: 'limitation_of_liability', content: ORIGINAL },
  })
  return { contractId, clauseId: clause.id }
}

async function apply(contractId: string, clauseId: string, aggression: string, proposedText: string) {
  return app.inject({
    method: 'POST', url: '/api/internal/ai/tools/redline_apply',
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, userId: owner, contractId, clauseId, proposedText, aggression },
  })
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Redline Apply Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  const versions = await prisma.contractVersion.findMany({ where: { contract: { orgId: org } }, select: { id: true } })
  await prisma.contractClause.deleteMany({ where: { versionId: { in: versions.map(v => v.id) } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('redline_apply variants', () => {
  const VARIANTS: Array<[string, string]> = [
    ['least',      "The Supplier's aggregate liability is capped at 24 months of fees."],
    ['moderate',   "The Supplier's aggregate liability is capped at 12 months of fees."],
    ['aggressive', "The Supplier's aggregate liability is capped at 3 months of fees."],
  ]

  it.each(VARIANTS)('applies the %s variant as a new version', async (aggression, proposedText) => {
    const { contractId, clauseId } = await contractWithClause(`Apply ${aggression}`)
    const res = await apply(contractId, clauseId, aggression, proposedText)
    expect(res.statusCode).toBe(200)

    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { currentVersionId: true } })
    const v = await prisma.contractVersion.findUnique({ where: { id: contract!.currentVersionId! } })
    expect(v?.versionNumber).toBe(2)
    expect(v?.htmlContent).toContain(proposedText)
    expect((v?.metadata as { redline?: { aggression?: string } }).redline?.aggression).toBe(aggression)
  })

  it("refuses the word the agent tool used to send ('conservative')", async () => {
    const { contractId, clauseId } = await contractWithClause('Apply conservative')
    const res = await apply(contractId, clauseId, 'conservative', VARIANTS[0][1])
    expect(res.statusCode).toBe(400)
  })
})
