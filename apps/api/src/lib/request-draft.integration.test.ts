/**
 * docs/41 Part 1 — a request drafted by rule, the way the assistant drafts.
 *
 *   - a request naming New York law gets the New York variant, recorded as
 *     decided by the request's value, with the request's words;
 *   - the same request drafted twice gets the same template and variants;
 *   - the assistant and the request path pick the same template;
 *   - no law and no default: a choice blank, the draft held back from
 *     sending, and a choice made in the Origin panel;
 *   - the request page shows the plan and takes the requester's picks.
 *
 * The agents service is never called: the variable extractor is a fake, and
 * the queues are recorded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const { queued } = vi.hoisted(() => ({ queued: [] as Array<{ name: string; data: Record<string, unknown> }> }))
vi.mock('./queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./queue.js')>()
  const rec = (name: string) => vi.fn((data: Record<string, unknown>) => { queued.push({ name, data }) })
  return {
    ...real,
    queueDraftContract: rec('draft-contract'),
    queueExtractAi: rec('extract-ai'),
    queueClassifyDocument: rec('classify-document'),
    queueParseDocument: rec('parse-document'),
    queueClassifyRequest: rec('classify-request'),
    queueEmbedContract: vi.fn(),
    queueNotification: vi.fn(),
    queueSigningReminder: vi.fn(async () => ({ id: 'x' })),
    agentQueue: { getJob: async () => undefined, add: async () => ({ id: 'x' }) },
  }
})

import { getApp, closeApp, makeOrg, makeUser, makeContract, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { draftFromRequest, type ExtractedValue, type RequestDraftContext, type VariableExtractor } from './request-draft.js'
import { planDraft } from './draft-plan.js'
import { saveDraftVersion } from './draft-save.js'
import { openChoices } from './open-choices.js'

let app: TestApp
let org: string, user: string
let law: { id: string; ny: string; ew: string; de: string }
let mutual: string, oneWay: string

const ASK = 'Mutual NDA with Initech for a partnership. It should be governed by New York law.'
const ctx = (extra: Partial<RequestDraftContext> = {}): RequestDraftContext => ({
  requestTitle: 'NDA with Initech', requestDescription: ASK, contractType: 'NDA', counterpartyName: 'Initech', ...extra,
})
const extractor = (values: ExtractedValue[] = []) => vi.fn<VariableExtractor>(async () => values)

async function variant(familyId: string, label: string, order: number, matchValues: string[]) {
  return (await prisma.clauseLibraryItem.create({
    data: {
      orgId: org, categoryId: (await prisma.clauseCategory.findFirstOrThrow({ where: { orgId: org } })).id, createdById: user,
      title: `Governing Law — ${label}`, familyId, variantLabel: label, variantOrder: order, matchValues, isApproved: true,
      content: `<p>This Agreement is governed by the laws of ${label}. Courts of {{venueLocation}}.</p>`,
    },
  })).id
}

async function template(name: string) {
  const t = await prisma.template.create({
    data: {
      orgId: org, name, contractType: 'NDA', isPublished: true, createdById: user,
      variables: [{ key: 'purpose', label: 'Purpose' }, { key: 'counterparty_name', label: 'Counterparty' }, { key: 'governingLaw', label: 'Governing Law' }] as never,
      sections: { create: [
        { title: 'Parties', sortOrder: 0, content: '<p>Between us and {{counterparty_name}}, for {{purpose}}.</p>' },
        { title: 'Governing Law', sortOrder: 1, content: '', slotFamilyId: law.id },
      ] },
    },
  })
  await app.inject({ method: 'POST', url: `/api/v1/templates/${t.id}/publish`, headers: auth(org, ['ADMIN'], user) })
  return t.id
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Request Drafting Org')
  user = await makeUser(org)
  await prisma.clauseCategory.create({ data: { orgId: org, name: 'Dispute Resolution' } })
  const f = await prisma.clauseFamily.create({ data: { orgId: org, name: 'Governing Law', requestKey: 'governingLaw', createdById: user } })
  law = {
    id: f.id,
    ny: await variant(f.id, 'New York', 0, ['New York', 'NY']),
    ew: await variant(f.id, 'England and Wales', 1, ['England and Wales', 'England']),
    de: await variant(f.id, 'Delaware', 2, ['Delaware']),
  }
  await prisma.clauseLibraryItem.update({ where: { id: law.ew }, data: { condition: { op: 'in', key: 'counterparty.country', value: ['GB'] } } })
  mutual = await template('Mutual NDA')
  oneWay = await template('One-Way NDA')
  await prisma.template.update({ where: { id: mutual }, data: { isDefaultForType: true } })
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

beforeEach(() => { queued.length = 0 })

describe('a request that names New York law', () => {
  it('is drafted with the New York variant, decided by the request\'s value, with its words', async () => {
    const extract = extractor()
    const r = await draftFromRequest({ orgId: org, contractId: 'c1', ctx: ctx({ extractedTerms: { governingLaw: 'New York' } }) }, extract)
    expect(r.usedTemplateId).toBe(mutual)
    expect(r.html).toContain('governed by the laws of New York')
    expect(r.origin!.templateDecidedBy).toBe('default_for_type')
    expect(r.origin!.slots).toEqual([expect.objectContaining({
      familyId: law.id, variantId: law.ny, variantVersion: 1, decidedBy: 'request_value',
      evidence: { key: 'governingLaw', value: 'New York', quote: 'It should be governed by New York law.' },
    })])
    // The variant's term reaches the draft's fields; the counterparty is the request's own field.
    expect(r.origin!.variables).toEqual(expect.arrayContaining([
      { key: 'governingLaw', value: 'New York', source: 'clause_choice' },
      { key: 'counterparty_name', value: 'Initech', source: 'request_field' },
    ]))
    // The agent is asked only to read values (with quotes), from the template's variables.
    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract.mock.calls[0][0].variables.map(v => v.key)).toEqual(['purpose', 'counterparty_name', 'governingLaw', 'counterpartyCountry'])
  })

  it('takes the extractor\'s value only with a quote from the request', async () => {
    const quoted = await draftFromRequest({ orgId: org, contractId: 'c2', ctx: ctx() }, extractor([
      { key: 'governingLaw', value: 'New York', quote: 'governed by New York law' },
      { key: 'purpose', value: 'a partnership', quote: 'for a partnership' },
    ]))
    expect(quoted.origin!.slots[0]).toMatchObject({ decidedBy: 'request_value', variantId: law.ny, evidence: { quote: 'governed by New York law' } })
    expect(quoted.origin!.variables).toEqual(expect.arrayContaining([{ key: 'purpose', value: 'a partnership', source: 'request_text', quote: 'for a partnership' }]))

    const invented = await draftFromRequest({ orgId: org, contractId: 'c3', ctx: ctx({ requestDescription: 'Mutual NDA with Initech.' }) }, extractor([
      { key: 'governingLaw', value: 'Delaware', quote: 'governed by Delaware law' },
      { key: 'purpose', value: 'a merger', quote: 'to discuss a merger' },
    ]))
    expect(invented.origin!.slots[0].decidedBy).toBe('unresolved')
    expect(invented.origin!.variables.find(v => v.key === 'purpose')).toBeUndefined()
  })

  it('a rule decides when the request doesn\'t: a UK counterparty gets English law', async () => {
    const r = await draftFromRequest({ orgId: org, contractId: 'c4', ctx: ctx({ requestDescription: 'Mutual NDA with Initech Ltd of London.' }) }, extractor([
      { key: 'counterpartyCountry', value: 'gb', quote: 'Initech Ltd of London' },
    ]))
    expect(r.origin!.slots[0]).toMatchObject({ decidedBy: 'rule', variantId: law.ew, ruleId: law.ew, rule: 'Counterparty country is one of GB' })
  })
})

describe('a request that says there is no law (41: browser QA)', () => {
  it('is not read as asking for the law "no law": the choice stays open, with no request words for it', async () => {
    const r = await draftFromRequest({
      orgId: org, contractId: 'c-nolaw',
      ctx: ctx({ requestTitle: 'QA NDA no law', requestDescription: 'Mutual NDA with Initech for a partnership.', extractedTerms: { governingLaw: 'no law' } }),
    }, extractor([{ key: 'governingLaw', value: 'no law', quote: 'QA NDA no law' }]))
    expect(r.origin!.slots[0]).toMatchObject({ decidedBy: 'unresolved' })
    expect(r.origin!.slots[0].evidence).toBeFalsy()
    expect(JSON.stringify(r.origin)).not.toContain('no law')
  })
})

describe('deterministic choices', () => {
  it('the same request drafted twice has the same template and variants', async () => {
    const a = await draftFromRequest({ orgId: org, contractId: 'c5', ctx: ctx({ extractedTerms: { governingLaw: 'New York' } }) }, extractor())
    const b = await draftFromRequest({ orgId: org, contractId: 'c6', ctx: ctx({ extractedTerms: { governingLaw: 'New York' } }) }, extractor())
    expect(b.usedTemplateId).toBe(a.usedTemplateId)
    expect(b.origin!.slots).toEqual(a.origin!.slots)
    expect(b.html).toBe(a.html)
  })

  it('the assistant and the request path pick the same template, and refuse alike when the user must pick', async () => {
    const assistant = await planDraft({ orgId: org, userMessage: 'Draft an NDA with Initech', contractType: 'NDA', counterpartyName: 'Initech' })
    const request = await draftFromRequest({ orgId: org, contractId: 'c7', ctx: ctx() }, extractor())
    expect(assistant.ok && assistant.templateId).toBe(request.usedTemplateId)

    await prisma.template.update({ where: { id: mutual }, data: { isDefaultForType: false } })
    try {
      expect(await planDraft({ orgId: org, userMessage: 'Draft an NDA', contractType: 'NDA' })).toMatchObject({ ok: false, error: 'TEMPLATE_CHOICE_NEEDED' })
      await expect(draftFromRequest({ orgId: org, contractId: 'c8', ctx: ctx() }, extractor())).rejects.toThrow('TEMPLATE_CHOICE_NEEDED')
      // The requester's pick decides it.
      const picked = await draftFromRequest({ orgId: org, contractId: 'c9', ctx: ctx({ templateId: oneWay }) }, extractor())
      expect(picked).toMatchObject({ usedTemplateId: oneWay, origin: { templateDecidedBy: 'explicit' } })
    } finally {
      await prisma.template.update({ where: { id: mutual }, data: { isDefaultForType: true } })
    }
  })
})

describe('no law named, no rule, no default', () => {
  it('leaves a choice blank, holds the draft back, and takes the choice in the Origin panel', async () => {
    const result = await draftFromRequest({ orgId: org, contractId: 'c10', ctx: ctx({ requestDescription: 'Mutual NDA with Initech for a partnership.' }) }, extractor([
      { key: 'purpose', value: 'a partnership', quote: 'for a partnership' },
    ]))
    expect(result.origin!.slots[0]).toMatchObject({ decidedBy: 'unresolved', options: [{ id: law.ny, label: 'New York' }, { id: law.ew, label: 'England and Wales' }, { id: law.de, label: 'Delaware' }] })
    expect(result.html).toContain('[[Choose governing law: New York · England and Wales · Delaware]]')

    const id = await makeContract(org, user, { title: 'Initech NDA', type: 'NDA', status: 'APPROVED' })
    await saveDraftVersion({ contractId: id, orgId: org, userId: user, result, changeNote: 'AI-generated first draft', source: 'request' })
    const meta = (await prisma.contract.findUniqueOrThrow({ where: { id } })).metadata as { _origin?: { templateId: string } }
    expect(meta._origin?.templateId).toBe(mutual)
    const drafted = await prisma.auditEvent.findFirst({ where: { orgId: org, resourceId: id, action: 'CONTRACT_DRAFTED' } })
    expect((drafted?.metadata as { origin?: { slots: unknown[] } }).origin?.slots).toHaveLength(1)

    expect(await openChoices(id)).toEqual([{ key: expect.stringMatching(/^slot_/), label: 'Governing Law', slot: law.id }])
    const send = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/send-for-signature`, headers: auth(org, ['ADMIN'], user), payload: { signers: [{ name: 'Pat', email: 'pat@cp.test' }] } })
    expect(send.statusCode).toBe(409)
    expect(send.json().detail).toBe('1 choice is still open in the draft (Governing Law). Choose it in the Origin panel before sending it for signature.')

    const origin = await app.inject({ method: 'GET', url: `/api/v1/contracts/${id}/origin`, headers: auth(org, ['ADMIN'], user) })
    expect(origin.json()).toMatchObject({ origin: { templateId: mutual, slots: [{ decidedBy: 'unresolved' }] }, template: { id: mutual, name: 'Mutual NDA', latestVersion: 1 } })

    const wrong = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/origin/slots/${law.id}`, headers: auth(org, ['ADMIN'], user), payload: { variantId: 'not-an-option' } })
    expect(wrong.statusCode).toBe(422)
    const chose = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/origin/slots/${law.id}`, headers: auth(org, ['ADMIN'], user), payload: { variantId: law.ny } })
    expect(chose.statusCode).toBe(200)
    expect(chose.json().origin.slots[0]).toMatchObject({ decidedBy: 'user', variantId: law.ny })
    const v = await prisma.contractVersion.findFirstOrThrow({ where: { id: chose.json().versionId } })
    expect(v.htmlContent).toContain('governed by the laws of New York')
    expect(v.htmlContent).not.toContain('[[Choose')
    // Governing law is chosen; the venue its words name is the next blank to fill.
    expect((await openChoices(id)).map(c => c.key)).toEqual(['venueLocation'])
    expect(await prisma.auditEvent.count({ where: { orgId: org, resourceId: id, action: 'CLAUSE_CHOICE_MADE' } })).toBe(1)
    // Made once: the blank is gone.
    const again = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/origin/slots/${law.id}`, headers: auth(org, ['ADMIN'], user), payload: { variantId: law.de } })
    expect(again.statusCode).toBe(409)
  })
})

describe('the request page', () => {
  async function request(description: string, extractedTerms: Record<string, unknown> = {}) {
    return (await prisma.contractRequest.create({
      data: {
        orgId: org, title: 'NDA with Initech', type: 'NDA', description, requestedById: user, status: 'SUBMITTED', counterpartyName: 'Initech',
        metadata: { _aiClassification: { contractType: 'NDA', extractedTerms } } as never,
      },
    })).id
  }
  const plan = (id: string) => app.inject({ method: 'GET', url: `/api/v1/requests/${id}/draft-plan`, headers: auth(org, ['ADMIN'], user) }).then(r => r.json())
  const choose = (id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/v1/requests/${id}/draft-choices`, headers: auth(org, ['ADMIN'], user), payload: payload as object })

  it('shows the template and each clause choice, decided or to make, before drafting', async () => {
    const decided = await plan(await request(ASK, { governingLaw: 'New York' }))
    expect(decided).toMatchObject({ drafted: true, template: { id: mutual, decidedBy: 'default_for_type' }, openChoices: 0 })
    expect(decided.slots[0]).toMatchObject({ decidedBy: 'request_value', variantLabel: 'New York', evidence: { quote: 'It should be governed by New York law.' } })
    expect(decided.templates.map((t: { id: string }) => t.id).sort()).toEqual([mutual, oneWay].sort())

    const open = await plan(await request('Mutual NDA with Initech.'))
    expect(open).toMatchObject({ openChoices: 1, slots: [{ decidedBy: 'unresolved' }] })
  })

  it('takes the requester\'s picks, which drafting uses before any rule', async () => {
    const id = await request('Mutual NDA with Initech.')
    expect((await choose(id, { slots: { [law.id]: 'nope' } })).statusCode).toBe(422)
    expect((await choose(id, { slots: { [law.id]: law.de } })).statusCode).toBe(200)
    expect((await plan(id)).slots[0]).toMatchObject({ decidedBy: 'user', variantId: law.de })
    // A different template starts the clause choices again.
    expect((await choose(id, { templateId: oneWay })).json().choices).toEqual({ templateId: oneWay, slots: {} })

    await choose(id, { slots: { [law.id]: law.ew } })
    const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${id}/convert`, headers: auth(org, ['ADMIN'], user) })
    expect(res.statusCode).toBe(201)
    expect(queued.find(q => q.name === 'draft-contract')?.data).toMatchObject({ templateId: oneWay, slotChoices: { [law.id]: law.ew } })
  })

  it('convert asks for a template first when the rule can\'t choose one', async () => {
    await prisma.template.update({ where: { id: mutual }, data: { isDefaultForType: false } })
    try {
      const id = await request('Mutual NDA with Initech.')
      const res = await app.inject({ method: 'POST', url: `/api/v1/requests/${id}/convert`, headers: auth(org, ['ADMIN'], user) })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'TEMPLATE_CHOICE_NEEDED' })
      expect(queued).toEqual([])
      expect((await prisma.contractRequest.findUniqueOrThrow({ where: { id } })).status).toBe('SUBMITTED')
    } finally {
      await prisma.template.update({ where: { id: mutual }, data: { isDefaultForType: true } })
    }
  })

  it('another org can\'t read the plan or pick for it', async () => {
    const id = await request('Mutual NDA with Initech.')
    const other = await makeOrg('Request Drafting Other Org')
    const otherUser = await makeUser(other)
    expect((await app.inject({ method: 'GET', url: `/api/v1/requests/${id}/draft-plan`, headers: auth(other, ['ADMIN'], otherUser) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: `/api/v1/requests/${id}/draft-choices`, headers: auth(other, ['ADMIN'], otherUser), payload: { templateId: mutual } })).statusCode).toBe(404)
  })
})
