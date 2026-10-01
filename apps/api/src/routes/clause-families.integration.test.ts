/**
 * docs/41 Part 1 — clause families and published template snapshots.
 *
 *   - a family's variants, with conditions and one default; each edit of a
 *     variant's words is a new, immutable version;
 *   - publishing a template pins its slots' variants: a library edit after it
 *     doesn't change a draft until the template is published again, and the
 *     template says the library moved on;
 *   - an edit after publishing is a draft revision drafts don't see;
 *   - one default template per org and type;
 *   - template lint at publish;
 *   - another org's families and templates are out of reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getApp, closeApp, makeOrg, makeUser, auth, cleanupAll, prisma, type TestApp } from '../test-support/helpers.js'
import { planDraft } from '../lib/draft-plan.js'

let app: TestApp
let org: string, user: string, other: string, otherUser: string
let category: string
const h = () => auth(org, ['ADMIN'], user)

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = h()) =>
  app.inject({ method, url: `/api/v1${url}`, headers, ...(payload !== undefined && { payload: payload as object }) })

async function family(name = `Governing Law ${Math.random().toString(36).slice(2, 7)}`) {
  const f = (await call('POST', '/clause-families', { name, categoryId: category, requestKey: 'governingLaw' })).json()
  const ny = (await call('POST', `/clause-families/${f.id}/variants`, { variantLabel: 'New York', content: '<p>Governed by New York law.</p>', matchValues: ['New York', 'NY'], isApproved: true })).json()
  const ew = (await call('POST', `/clause-families/${f.id}/variants`, {
    variantLabel: 'England and Wales', content: '<p>Governed by the laws of England and Wales.</p>', matchValues: ['England'], isApproved: true,
    condition: { op: 'in', key: 'counterparty.country', value: ['GB', 'IE'] },
  })).json()
  return { id: f.id as string, ny: ny.id as string, ew: ew.id as string }
}

async function slottedTemplate(familyId: string, name: string, contractType = 'NDA', publish = true) {
  const t = (await call('POST', '/templates', {
    name, contractType, isPublished: publish,
    sections: [
      { title: 'Purpose', sortOrder: 0, content: '<p>For {{purpose}}.</p>' },
      { title: 'Governing Law', sortOrder: 1, content: '', slotFamilyId: familyId },
    ],
  })).json()
  return t.id as string
}

beforeAll(async () => {
  app = await getApp()
  org = await makeOrg('Clause Families Org')
  user = await makeUser(org)
  other = await makeOrg('Clause Families Other Org')
  otherUser = await makeUser(other)
  category = (await prisma.clauseCategory.create({ data: { orgId: org, name: 'Dispute Resolution' } })).id
})

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a clause family', () => {
  it('holds variants, with a condition and one default, and says which it would pick', async () => {
    const f = await family()
    const res = await call('PUT', `/clause-families/${f.id}/default`, { variantId: f.ny })
    expect(res.statusCode).toBe(200)
    expect(res.json().variants.find((v: { id: string }) => v.id === f.ny).isFamilyDefault).toBe(true)
    // Moving the default: still one.
    await call('PUT', `/clause-families/${f.id}/default`, { variantId: f.ew })
    expect(await prisma.clauseLibraryItem.count({ where: { familyId: f.id, isFamilyDefault: true } })).toBe(1)

    const preview = (body: unknown) => call('POST', `/clause-families/${f.id}/preview`, body).then(r => r.json())
    expect(await preview({ requestValue: 'NY' })).toMatchObject({ decidedBy: 'request_value', variantId: f.ny })
    expect(await preview({ facts: { 'counterparty.country': 'IE' } })).toMatchObject({ decidedBy: 'rule', variantId: f.ew })
    expect(await preview({ facts: { 'counterparty.country': 'US' } })).toMatchObject({ decidedBy: 'default', variantId: f.ew })
  })

  it('refuses a malformed condition, and an unapproved default', async () => {
    const f = await family()
    const bad = await call('PATCH', `/clause-families/${f.id}/variants/${f.ny}`, { condition: { op: 'regex', key: 'x', value: '.*' } })
    expect(bad.statusCode).toBe(422)
    const draft = (await call('POST', `/clause-families/${f.id}/variants`, { variantLabel: 'Texas', content: '<p>Texas law.</p>' })).json()
    expect((await call('PUT', `/clause-families/${f.id}/default`, { variantId: draft.id })).statusCode).toBe(422)
  })

  it('a second live default in one family is refused by the database too', async () => {
    const f = await family()
    await prisma.clauseLibraryItem.update({ where: { id: f.ny }, data: { isFamilyDefault: true } })
    await expect(prisma.clauseLibraryItem.update({ where: { id: f.ew }, data: { isFamilyDefault: true } })).rejects.toThrow()
  })

  it('an edit of a variant\'s words is a new version; the old one is kept as it was', async () => {
    const f = await family()
    await call('PATCH', `/clause-families/${f.id}/variants/${f.ny}`, { content: '<p>Governed by the laws of the State of New York.</p>', changeNote: 'Spell out the State' })
    // Approving it is not a new version.
    await call('PATCH', `/clause-families/${f.id}/variants/${f.ny}`, { isApproved: true })
    const v = (await call('GET', `/clauses/${f.ny}/versions`)).json()
    expect(v.current).toBe(2)
    expect(v.data.map((x: { version: number; content: string }) => [x.version, x.content])).toEqual([
      [2, '<p>Governed by the laws of the State of New York.</p>'],
      [1, '<p>Governed by New York law.</p>'],
    ])
  })

  it('a family in use by a template can\'t be deleted', async () => {
    const f = await family()
    await slottedTemplate(f.id, 'Uses the family', 'MSA', false)
    expect((await call('DELETE', `/clause-families/${f.id}`)).statusCode).toBe(409)
  })

  it('another org\'s family and variants are out of reach', async () => {
    const f = await family()
    const theirs = auth(other, ['ADMIN'], otherUser)
    expect((await call('GET', `/clause-families/${f.id}`, undefined, theirs)).statusCode).toBe(404)
    expect((await call('PATCH', `/clause-families/${f.id}/variants/${f.ny}`, { content: 'x' }, theirs)).statusCode).toBe(404)
    expect((await call('POST', `/clause-families/${f.id}/preview`, {}, theirs)).statusCode).toBe(404)
    expect((await call('GET', '/clause-families', undefined, theirs)).json().data).toEqual([])
    // Nor can their template slot it.
    const t = await call('POST', '/templates', { name: 'Theirs', sections: [{ title: 'Law', content: '', slotFamilyId: f.id }] }, theirs)
    expect(t.statusCode).toBe(404)
  })
})

describe('publishing a template', () => {
  it('pins the slots\' variants: a later library edit waits for republishing', async () => {
    const f = await family()
    const id = await slottedTemplate(f.id, 'Pinned NDA', 'LICENSE')
    const pinned = (await call('GET', `/templates/${id}`)).json()
    expect(pinned.publishedVersion).toMatchObject({ version: 1 })
    expect(pinned.libraryChanges).toEqual([])

    // The library moves on: New York's words change (version 2).
    await call('PATCH', `/clause-families/${f.id}/variants/${f.ny}`, { content: '<p>Governed by the laws of the State of New York.</p>' })
    const plan = await planDraft({ orgId: org, userMessage: 'license', templateId: id, slotChoices: { [f.id]: f.ny } })
    expect(plan.ok && plan.html).toContain('Governed by New York law.')
    expect(plan.ok && plan.origin.slots[0]).toMatchObject({ variantId: f.ny, variantVersion: 1, decidedBy: 'user' })
    expect(plan.ok && plan.origin.templateVersion).toBe(1)

    const after = (await call('GET', `/templates/${id}`)).json()
    expect(after.libraryChanges).toEqual([expect.objectContaining({ familyId: f.id, changes: ['New York is at version 2 (this template uses version 1).'] })])

    // Republished: the new words, version 2 of the template.
    const re = await call('POST', `/templates/${id}/publish`)
    expect(re.json().version).toBe(2)
    const again = await planDraft({ orgId: org, userMessage: 'license', templateId: id, slotChoices: { [f.id]: f.ny } })
    expect(again.ok && again.html).toContain('the State of New York')
    expect(again.ok && again.origin).toMatchObject({ templateVersion: 2 })
    expect((await call('GET', `/templates/${id}`)).json().libraryChanges).toEqual([])
    expect((await call('GET', `/templates/${id}/versions`)).json().data.map((v: { version: number; current: boolean }) => [v.version, v.current])).toEqual([[2, true], [1, false]])
  })

  it('an edit after publishing is a draft revision that drafts don\'t see until republished', async () => {
    const f = await family()
    const id = await slottedTemplate(f.id, 'Revised NDA', 'LICENSE')
    await call('PUT', `/templates/${id}/sections`, { sections: [
      { title: 'Purpose', sortOrder: 0, content: '<p>Only for {{purpose}}.</p>' },
      { title: 'Governing Law', sortOrder: 1, content: '', slotFamilyId: f.id },
    ] })
    expect((await call('GET', `/templates/${id}`)).json().hasUnpublishedChanges).toBe(true)
    const plan = await planDraft({ orgId: org, userMessage: 'x', templateId: id })
    expect(plan.ok && plan.html).not.toContain('Only for')
    await call('PATCH', `/templates/${id}`, { isPublished: true })
    const t = (await call('GET', `/templates/${id}`)).json()
    expect(t.hasUnpublishedChanges).toBe(false)
    const after = await planDraft({ orgId: org, userMessage: 'x', templateId: id })
    expect(after.ok && after.html).toContain('Only for')
  })

  it('lints the template against the playbook and keeps the warnings with the version', async () => {
    const conf = await prisma.clauseCategory.create({ data: { orgId: org, name: 'Confidentiality' } })
    for (const [positionType, content] of [['preferred', '<p>5-year confidentiality term.</p>'], ['fallback', '<p>3-year confidentiality term.</p>']]) {
      await prisma.playbookPosition.create({ data: { orgId: org, clauseCategoryId: conf.id, positionType, content, createdById: user } })
    }
    const t = (await call('POST', '/templates', {
      name: 'Lint NDA', contractType: 'EMPLOYMENT',
      variables: [{ key: 'years', label: 'Years', type: 'number', defaultValue: '3' }],
      sections: [{ title: 'Term', content: '<p>Confidentiality lasts {{years}} years.</p>' }],
    })).json()
    const before = (await call('GET', `/templates/${t.id}/lint`)).json().data
    expect(before.map((w: { message: string }) => w.message)).toEqual(['Confidentiality term of 3 years is your fallback position, not your preferred one (5 years).'])
    const pub = (await call('POST', `/templates/${t.id}/publish`)).json()
    expect(pub.lint).toHaveLength(1)
    expect(pub.template.publishedVersion.lint).toEqual(pub.lint)
  })
})

describe('the default template for a contract type', () => {
  it('is one per org and type, and drafting picks it over the others', async () => {
    const f = await family()
    const a = await slottedTemplate(f.id, 'SOW A', 'SOW')
    const b = await slottedTemplate(f.id, 'SOW B', 'SOW')
    // Two published, no default: the user picks.
    const ask = await planDraft({ orgId: org, userMessage: 'a statement of work', contractType: 'SOW' })
    expect(ask).toMatchObject({ ok: false, status: 409, error: 'TEMPLATE_CHOICE_NEEDED' })

    expect((await call('PUT', `/templates/${a}/default-for-type`, { isDefault: true })).statusCode).toBe(200)
    expect((await call('PUT', `/templates/${b}/default-for-type`, { isDefault: true })).statusCode).toBe(200)
    const defaults = await prisma.template.findMany({ where: { orgId: org, contractType: 'SOW', isDefaultForType: true }, select: { id: true } })
    expect(defaults).toEqual([{ id: b }])
    // The database refuses two as well.
    await expect(prisma.template.update({ where: { id: a }, data: { isDefaultForType: true } })).rejects.toThrow()

    const picked = await planDraft({ orgId: org, userMessage: 'a statement of work', contractType: 'SOW' })
    expect(picked).toMatchObject({ ok: true, templateId: b, origin: { templateDecidedBy: 'default_for_type' } })
  })

  it('must be published and typed', async () => {
    const draft = (await call('POST', '/templates', { name: 'Unpublished', contractType: 'SOW', sections: [] })).json()
    expect((await call('PUT', `/templates/${draft.id}/default-for-type`, { isDefault: true })).statusCode).toBe(422)
    const untyped = (await call('POST', '/templates', { name: 'Untyped', isPublished: true, sections: [] })).json()
    expect((await call('PUT', `/templates/${untyped.id}/default-for-type`, { isDefault: true })).statusCode).toBe(422)
  })
})

describe('the builder\'s slot preview', () => {
  it('says which variant each slot picks for sample inputs', async () => {
    const f = await family()
    const id = await slottedTemplate(f.id, 'Preview NDA', 'PARTNERSHIP', false)
    const data = (body: unknown) => call('POST', `/templates/${id}/slot-preview`, body).then(r => r.json().data)
    expect(await data({ facts: { 'counterparty.country': 'GB' } })).toEqual([expect.objectContaining({ sectionTitle: 'Governing Law', decidedBy: 'rule', variantLabel: 'England and Wales' })])
    expect(await data({ requestValues: { governingLaw: 'New York' } })).toEqual([expect.objectContaining({ decidedBy: 'request_value', variantLabel: 'New York' })])
    expect(await data({})).toEqual([expect.objectContaining({ decidedBy: 'unresolved' })])
  })
})
