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
