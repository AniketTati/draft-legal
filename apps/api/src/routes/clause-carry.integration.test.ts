/**
 * DD2 — a version made by editing keeps the clauses of the version it was
 * made from. On the Brightwave round-trip contract, v2 and v3 (the applied
 * playbook redline) had none: the playbook check found nothing to check, and
 * the Clauses tab showed v1's text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { carryClauses } from '../lib/clause-carry.js'

const SERVICES = 'Supplier shall provide the subscription services described in the Order Form.'
const FEES = 'Customer shall pay all undisputed invoices within sixty (60) days of the invoice date.'
const LIABILITY = "Each party's aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim."
const TERM = 'This Agreement has an initial term of one (1) year and renews automatically.'
const html = (parts: string[]) => parts.map((p, i) => `<h2>${i + 1}. SECTION</h2><p>${p}</p>`).join('')
const text = (parts: string[]) => parts.map((p, i) => `${i + 1}. SECTION\n${p}`).join('\n')

let app: TestApp
let org: string, user: string

async function contractWithClauses(): Promise<{ id: string; v1: string }> {
  const id = await makeContract(org, user, { title: 'DD2 Subscription', type: 'MSA' })
  const parts = [SERVICES, FEES, LIABILITY, TERM]
  const v = await prisma.contractVersion.create({
    data: { contractId: id, versionNumber: 1, createdById: user, htmlContent: html(parts), plainText: text(parts), clauseFlags: { autoRenewal: true } },
  })
  await prisma.contract.update({ where: { id }, data: { currentVersionId: v.id } })
  await prisma.contractClause.createMany({
    data: [
      { versionId: v.id, clauseType: 'services', content: SERVICES, sectionRef: '1', sortOrder: 0, riskRating: 'neutral' },
      { versionId: v.id, clauseType: 'payment', content: FEES, sectionRef: '2', sortOrder: 1, riskRating: 'favorable', interpretation: 'Sixty days to pay.', reviewState: 'reviewed', reviewedById: user, reviewedAt: new Date() },
      { versionId: v.id, clauseType: 'limitation_of_liability', content: LIABILITY, sectionRef: '3', sortOrder: 2, riskRating: 'unfavorable', interpretation: 'A 12-month cap.' },
      { versionId: v.id, clauseType: 'term', content: TERM, sectionRef: '4', sortOrder: 3, riskRating: 'neutral' },
    ],
  })
  // The payment clause has an embedding, as analysis leaves it.
  const vector = `[${Array.from({ length: 1536 }, (_, i) => (i % 7) / 10).join(',')}]`
  await prisma.$executeRawUnsafe(`UPDATE contract_clauses SET embedding = $1::vector, "embeddedAt" = now() WHERE "versionId" = $2 AND "clauseType" = 'payment'`, vector, v.id)
  return { id, v1: v.id }
}

async function clausesOf(versionId: string) {
  const rows = await prisma.contractClause.findMany({ where: { versionId }, orderBy: { sortOrder: 'asc' } })
  const embedded = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM contract_clauses WHERE "versionId" = $1 AND embedding IS NOT NULL`, versionId)
  return rows.map(r => ({ ...r, hasEmbedding: embedded.some(e => e.id === r.id) }))
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('DD2 Carry Org')
  user = await makeUser(org)
})

afterAll(async () => {
  await prisma.playbookPosition.deleteMany({ where: { orgId: org } })
  await prisma.clauseCategory.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('an editor save keeps the clauses', () => {
  it('copies unchanged clauses as they were, rewrites the edited one, and drops the deleted one', async () => {
    const { id, v1 } = await contractWithClauses()
    const edited = [SERVICES, FEES, LIABILITY.replace('twelve (12) months', 'twenty-four (24) months')]   // §4 deleted
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: auth(org, ['ADMIN'], user),
      payload: { htmlContent: html(edited) },
    })
    expect(res.statusCode, res.body).toBe(201)
    const v2 = res.json().id as string

    const rows = await clausesOf(v2)
    expect(rows.map(r => r.clauseType)).toEqual(['services', 'payment', 'limitation_of_liability'])
    const [, fees, liability] = rows
    expect(fees).toMatchObject({ content: FEES, riskRating: 'favorable', interpretation: 'Sixty days to pay.', reviewState: 'reviewed', hasEmbedding: true })
    expect(liability).toMatchObject({
      content: LIABILITY.replace('twelve (12) months', 'twenty-four (24) months'),
      riskRating: null, interpretation: null, reviewState: 'unreviewed', hasEmbedding: false, sectionRef: '3',
    })
    expect((await prisma.contractVersion.findUnique({ where: { id: v2 } }))?.clauseFlags).toEqual({ autoRenewal: true })
    // v1 is untouched.
    expect((await clausesOf(v1)).map(r => r.content)).toEqual([SERVICES, FEES, LIABILITY, TERM])

    // The Clauses tab shows the new text, not v1's.
    const tab = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/clauses`, headers: auth(org, ['ADMIN'], user) })
    expect(tab.json().data.map((c: { content: string }) => c.content)).toContain(liability.content)
  })

  it('gives the playbook check the new version to check', async () => {
    const { id } = await contractWithClauses()
    const category = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Payment' } })
    await prisma.playbookPosition.create({
      data: { orgId: org, clauseCategoryId: category.id, positionType: 'preferred', content: 'Pay within 60 days.', createdById: user,
        rules: { must_have: [{ id: 'pay.undisputed', description: 'Only undisputed invoices', check: 'contains', value: 'undisputed', severity: 'low' }] } },
    })
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/html-version`, headers: auth(org, ['ADMIN'], user),
      payload: { htmlContent: html([SERVICES, FEES.replace('sixty (60)', 'forty-five (45)'), LIABILITY, TERM]) },
    })
    const v2 = res.json().id as string
    const check = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/playbook_check',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, contractId: id },
    })
    const checks = check.json().checks as Array<{ clauseId: string; excerpt: string }>
    expect(checks).toHaveLength(1)
    expect(checks[0].excerpt).toContain('forty-five (45) days')
    expect((await prisma.contractClause.findUnique({ where: { id: checks[0].clauseId } }))?.versionId).toBe(v2)
  })
})

describe('an applied rewrite keeps the clauses', () => {
  it('the rewritten clause takes its new words; the rest are as they were', async () => {
    const { id, v1 } = await contractWithClauses()
    const payment = await prisma.contractClause.findFirst({ where: { versionId: v1, clauseType: 'payment' } })
    const proposed = 'Customer shall pay all undisputed invoices within thirty (30) days of receipt.'
    const res = await app.inject({
      method: 'POST', url: `/api/v1/contracts/${id}/clauses/${payment!.id}/apply`, headers: auth(org, ['ADMIN'], user),
      payload: { proposedText: proposed, aggression: 'moderate' },
    })
    expect(res.statusCode, res.body).toBe(200)
    const v2 = (await prisma.contract.findUnique({ where: { id } }))!.currentVersionId!
    expect(v2).not.toBe(v1)
    const rows = await clausesOf(v2)
    expect(rows.map(r => [r.clauseType, r.content, r.riskRating])).toEqual([
      ['services', SERVICES, 'neutral'],
      ['payment', proposed, null],
      ['limitation_of_liability', LIABILITY, 'unfavorable'],
      ['term', TERM, 'neutral'],
    ])
  })
})

describe('carryClauses', () => {
  it('gives a new file version the previous clauses until its analysis replaces them', async () => {
    const { id } = await contractWithClauses()
    const v2 = await prisma.contractVersion.create({
      data: { contractId: id, versionNumber: 2, createdById: user, plainText: text([SERVICES, FEES, LIABILITY.replace('twelve (12)', 'six (6)'), TERM]) },
    })
    const out = await carryClauses({ contractId: id, toVersionId: v2.id })
    expect(out).toMatchObject({ carried: 4, changed: 1, dropped: 0 })
    expect((await clausesOf(v2.id)).find(r => r.clauseType === 'limitation_of_liability')?.content).toContain('six (6) months')
  })

  it('leaves a version that has clauses alone', async () => {
    const { id, v1 } = await contractWithClauses()
    expect(await carryClauses({ contractId: id, toVersionId: v1 })).toMatchObject({ carried: 0, fromVersionId: null })
    expect(await prisma.contractClause.count({ where: { versionId: v1 } })).toBe(4)
  })
})
