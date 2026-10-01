/**
 * docs/39 E2 — re-analysis replaces only the AI's own clause rows: a clause a
 * person tagged survives (and the AI's copy of it is left out), and a clause
 * whose words are unchanged keeps its review.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma } from '../test-support/helpers.js'
import { storeClauseSegments, sameClauseText, coversClause } from './embeddings.js'

let org: string, owner: string

beforeAll(async () => {
  await getApp()
  org = await makeOrg('Clause Source Org')
  owner = await makeUser(org)
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

const LIABILITY = 'Neither party shall be liable for indirect, incidental or consequential damages, and each party’s total liability shall not exceed the fees paid in the twelve months before the claim.'
const NON_SOLICIT = 'During the term and for twelve (12) months after, neither party shall solicit for employment any employee of the other party who worked on the services.'

describe('clause text matching', () => {
  it('ignores case, spacing and punctuation, and nothing else', () => {
    expect(sameClauseText(LIABILITY, LIABILITY.toUpperCase().replace(/,/g, ''))).toBe(true)
    expect(sameClauseText(LIABILITY, LIABILITY.replace('twelve', 'six'))).toBe(false)
    expect(coversClause(NON_SOLICIT, `12.4 Non-solicitation. ${NON_SOLICIT}`)).toBe(true)
    expect(coversClause(NON_SOLICIT, LIABILITY)).toBe(false)
  })
})

describe('storeClauseSegments', () => {
  it('keeps a tagged clause and an unchanged clause\'s review, and replaces the rest', async () => {
    const contractId = await makeContract(org, owner)
    const version = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: owner } })
    await prisma.contractClause.createMany({ data: [
      { versionId: version.id, clauseType: 'limitation_of_liability', content: LIABILITY, sortOrder: 0, reviewState: 'reviewed', reviewedAt: new Date(), reviewedById: owner },
      { versionId: version.id, clauseType: 'payment', content: 'Fees are payable within thirty days of invoice.', sortOrder: 1 },
      { versionId: version.id, clauseType: 'non_solicitation', content: NON_SOLICIT, sortOrder: 2, source: 'user' },
    ] })

    await storeClauseSegments(version.id, [
      { clauseType: 'limitation_of_liability', content: LIABILITY.replace(/\s+/g, ' '), sortOrder: 0 },
      { clauseType: 'termination', content: 'Either party may terminate for convenience on sixty days notice.', sortOrder: 1 },
      { clauseType: 'non_solicitation', content: `Non-solicitation. ${NON_SOLICIT}`, sortOrder: 2 },
    ])

    const rows = await prisma.contractClause.findMany({ where: { versionId: version.id }, orderBy: { sortOrder: 'asc' } })
    expect(rows.map(r => [r.clauseType, r.source, r.reviewState])).toEqual([
      ['limitation_of_liability', 'ai', 'reviewed'],
      ['termination', 'ai', 'unreviewed'],
      ['non_solicitation', 'user', 'unreviewed'],
    ])
  })

  it('cuts a long clause whole from the document by its first and last words (A4), and places it (B2)', async () => {
    const contractId = await makeContract(org, owner)
    const longIndemnity = `8. INDEMNIFICATION. 8.1 Vendor shall defend, indemnify and hold harmless Customer from any third-party claim arising from the Services. ${'8.2 This includes reasonable attorneys’ fees and costs of settlement approved in writing. '.repeat(12)}8.3 The obligations in this Section survive termination for five (5) years.`
    const plainText = `7. PAYMENT. Fees are due within 30 days.\n\n${longIndemnity}\n\n9. GOVERNING LAW. New York.`
    const version = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: owner, plainText } })
    await storeClauseSegments(version.id, [{
      clauseType: 'indemnification', sortOrder: 0,
      content: longIndemnity.slice(0, 800),
      startsWith: '8. INDEMNIFICATION. 8.1 Vendor shall defend, indemnify',
      endsWith: 'survive termination for five (5) years.',
    }], plainText)
    const [row] = await prisma.contractClause.findMany({ where: { versionId: version.id } })
    expect(row.content.length).toBeGreaterThan(800)
    expect(row.content.endsWith('five (5) years.')).toBe(true)
    expect(plainText.slice(row.docStart!, row.docEnd!)).toBe(row.content)
  })

  it('a changed clause starts unreviewed', async () => {
    const contractId = await makeContract(org, owner)
    const version = await prisma.contractVersion.create({ data: { contractId, versionNumber: 1, createdById: owner } })
    await prisma.contractClause.create({ data: { versionId: version.id, clauseType: 'limitation_of_liability', content: LIABILITY, sortOrder: 0, reviewState: 'resolved' } })
    await storeClauseSegments(version.id, [{ clauseType: 'limitation_of_liability', content: LIABILITY.replace('twelve months', 'six months'), sortOrder: 0 }])
    const [row] = await prisma.contractClause.findMany({ where: { versionId: version.id } })
    expect(row.reviewState).toBe('unreviewed')
  })
})
