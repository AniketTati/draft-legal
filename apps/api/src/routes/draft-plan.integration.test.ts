/**
 * C12 — chat drafting uses what the user asked for, and creates nothing
 * until the user confirms.
 *
 * /tools/contract_draft used to create the contract mid-stream (no card, no
 * undo) with California law, a 2-year term and today's date whatever was
 * asked, and never used an untyped template. It now only plans; the contract
 * is created by the existing confirm → apply → undo path.
 *
 * The apply RPC reaches the internal tool route over HTTP; here that request
 * is forwarded into the same in-process app, so the real path runs end to end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'

let app: TestApp
let org: string, owner: string, ndaTemplate: string, untypedNda: string, licenseTemplate: string

const plan = (payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/internal/ai/tools/contract_draft',
  headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
  payload: { orgId: org, userId: owner, ...payload },
})

async function template(name: string, contractType: string | null, content: string, variables: unknown[] = []) {
  const t = await prisma.template.create({
    data: {
      orgId: org, name, contractType, isPublished: true, createdById: owner, variables: variables as object,
      sections: { create: [{ title: 'Terms', content, sortOrder: 0 }] },
    },
  })
  return t.id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Drafting Org')
  owner = await makeUser(org)
  ndaTemplate = await template('Mutual NDA', 'NDA',
    '<p>Between {{our_company}} and {{counterparty_name}}, effective {{effective_date}}, for {{term}}, '
    + 'governed by the laws of {{governing_law}}. Fees are payable {{payment_terms}}.</p>',
    [{ key: 'payment_terms', label: 'Payment terms', defaultValue: 'net 30' }])
  untypedNda = await template('Standard Mutual Non-Disclosure (short form)', null,
    '<p>{{counterparty}} agrees to keep our information confidential under {{jurisdiction}} law.</p>')
  licenseTemplate = await template('Software License Agreement', null, '<p>License to {{counterparty_name}}.</p>')

  // Forward the apply RPC's internal HTTP call into this app.
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith('http://localhost:3001/api/')) {
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'POST',
        url: url.slice('http://localhost:3001'.length),
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      })
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.toolCall.deleteMany({ where: { thread: { orgId: org } } }).catch(() => {})
  await prisma.contract.updateMany({ where: { orgId: org }, data: { currentVersionId: null } })
  await prisma.templateSection.deleteMany({ where: { template: { orgId: org } } })
  await prisma.template.deleteMany({ where: { orgId: org } })
  await cleanupAll()
  await closeApp()
})

describe('CC5 — a template that names the parties by role', () => {
  it('puts us in the customer role and the counterparty in the provider role, or the other way round for a sell-side template', async () => {
    const orgName = (await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name
    const vars = [{ key: 'customerName', label: 'Customer Name' }, { key: 'providerName', label: 'Provider Name' }]
    const buy = await template('CC5 services (Buy-Side)', null, '<p>{{customerName}} engages {{providerName}}.</p>', vars)
    const sell = await template('CC5 services (Sell-Side)', null, '<p>{{providerName}} serves {{customerName}}.</p>', vars)

    const b = (await plan({ userMessage: 'Draft an MSA with Initech', templateId: buy, counterpartyName: 'Initech' })).json()
    expect(b.variables).toMatchObject({ customerName: orgName, providerName: 'Initech' })
    expect(b.unfilledVariables).toEqual([])
    const s = (await plan({ userMessage: 'Draft an MSA for Initech', templateId: sell, counterpartyName: 'Initech' })).json()
    expect(s.variables).toMatchObject({ providerName: orgName, customerName: 'Initech' })
  })
})

describe('CC5 — an NDA\'s term, and a venue that went with another law', () => {
  it('sets how long confidentiality lasts from the term asked for, and leaves the venue to set when the law changed', async () => {
    const nda = await template('CC5 duration and venue', null,
      '<p>Confidentiality lasts {{confidentialityYears}} years. Governed by {{governingLaw}} law; courts of {{venueLocation}}.</p>',
      [{ key: 'confidentialityYears', defaultValue: '3' }, { key: 'governingLaw', defaultValue: 'Delaware' }, { key: 'venueLocation', defaultValue: 'Wilmington, Delaware' }])
    const p = (await plan({ userMessage: 'NDA with Initech, 5 years, New York law', templateId: nda, counterpartyName: 'Initech', governingLaw: 'New York', term: '5 years' })).json()
    expect(p.variables).toMatchObject({ confidentialityYears: '5', governingLaw: 'New York' })
    expect(p.variables.venueLocation).toBeUndefined()
    expect(p.unfilledVariables).toContain('venueLocation')
    // Same law as the template's: its venue stands.
    const same = (await plan({ userMessage: 'NDA with Initech', templateId: nda, counterpartyName: 'Initech', governingLaw: 'Delaware' })).json()
    expect(same.variables.venueLocation).toBe('Wilmington, Delaware')
  })
})

describe('DD3 — facts about the other party', () => {
  const vars = [
    { key: 'customerName' }, { key: 'customerEntity', defaultValue: 'a Delaware corporation' }, { key: 'customerAddress' },
    { key: 'providerName' }, { key: 'providerEntity', defaultValue: 'a Delaware corporation' }, { key: 'providerAddress' },
  ]
  const body = '<p>Between {{customerName}}, {{customerEntity}}, of {{customerAddress}}, and {{providerName}}, {{providerEntity}}, of {{providerAddress}}.</p>'

  it('leaves their entity to fill in instead of the template\'s default, which stays for our side', async () => {
    const t = await template('DD3 Mutual NDA', null, body, vars)
    const p = (await plan({ userMessage: 'Draft an NDA with Initech', templateId: t, counterpartyName: 'Initech Inc.' })).json()
    expect(p.variables.customerEntity).toBe('a Delaware corporation')
    expect(p.variables.providerEntity).toBeUndefined()
    expect(p.unfilledVariables).toEqual(expect.arrayContaining(['providerEntity', 'providerAddress', 'customerAddress']))
    expect(p.html).not.toContain('Initech Inc., a Delaware corporation')
    // A sell-side template: we are the provider.
    const sell = await template('DD3 NDA (Sell-Side)', null, body, vars)
    const s = (await plan({ userMessage: 'NDA for Initech', templateId: sell, counterpartyName: 'Initech Inc.' })).json()
    expect(s.variables.providerEntity).toBe('a Delaware corporation')
    expect(s.variables.customerEntity).toBeUndefined()
  })

  it('takes their registered name and address from the counterparty record, and their entity from the user', async () => {
    await prisma.counterparty.create({ data: { orgId: org, name: 'Globex', legalName: 'Globex Corporation', address: '1 Globex Way, Springfield' } })
    const t = await template('DD3 services (Buy-Side)', null,
      '<p>{{customerName}} engages {{providerName}} ({{providerLegalName}}), {{providerEntity}}, of {{providerAddress}}.</p>',
      [{ key: 'customerName' }, { key: 'providerName' }, { key: 'providerLegalName' }, { key: 'providerAddress' }, { key: 'providerEntity', defaultValue: 'a Delaware corporation' }])
    const p = (await plan({ userMessage: 'An MSA with Globex, a Nevada corporation', templateId: t, counterpartyName: 'globex', terms: { providerEntity: 'a Nevada corporation' } })).json()
    expect(p.variables).toMatchObject({ providerLegalName: 'Globex Corporation', providerAddress: '1 Globex Way, Springfield', providerEntity: 'a Nevada corporation' })
    expect(p.unfilledVariables).toEqual([])
  })
})

describe('drafting plan', () => {
  it('fills the user\'s stated terms, the template\'s own defaults and our name — and creates nothing', async () => {
    const before = await prisma.contract.count({ where: { orgId: org } })
    const res = await plan({
      userMessage: 'Draft an NDA with Initech, 3-year term, New York law, effective 2026-10-01',
      contractType: 'NDA', counterpartyName: 'Initech',
      governingLaw: 'New York', term: '3 years', effectiveDate: '2026-10-01',
    })
    expect(res.statusCode).toBe(200)
    const p = res.json()
    expect(p).toMatchObject({ templateId: ndaTemplate, contractType: 'NDA', persisted: false })
    expect(p.variables).toMatchObject({
      counterparty_name: 'Initech', governing_law: 'New York', term: '3 years',
      effective_date: '2026-10-01', payment_terms: 'net 30', our_company: 'Drafting Org',
    })
    expect(p.unfilledVariables).toEqual([])
    expect(p.html).toContain('New York')
    expect(await prisma.contract.count({ where: { orgId: org } })).toBe(before)
  })

  it('leaves unstated terms blank and reported — never California, 2 years or today', async () => {
    const res = await plan({ userMessage: 'draft an NDA for Initech', counterpartyName: 'Initech' })
    const p = res.json()
    expect(p.unfilledVariables.sort()).toEqual(['effective_date', 'governing_law', 'term'])
    expect(p.html).not.toContain('California')
    expect(p.html).not.toContain('2 years')
    expect(p.html).not.toContain(new Date().toISOString().slice(0, 10))
  })

  it('uses an untyped template that names the type, when there is no typed one', async () => {
    const res = await plan({ userMessage: 'license for Globex', contractType: 'LICENSE', counterpartyName: 'Globex' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ templateId: licenseTemplate, contractType: 'LICENSE' })
  })

  it('an explicit template id wins, and aliases map onto that template\'s own variable names', async () => {
    const res = await plan({ userMessage: 'NDA for Hooli', templateId: untypedNda, contractType: 'NDA', counterpartyName: 'Hooli', governingLaw: 'Delaware' })
    expect(res.json()).toMatchObject({ templateId: untypedNda, variables: { counterparty: 'Hooli', jurisdiction: 'Delaware' } })
  })

  it('no matching template → a structured error listing what the org has', async () => {
    const res = await plan({ userMessage: 'offer letter for Sam', contractType: 'EMPLOYMENT' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('NO_TEMPLATE_MATCH')
    expect(res.json().templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([ndaTemplate, untypedNda]))
  })
})

describe('confirm → apply → undo', () => {
  it('creates the planned draft only on Apply (owner = caller, audited, undoable)', async () => {
    const p = (await plan({
      userMessage: 'NDA for Initech, New York law', contractType: 'NDA', counterpartyName: 'Initech', governingLaw: 'New York',
    })).json()

    const thread = (await app.inject({
      method: 'POST', url: '/api/v1/agent/threads', headers: auth(org, ['ADMIN'], owner), payload: { title: 'draft' },
    })).json().id

    const applied = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/apply`, headers: auth(org, ['ADMIN'], owner),
      payload: {
        toolName: 'contract_create_from_template',
        args: { templateId: p.templateId, variables: p.variables, title: p.title, contractType: p.contractType, counterpartyName: 'Initech' },
      },
    })
    expect(applied.statusCode).toBe(200)
    const { result, toolCallId } = applied.json()
    expect(result.html).toContain('New York')

    const created = await prisma.contract.findUnique({ where: { id: result.contractId } })
    expect(created).toMatchObject({ ownerId: owner, type: 'NDA', status: 'DRAFT', title: 'Initech — NDA', deletedAt: null })
    let audit = null
    for (let i = 0; i < 10 && !audit; i++) {
      audit = await prisma.auditEvent.findFirst({ where: { resourceId: result.contractId, action: 'CONTRACT_CREATED' } })
      if (!audit) await new Promise(r => setTimeout(r, 100))
    }
    expect(audit?.userId).toBe(owner)

    const undone = await app.inject({
      method: 'POST', url: `/api/v1/agent/threads/${thread}/actions/${toolCallId}/undo`, headers: auth(org, ['ADMIN'], owner),
    })
    expect(undone.statusCode).toBe(200)
    expect((await prisma.contract.findUnique({ where: { id: result.contractId } }))?.deletedAt).not.toBeNull()
  })
})

// X67 review — the tool stored its text through its own converter, which glued
// table cells: `<td>SSN</td><td>219-09-9999</td>` became `SSN219-09-9999`,
// which the PII patterns don't match.
describe('a draft made from a template', () => {
  it('stores its text as it reads, cells apart', async () => {
    const tpl = await template('Employee Details', 'EMPLOYMENT',
      '<table><tr><td>SSN</td><td>{{ssn}}</td></tr><tr><td>Card</td><td>{{card}}</td></tr></table>')
    const res = await app.inject({
      method: 'POST', url: '/api/internal/ai/tools/contract_create_from_template',
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET as string },
      payload: { orgId: org, userId: owner, templateId: tpl, title: 'X67 table', variables: { ssn: '219-09-9999', card: '4111 1111 1111 1111' } },
    })
    expect(res.statusCode).toBe(200)
    const version = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: res.json().contractId } })
    expect(version.plainText).toContain('SSN 219-09-9999\nCard 4111 1111 1111 1111')
  })
})
