/**
 * docs/41 browser QA (a1b300f) — an amendment carries its agreement's type,
 * but the agreement's clauses still govern: it isn't told that the type's
 * required clauses are missing from it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { computeAndStoreFindings } from './review-findings.js'
import { closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'

let org: string, user: string

beforeAll(async () => {
  org = await makeOrg('Findings Family Org')
  user = await makeUser(org)
  await prisma.clauseCategory.create({ data: { orgId: org, name: 'Term & Termination', presence: 'required', presenceContractTypes: ['MSA'] } })
  await prisma.clauseCategory.create({ data: { orgId: org, name: 'Limitation of Liability', presence: 'required', presenceContractTypes: ['MSA'] } })
})

afterAll(async () => {
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null, parentContractId: null } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

const AMEND = 'The Contract value is amended to read: USD 300,000.'

async function oneClause(over: { parentContractId?: string; relationshipType?: string } = {}) {
  const id = await makeContract(org, user, { title: 'Amendment No. 1', type: 'MSA', status: 'DRAFT' })
  if (over.parentContractId) await prisma.contract.update({ where: { id }, data: over })
  const v = await prisma.contractVersion.create({ data: { contractId: id, versionNumber: 1, htmlContent: `<p>${AMEND}</p>`, plainText: AMEND, createdById: user } })
  await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'general', content: AMEND, sortOrder: 0 } })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  return { id, versionId: v.id }
}

describe('required clauses on an amendment', () => {
  it('are not "not detected" on an amendment to an MSA; a standalone MSA with the same text is told', async () => {
    const parent = await makeContract(org, user, { title: 'Acme MSA', type: 'MSA', status: 'EXECUTED' })
    const amendment = await oneClause({ parentContractId: parent, relationshipType: 'amendment' })
    await computeAndStoreFindings(amendment.id, amendment.versionId)
    expect(await prisma.reviewFinding.count({ where: { versionId: amendment.versionId, kind: 'missing_required' } })).toBe(0)

    const standalone = await oneClause()
    await computeAndStoreFindings(standalone.id, standalone.versionId)
    const missing = await prisma.reviewFinding.findMany({ where: { versionId: standalone.versionId, kind: 'missing_required' }, select: { title: true } })
    expect(missing.map(f => f.title).sort()).toEqual(['Limitation of Liability — not detected', 'Term & Termination — not detected'])
  })
})
