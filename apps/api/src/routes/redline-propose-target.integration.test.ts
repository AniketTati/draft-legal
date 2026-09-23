/**
 * X53 — the chat's redline tool could target a clause only by its id, which
 * the model can't see, or by its type. "Redline section 4" made the model
 * guess a type, get a bare "Clause not found", and give up. The tool now
 * takes the section the user named, and a miss lists the contract's clauses
 * (their openings under the org's PII policy) so the model can retry by id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

const SSN = '219-09-9999'
const FEES = '3. Fees. Company pays USD 12,500 a month.'
const INFO = `4. Contractor Information. For tax reporting on Form 1099, Contractor's Social Security Number is ${SSN}.`

let app: TestApp
let org: string, owner: string, contract: string, versionId: string, fees: string, info: string, signatures: string

const propose = (payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/internal/ai/tools/redline_propose',
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, contractId: contract, ...payload },
})

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Redline Target Org')
  owner = await makeUser(org)
  contract = await makeContract(org, owner, { title: 'Contractor agreement' })
  const v = await prisma.contractVersion.create({
    data: { contractId: contract, versionNumber: 1, createdById: owner, plainText: `${FEES}\n${INFO}`, htmlContent: `<p>${FEES}</p><p>${INFO}</p>` },
  })
  await prisma.contract.update({ where: { id: contract }, data: { currentVersionId: v.id } })
  versionId = v.id
  fees = (await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'payment', sectionRef: '3', sortOrder: 0, content: FEES } })).id
  info = (await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'confidentiality', sectionRef: '4', sortOrder: 1, content: INFO } })).id
  // The extractor stores whatever label it read, an empty one included.
  signatures = (await prisma.contractClause.create({ data: { versionId: v.id, clauseType: 'general', sectionRef: '', sortOrder: 2, content: 'IN WITNESS WHEREOF, the parties sign.' } })).id

  // The agents service's rewriter: echoes the clause it was sent.
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/redline_propose')) {
      const { clauseText } = JSON.parse(String(init?.body)) as { clauseText: string }
      return new Response(JSON.stringify({ variants: [{ aggression: 'moderate', proposedText: `${clauseText} Stored encrypted.`, rationale: 'r', changes: [] }] }))
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.contractClause.deleteMany({ where: { version: { contractId: contract } } })
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

describe('redline_propose targets', () => {
  it('the section the user named, however they wrote it', async () => {
    for (const sectionRef of ['4', '§4', 'Section 4', '4.', 'Sections 4', 'sect. 4', '04']) {
      const res = await propose({ sectionRef })
      expect(res.statusCode, sectionRef).toBe(200)
      expect(res.json().clause).toMatchObject({ id: info, sectionRef: '4' })
    }
  })

  it('a miss lists the clauses to retry with, their openings under the PII policy', async () => {
    const res = await propose({ clauseType: 'contractor_information' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.detail).toMatch(/^Clause not found/)
    expect(body.clauses.map((c: { clauseId: string }) => c.clauseId)).toEqual([fees, info, signatures])
    expect(body.clauses[1]).toMatchObject({ clauseType: 'confidentiality', sectionRef: '4' })
    expect(body.clauses[1].opening).toMatch(/^4\. Contractor Information\. For tax reporting on Form 1099/)
    expect(JSON.stringify(body)).not.toMatch(/219-0/)
    // Retrying with one of them works.
    expect((await propose({ clauseId: body.clauses[1].clauseId })).statusCode).toBe(200)
  })

  it('a section the contract doesn\'t have is a miss too', async () => {
    const res = await propose({ sectionRef: '12' })
    expect(res.statusCode).toBe(404)
    expect(res.json().clauses).toHaveLength(3)
  })

  it('X53 review — a reference with no number names no clause, not the first unnumbered one', async () => {
    for (const sectionRef of ['§', 'Section', ' ']) {
      const res = await propose({ sectionRef })
      expect(res.statusCode, JSON.stringify(sectionRef)).toBe(404)
      expect(res.json().clauses.map((c: { clauseId: string }) => c.clauseId)).toContain(signatures)
    }
  })

  it('X53 review — a section that misses falls back to the clause type given with it', async () => {
    const res = await propose({ sectionRef: '12', clauseType: 'payment' })
    expect(res.statusCode).toBe(200)
    expect(res.json().clause.id).toBe(fees)
  })

  it('X53 review — a long contract lists the missed section\'s neighbours first, and says the list is cut', async () => {
    await prisma.contractClause.createMany({
      data: Array.from({ length: 70 }, (_, i) => ({
        versionId, clauseType: 'general', sortOrder: 10 + i, sectionRef: i < 68 ? String(20 + i) : `90.${i - 67}`, content: `Clause ${i}.`,
      })),
    })
    const res = await propose({ sectionRef: '90.5' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.clauses).toHaveLength(60)
    expect(body.clauses.slice(0, 2).map((c: { sectionRef: string }) => c.sectionRef)).toEqual(['90.1', '90.2'])
    expect(body.detail).toMatch(/60 of the contract's 73/)
  })
})
