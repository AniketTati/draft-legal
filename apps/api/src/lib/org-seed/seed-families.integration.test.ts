/**
 * docs/41 Part 1 — a freshly seeded org drafts by rule out of the box:
 * governing law is a clause slot over the seeded Governing Law family (no
 * default: the request names it or the draft asks), each type with several
 * templates has a default, every published template has a snapshot, and the
 * seeded NDA no longer contradicts the seeded playbook.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeOrg, makeUser, cleanupAll, closeApp, prisma } from '../../test-support/helpers.js'
import { seedOrgDefaults } from './seed.js'
import { planDraft } from '../draft-plan.js'

let org: string

beforeAll(async () => {
  org = await makeOrg('Seeded Families Org')
  const admin = await makeUser(org)
  await seedOrgDefaults(org, 'seeded-families', admin)
}, 120_000)

afterAll(async () => {
  await cleanupAll()
  await closeApp()
})

describe('a freshly seeded org', () => {
  it('has the seeded clause families, Governing Law without a default', async () => {
    const families = await prisma.clauseFamily.findMany({ where: { orgId: org }, include: { variants: true }, orderBy: { name: 'asc' } })
    expect(families.map(f => f.name)).toEqual(['Confidentiality Term', 'Governing Law', 'Liability Cap', 'Payment Terms'])
    const law = families.find(f => f.name === 'Governing Law')!
    expect(law.requestKey).toBe('governingLaw')
    expect(law.variants.map(v => v.variantLabel).sort()).toEqual(['Delaware', 'England and Wales', 'New York'])
    expect(law.variants.some(v => v.isFamilyDefault)).toBe(false)
    // Every library clause has its words as version 1.
    const items = await prisma.clauseLibraryItem.count({ where: { orgId: org } })
    expect(await prisma.clauseLibraryVersion.count({ where: { orgId: org } })).toBe(items)
  })

  it('slots governing law in the seeded templates, publishes them, and has one default per type', async () => {
    const nda = await prisma.template.findFirstOrThrow({ where: { orgId: org, name: 'Mutual Non-Disclosure Agreement' }, include: { sections: { orderBy: { sortOrder: 'asc' } } } })
    expect(nda.sections.find(s => s.title === 'Governing Law')?.slotFamilyId).toBeTruthy()
    expect(nda.sections.find(s => s.title === 'Jurisdiction and Venue')?.content).toContain('{{venueLocation}}')
    expect(await prisma.templateSection.count({ where: { template: { orgId: org }, content: { contains: '{{governingLaw}}' } } })).toBe(0)
    expect(await prisma.template.count({ where: { orgId: org, isPublished: true, publishedVersionId: null } })).toBe(0)
    const defaults = await prisma.template.findMany({ where: { orgId: org, isDefaultForType: true }, select: { name: true, contractType: true }, orderBy: { contractType: 'asc' } })
    expect(defaults).toEqual([
      { name: 'Master Services Agreement (Buy-Side)', contractType: 'MSA' },
      { name: 'Mutual Non-Disclosure Agreement', contractType: 'NDA' },
      { name: 'Statement of Work (Generic)', contractType: 'SOW' },
      { name: 'Mutual Termination Letter', contractType: 'Termination' },
    ])
  })

  it('the seeded NDAs pass lint against the seeded playbook', async () => {
    const versions = await prisma.templateVersion.findMany({ where: { orgId: org, template: { contractType: 'NDA' } }, select: { lint: true, template: { select: { name: true } } } })
    for (const v of versions) expect({ name: v.template.name, lint: v.lint }).toEqual({ name: v.template.name, lint: [] })
  })

  it('drafts an NDA with New York law when asked, and asks when not', async () => {
    const asked = await planDraft({ orgId: org, userMessage: 'NDA with Initech under New York law', contractType: 'NDA', counterpartyName: 'Initech', governingLaw: 'New York' })
    expect(asked.ok && asked.templateName).toBe('Mutual Non-Disclosure Agreement')
    expect(asked.ok && asked.origin.slots[0]).toMatchObject({ familyName: 'Governing Law', decidedBy: 'request_value', variantLabel: 'New York' })
    expect(asked.ok && asked.html).toContain('the laws of the State of New York')
    const silent = await planDraft({ orgId: org, userMessage: 'NDA with Initech', contractType: 'NDA', counterpartyName: 'Initech' })
    expect(silent.ok && silent.origin.slots[0].decidedBy).toBe('unresolved')
    expect(silent.ok && silent.html).not.toContain('laws of the State of Delaware')
    expect(silent.ok && silent.html).toContain('[[Choose governing law: Delaware · New York · England and Wales]]')
  })
})
