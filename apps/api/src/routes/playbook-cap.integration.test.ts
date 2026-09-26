/**
 * DD1 — liability caps measured, not reasoned about. §3 of the Brightwave
 * agreement, extracted as two rows, checked against the demo org's
 * liability rules. The review told the user the 2× cap "could exceed 3×
 * annual value depending on payment schedule"; the check it read flagged the
 * cap as not stated (walkaway) and not mutual, and left both cap limits for
 * the model to work out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { LIABILITY_RULES } from '../lib/demo-liability-rules.js'

const CAP = "Except for the Excluded Claims set forth below, each party's aggregate liability arising out of or related to this Agreement shall not exceed two (2) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim. For claims arising from a breach of Section 6 (Confidentiality) involving unauthorized disclosure of Customer Data, the aggregate liability cap shall be three (3) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim."
const EXCLUDED = '"Excluded Claims" means:(a) either party\'s indemnification obligations under Section 4 (Indemnification);(b) a breach of Section 6 (Confidentiality) (except as specifically provided above for Customer Data);(c) Customer\'s payment obligations under Section 2 (FEES AND PAYMENT);(d) either party\'s gross negligence or willful misconduct; and(e) either party\'s infringement or misappropriation of the other party\'s intellectual property rights.'
const GENERAL = "Each party's cap: 2 × the fees of the 12 months before the claim = 24 months of fees, 2 times a year's fees."

let app: TestApp
let org: string, user: string, contractId: string, otherId: string

async function tool(name: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: `/api/internal/ai/tools/${name}`,
    headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
    payload: { orgId: org, ...payload },
  })
  expect(res.statusCode, `${name}: ${res.body.slice(0, 300)}`).toBe(200)
  return res.json()
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('DD1 Cap Org')
  user = await makeUser(org)
  contractId = await makeContract(org, user, { title: 'Brightwave Subscription' })
  const text = `3. LIMITATION OF LIABILITY\n${CAP}${EXCLUDED}\n4. INDEMNIFICATION\nCustomer shall indemnify Supplier against all claims.`
  const v = await prisma.contractVersion.create({
    data: { contractId, versionNumber: 1, createdById: user, plainText: text, htmlContent: `<h2>3. LIMITATION OF LIABILITY</h2><p>${CAP}${EXCLUDED}</p>` },
  })
  await prisma.contract.update({ where: { id: contractId }, data: { currentVersionId: v.id } })
  otherId = await makeContract(org, user, { title: 'Other Vendor MSA' })
  const w = await prisma.contractVersion.create({
    data: { contractId: otherId, versionNumber: 1, createdById: user, plainText: "9. LIABILITY\nSupplier's total liability under this Agreement shall not exceed $500,000.", htmlContent: '' },
  })
  await prisma.contract.update({ where: { id: otherId }, data: { currentVersionId: w.id } })
  await prisma.contractClause.createMany({
    data: [
      { versionId: v.id, clauseType: 'limitation_of_liability', content: CAP, sectionRef: '3', sortOrder: 0 },
      { versionId: v.id, clauseType: 'uncapped_liability', content: EXCLUDED, sectionRef: '3', sortOrder: 1 },
    ],
  })
  const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Limitation of Liability' } })
  const position = (positionType: string, rules: object) => prisma.playbookPosition.create({
    data: { orgId: org, clauseCategoryId: category.id, positionType, content: 'Liability cap of 2x annual fees. Super-cap of 3x for data breach.', createdById: user, rules },
  })
  // Two preferred positions carry the same rules, as in the demo org.
  await position('preferred', LIABILITY_RULES)
  await position('preferred', LIABILITY_RULES)
  await position('walkaway', { must_not: LIABILITY_RULES.must_not })
})

afterAll(async () => {
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('playbook_check measures the cap', () => {
  it('reports the one real gap, not a walkaway', async () => {
    const out = await tool('playbook_check', { contractId })
    expect(out.summary).toMatchObject({ deviationCount: 1, worstSeverity: 'high', requiresHumanGate: false })
    const failed = out.checks.flatMap((c: { violations: Array<{ passed: boolean | null; ruleId?: string }> }) => c.violations.filter(v => v.passed === false).map(v => v.ruleId))
    expect(failed).toEqual(['lol.consequential_damages_carveout'])
  })

  it('judges both cap limits with the figures, and says what the caps are', async () => {
    const out = await tool('playbook_check', { contractId })
    const lead = out.checks.find((c: { clauseType: string }) => c.clauseType === 'limitation_of_liability')
    const bounds = lead.violations.filter((v: { kind: string }) => v.kind === 'bound')
    expect(bounds.map((b: { boundKey: string; passed: boolean; value: number }) => [b.boundKey, b.passed, b.value])).toEqual([
      ['liability_cap_months', true, 24],
      ['cap_multiplier_of_annual', true, 2],
    ])
    expect(lead.capAnalysis).toEqual([
      GENERAL,
      "For claims arising from a breach of Section 6 (Confidentiality) involving unauthorized disclosure of Customer Data: 3 × the fees of the 12 months before the claim = 36 months of fees, 3 times a year's fees.",
    ])
  })
})

describe('the other tools state the cap measured', () => {
  it('contract_get', async () => {
    const out = await tool('contract_get', { contractId })
    expect(out.liabilityCaps?.[0]).toBe(GENERAL)
    expect(out.liabilityCaps).toHaveLength(2)
  })

  it('portfolio_compare, when comparing caps', async () => {
    const out = await tool('portfolio_compare', { contractIds: [contractId, otherId], topics: ['liability cap'] })
    const capsOf = (id: string) => out.contracts.find((c: { id: string }) => c.id === id)?.liabilityCaps
    expect(capsOf(contractId)?.[0]).toBe(GENERAL)
    expect(capsOf(otherId)).toEqual(['The cap: USD 500,000.'])
    const other = await tool('portfolio_compare', { contractIds: [contractId, otherId], topics: ['indemnification'] })
    expect(other.contracts.every((c: { liabilityCaps?: unknown }) => c.liabilityCaps === undefined)).toBe(true)
  })
})
