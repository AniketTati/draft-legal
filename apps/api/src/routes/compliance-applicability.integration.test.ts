/**
 * docs/41 Parts 9 and 10 — compliance applicability from facts and the org's
 * policy, a person's answer to the one question, adding a framework, the
 * policy's admin routes, and the defined terms of a version. The agents
 * service is mocked: no model is called.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { computeDraftingFindings } from '../lib/drafting-findings.js'
import { runComplianceApplicability } from '../lib/compliance-facts.js'

let app: TestApp
let orgA: string, orgB: string, ownerA: string, ownerB: string
let dpa: string, dpaVersion: string, nda: string, ndaVersion: string, contractB: string

const DPA = [
  'DATA PROCESSING AGREEMENT',
  'This Data Processing Agreement (the “Agreement”) is between Acme GmbH, a company registered in Germany (“Customer”), and Beta Inc. (“Supplier”).',
  'Supplier will process Customer’s employee personal data on behalf of Customer.',
  '“Exclusions” means the matters in Schedule 2.',
  'Supplier shall protect the Personal Data and deliver the Deliverables.',
].join('\n')
const NDA = 'MUTUAL NON-DISCLOSURE AGREEMENT\nThe parties (each a “Party”) will exchange business plans. Each Party keeps the other’s plans secret.'

// What the mocked agents service is asked, and answers.
const calls = { facts: 0, checks: [] as Array<{ frameworks: string[]; applicabilityDecided: boolean }> }
const factsFor: Record<string, unknown[]> = {}

function factsReply(text: string): unknown[] {
  return text.includes('employee personal data') ? factsFor.dpa : factsFor.nda
}

beforeAll(async () => {
  app = await getApp()
  orgA = await makeOrg('Compliance Facts Org A')
  orgB = await makeOrg('Compliance Facts Org B')
  ownerA = await makeUser(orgA)
  ownerB = await makeUser(orgB)
  dpa = await makeContract(orgA, ownerA, { title: 'Acme DPA', type: 'DPA' })
  nda = await makeContract(orgA, ownerA, { title: 'Mutual NDA', type: 'NDA' })
  contractB = await makeContract(orgB, ownerB, { title: 'Org B DPA', type: 'DPA' })
  const v1 = await prisma.contractVersion.create({ data: { contractId: dpa, versionNumber: 1, createdById: ownerA, plainText: DPA } })
  const v2 = await prisma.contractVersion.create({ data: { contractId: nda, versionNumber: 1, createdById: ownerA, plainText: NDA } })
  const v3 = await prisma.contractVersion.create({ data: { contractId: contractB, versionNumber: 1, createdById: ownerB, plainText: DPA } })
  dpaVersion = v1.id; ndaVersion = v2.id
  await prisma.contract.update({ where: { id: dpa }, data: { currentVersionId: v1.id } })
  await prisma.contract.update({ where: { id: nda }, data: { currentVersionId: v2.id } })
  await prisma.contract.update({ where: { id: contractB }, data: { currentVersionId: v3.id } })
  // Org B's own answer, which Org A must never see or change.
  await prisma.contractFact.create({ data: { orgId: orgB, contractId: contractB, key: 'personal_data', value: false, confidence: 1, source: 'user', confirmedAt: new Date() } })

  factsFor.dpa = [
    { key: 'personal_data', value: true, quote: 'Supplier will process Customer’s employee personal data', confidence: 0.95 },
    { key: 'data_subject_regions', value: ['DE'], quote: 'a company registered in Germany', confidence: 0.8 },
    { key: 'party_jurisdictions', value: ['DE', 'US'], quote: 'a company registered in Germany', confidence: 0.8 },
    { key: 'health_data', value: false, quote: null, confidence: 0.9 },
    { key: 'payment_card_data', value: false, quote: null, confidence: 0.9 },
    { key: 'financial_reporting_impact', value: false, quote: null, confidence: 0.8 },
  ]
  factsFor.nda = [
    // Not sure: a question for the user.
    { key: 'personal_data', value: null, quote: null, confidence: 0.2 },
    { key: 'health_data', value: false, quote: null, confidence: 0.9 },
    { key: 'payment_card_data', value: false, quote: null, confidence: 0.9 },
    { key: 'financial_reporting_impact', value: false, quote: null, confidence: 0.9 },
  ]

  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/compliance/facts')) {
      calls.facts++
      const body = JSON.parse(String(init?.body)) as { plainText: string }
      return new Response(JSON.stringify({ facts: factsReply(body.plainText), model: 'fake', provider: 'fake' }))
    }
    if (url.endsWith('/check_compliance')) {
      const body = JSON.parse(String(init?.body)) as { frameworks: string[]; applicabilityDecided: boolean }
      calls.checks.push({ frameworks: body.frameworks, applicabilityDecided: body.applicabilityDecided })
      return new Response(JSON.stringify({
        frameworks: body.frameworks.map(framework => ({
          framework, applicable: true, applicabilityReason: '', status: 'gaps', score: 70,
          checks: [{ id: 'x_breach', requirement: 'Breach notice', status: 'missing', severity: 'high', finding: 'No breach notice.', quote: null, sectionRef: null, recommendation: 'Add one.' }],
        })),
        overall: { status: 'gaps', summary: 'Gaps.', criticalCount: 0 },
      }))
    }
    return realFetch(input as never, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise(r => setTimeout(r, 300))
  await prisma.contract.updateMany({ where: { orgId: { in: [orgA, orgB] } }, data: { currentVersionId: null } })
  await cleanupAll()
  await closeApp()
})

const admin = (org = orgA, sub = ownerA) => auth(org, ['ADMIN'], sub)
const editor = () => auth(orgA, ['LEGAL_COUNSEL'], ownerA)
const applicability = async (id: string, headers = admin()) => app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/compliance/applicability`, headers })
const fw = (body: { frameworks: Array<{ framework: string; applies: string }> }, id: string) => body.frameworks.find(f => f.framework === id)?.applies

describe('applicability from facts (Part 9)', () => {
  it('asks about personal data before any facts are read', async () => {
    const res = await applicability(dpa)
    expect(res.statusCode).toBe(200)
    expect(res.json().question).toMatchObject({ key: 'personal_data', kind: 'boolean' })
    expect(res.json().frameworks.every((f: { applies: string }) => f.applies === 'unsure')).toBe(true)
  })

  it('reads the facts once, says why GDPR applies, and checks only GDPR', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${dpa}/compliance/facts/extract`, headers: editor(), payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(calls.facts).toBe(1)
    expect(fw(body, 'GDPR')).toBe('yes')
    for (const other of ['UK_GDPR', 'CCPA', 'HIPAA', 'SOX', 'PCI_DSS']) expect(fw(body, other)).toBe('no')
    const gdpr = body.frameworks.find((f: { framework: string }) => f.framework === 'GDPR')
    expect(gdpr.because.map((b: { quote: string }) => b.quote)).toContain('Supplier will process Customer’s employee personal data')
    expect(body.question).toBeNull()
    expect(calls.checks).toEqual([{ frameworks: ['GDPR'], applicabilityDecided: true }])
    expect(body.checksRan).toEqual(['GDPR'])
    expect(body.report).toMatchObject({ versionId: dpaVersion, frameworksRequested: ['GDPR'] })
    expect(body.report.textHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('makes no model call when the text has not changed', async () => {
    await runComplianceApplicability(dpa, dpaVersion)
    expect(calls.facts).toBe(1)
    expect(calls.checks).toHaveLength(1)
  })

  it('asks one question when unsure, and an NDA with no personal data runs no framework', async () => {
    await runComplianceApplicability(nda, ndaVersion)
    let body = (await applicability(nda)).json()
    expect(body.question).toMatchObject({ key: 'personal_data', options: [{ value: 'yes' }, { value: 'no' }, { value: 'unsure' }] })
    expect(fw(body, 'GDPR')).toBe('unsure')
    expect(calls.checks).toHaveLength(1)

    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${nda}/compliance/facts/confirm`, headers: editor(), payload: { key: 'personal_data', value: 'no' } })
    expect(res.statusCode).toBe(200)
    body = res.json()
    expect(body.frameworks.filter((f: { applies: string }) => f.applies !== 'no')).toEqual([])
    expect(body.question).toBeNull()
    expect(body.checksRan).toEqual([])
    expect(calls.checks).toHaveLength(1)
    const fact = await prisma.contractFact.findUniqueOrThrow({ where: { contractId_key: { contractId: nda, key: 'personal_data' } } })
    expect(fact).toMatchObject({ value: false, source: 'user', confirmedById: ownerA })
    expect(await prisma.auditEvent.count({ where: { orgId: orgA, action: 'COMPLIANCE_FACT_CONFIRMED', resourceId: nda } })).toBe(1)
  })

  it('keeps a person\'s answer when the facts are read again', async () => {
    factsFor.nda = [{ key: 'personal_data', value: true, quote: 'business plans', confidence: 0.9 }]
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${nda}/compliance/facts/extract`, headers: editor(), payload: { force: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json().facts.find((f: { key: string }) => f.key === 'personal_data')).toMatchObject({ value: false, source: 'user' })
    // What the AI no longer reports, and nobody answered, is gone.
    expect(res.json().facts.map((f: { key: string }) => f.key)).toEqual(['personal_data'])
  })

  it('"Not sure" is an answer: the question is not asked again', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${nda}/compliance/facts/confirm`, headers: editor(), payload: { key: 'personal_data', value: 'unsure' } })
    expect(res.json().question?.key).not.toBe('personal_data')
    expect(fw(res.json(), 'GDPR')).toBe('unsure')
  })

  it('refuses an answer of the wrong kind', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${nda}/compliance/facts/confirm`, headers: editor(), payload: { key: 'personal_data', value: 'maybe' } })
    expect(res.statusCode).toBe(422)
    const bad = await app.inject({ method: 'POST', url: `/api/v1/contracts/${nda}/compliance/facts/confirm`, headers: editor(), payload: { key: 'is_gdpr', value: 'yes' } })
    expect(bad.statusCode).toBe(422)
  })

  it('adds a framework by hand, and keeps the results already there', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/contracts/${dpa}/compliance/frameworks`, headers: editor(), payload: { framework: 'PCI_DSS' } })
    expect(res.statusCode).toBe(200)
    expect(calls.checks.at(-1)).toEqual({ frameworks: ['PCI_DSS'], applicabilityDecided: true })
    const body = res.json()
    expect(body.frameworks.find((f: { framework: string }) => f.framework === 'PCI_DSS')).toMatchObject({ applies: 'yes', addedByUser: true })
    expect(body.report.frameworks.map((f: { framework: string }) => f.framework).sort()).toEqual(['GDPR', 'PCI_DSS'])
  })
})

describe('the org policy (Part 9)', () => {
  it('starts with the default rules', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/compliance-policy', headers: editor() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ isDefault: true })
    expect(res.json().rules.map((r: { framework: string }) => r.framework)).toContain('PCI_DSS')
    expect(res.json().facts.map((f: { key: string }) => f.key)).toContain('personal_data')
  })

  it('lets an admin change the rules, and applicability follows them', async () => {
    const rules = [{ id: 'gdpr-any-personal', framework: 'GDPR', enabled: false, when: [{ fact: 'personal_data', op: 'is_true' }] }]
    const res = await app.inject({ method: 'PUT', url: '/api/v1/compliance-policy', headers: admin(), payload: { rules } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ isDefault: false, rules })
    // GDPR's only rule is off: it no longer applies (PCI DSS was added by hand and stays).
    const body = (await applicability(dpa)).json()
    expect(body.frameworks.map((f: { framework: string }) => f.framework)).toEqual(['PCI_DSS'])
    expect(await prisma.auditEvent.count({ where: { orgId: orgA, action: 'COMPLIANCE_POLICY_UPDATED' } })).toBe(1)
  })

  it('refuses rules that are not rules, and someone who may not configure', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/compliance-policy', headers: admin(), payload: { rules: [{ id: 'x', framework: 'NOPE', enabled: true, when: [] }] } })
    expect(bad.statusCode).toBe(422)
    const dup = await app.inject({ method: 'PUT', url: '/api/v1/compliance-policy', headers: admin(), payload: { rules: [
      { id: 'x', framework: 'GDPR', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }] },
      { id: 'x', framework: 'CCPA', enabled: true, when: [{ fact: 'personal_data', op: 'is_true' }] },
    ] } })
    expect(dup.statusCode).toBe(422)
    const needsValues = await app.inject({ method: 'PUT', url: '/api/v1/compliance-policy', headers: admin(), payload: { rules: [{ id: 'y', framework: 'GDPR', enabled: true, when: [{ fact: 'data_subject_regions', op: 'includes_any' }] }] } })
    expect(needsValues.statusCode).toBe(422)
    const denied = await app.inject({ method: 'PUT', url: '/api/v1/compliance-policy', headers: editor(), payload: { rules: [] } })
    expect(denied.statusCode).toBe(403)
  })

  it('keeps each org\'s policy its own, and resets to the defaults', async () => {
    const b = await app.inject({ method: 'GET', url: '/api/v1/compliance-policy', headers: admin(orgB, ownerB) })
    expect(b.json().isDefault).toBe(true)
    await app.inject({ method: 'DELETE', url: '/api/v1/compliance-policy', headers: admin(orgB, ownerB) })
    expect(await prisma.compliancePolicy.count({ where: { orgId: orgA } })).toBe(1)
    const reset = await app.inject({ method: 'DELETE', url: '/api/v1/compliance-policy', headers: admin() })
    expect(reset.json().isDefault).toBe(true)
    expect(await prisma.compliancePolicy.count({ where: { orgId: orgA } })).toBe(0)
  })
})

describe('tenant isolation', () => {
  it('never reads, answers or checks another org\'s contract', async () => {
    const checksBefore = calls.checks.length
    const factsBefore = calls.facts
    const asA = admin()
    expect((await applicability(contractB, asA)).statusCode).toBe(404)
    for (const [url, payload] of [
      [`/api/v1/contracts/${contractB}/compliance/facts/confirm`, { key: 'personal_data', value: 'yes' }],
      [`/api/v1/contracts/${contractB}/compliance/facts/extract`, { force: true }],
      [`/api/v1/contracts/${contractB}/compliance/frameworks`, { framework: 'GDPR' }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: asA, payload })
      expect(res.statusCode).toBe(404)
    }
    expect((await app.inject({ method: 'GET', url: `/api/v1/contracts/${contractB}/defined-terms`, headers: asA })).statusCode).toBe(404)
    expect(calls.checks.length).toBe(checksBefore)
    expect(calls.facts).toBe(factsBefore)
    const fact = await prisma.contractFact.findUniqueOrThrow({ where: { contractId_key: { contractId: contractB, key: 'personal_data' } } })
    expect(fact).toMatchObject({ orgId: orgB, value: false })
    expect(await prisma.contractFact.count({ where: { orgId: orgA, contractId: contractB } })).toBe(0)
  })
})

describe('defined terms of a version (Part 10)', () => {
  it('returns the glossary and the drafting problems', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/contracts/${dpa}/defined-terms`, headers: editor() })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.versionId).toBe(dpaVersion)
    expect(body.glossary.map((g: { term: string }) => g.term)).toEqual(['Agreement', 'Customer', 'Supplier', 'Exclusions'])
    const kinds = body.issues.map((i: { kind: string; term: string }) => `${i.kind}:${i.term}`)
    expect(kinds).toEqual(expect.arrayContaining(['unused_definition:Exclusions', 'undefined_term:Deliverables', 'undefined_term:Personal Data']))
    expect(body.issues[0]).toMatchObject({ clauseType: null, versionId: dpaVersion })
  })

  it('reads a named version, and only one of this contract', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/v1/contracts/${dpa}/defined-terms?versionId=${dpaVersion}`, headers: editor() })
    expect(ok.statusCode).toBe(200)
    const other = await app.inject({ method: 'GET', url: `/api/v1/contracts/${dpa}/defined-terms?versionId=${ndaVersion}`, headers: editor() })
    expect(other.statusCode).toBe(404)
  })

  it('stores the findings on the contract as part of analysis', async () => {
    const findings = await computeDraftingFindings(dpa, dpaVersion)
    expect(findings?.length).toBeGreaterThan(0)
    const md = (await prisma.contract.findUniqueOrThrow({ where: { id: dpa }, select: { metadata: true } })).metadata as Record<string, any>
    expect(md._drafting.versionId).toBe(dpaVersion)
    expect(md._drafting.issues.find((i: { term: string }) => i.term === 'Exclusions')).toMatchObject({
      kind: 'unused_definition', clauseType: null, severity: 'low', versionId: dpaVersion,
      evidence: { quote: expect.stringContaining('“Exclusions” means'), offset: DPA.indexOf('Exclusions') },
    })
    // The compliance results written before are still there: one key was written.
    expect(md._compliance.frameworks.length).toBe(2)
  })
})
