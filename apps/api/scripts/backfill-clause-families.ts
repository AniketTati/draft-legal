/**
 * backfill-clause-families.ts — docs/41 Part 1 for orgs seeded before it.
 *
 * For each org (or --org=<id>):
 *   1. the seeded clause families (org-seed/universal/families.ts), made from
 *      the org's own library clauses by category and title; the seed's new
 *      variant (Governing Law — England and Wales) added where missing;
 *   2. each seeded template's governing-law section, if the org never changed
 *      it, becomes a clause slot over Governing Law (what followed the
 *      sentence — venue, jury waiver — stays, in its own section);
 *   3. the seeded NDA's confidentiality term, if still the seed's old 3 years
 *      (the playbook's fallback), set to the preferred 5;
 *   4. a default template for NDA, MSA, SOW and Termination where the org has
 *      none, as a fresh org gets;
 *   5. every published template snapshotted (published again) so drafts pin it.
 * No family gets a default: a governing law nobody named stays a choice to
 * make. For a demo org that should fill one, run
 * scripts/set-template-org-default.ts --key=governingLaw --value=Delaware.
 *
 * Usage (from apps/api):
 *   npx tsx --env-file=../../.env scripts/backfill-clause-families.ts            # dry run, every org
 *   npx tsx --env-file=../../.env scripts/backfill-clause-families.ts --org=<id> --apply
 */
import { prisma } from '../src/lib/prisma.js'
import { UNIVERSAL_CATEGORIES } from '../src/lib/org-seed/universal/categories.js'
import { UNIVERSAL_CLAUSES } from '../src/lib/org-seed/universal/clauses.js'
import { UNIVERSAL_FAMILIES, GOVERNING_LAW_FAMILY } from '../src/lib/org-seed/universal/families.js'
import { UNIVERSAL_TEMPLATES, UNIVERSAL_TEMPLATES_LITERAL } from '../src/lib/org-seed/universal/templates.js'
import { seedClauseFamilies, ensureClauseVersions } from '../src/lib/org-seed/seed.js'
import { recordClauseVersion } from '../src/lib/clause-library-versions.js'
import { publishTemplate } from '../src/lib/template-publish.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const apply = args.includes('--apply')
const onlyOrg = flag('org')

const OLD_NDA_TERM = '<p>Obligations continue for three (3) years from disclosure.</p>'

async function backfillOrg(orgId: string, adminId: string): Promise<string[]> {
  const did: string[] = []
  const categories = await prisma.clauseCategory.findMany({ where: { orgId }, select: { id: true, name: true } })
  const idBySlug = new Map(UNIVERSAL_CATEGORIES.flatMap(c => {
    const hit = categories.find(x => x.name === c.name)
    return hit ? [[c.slug, hit.id] as const] : []
  }))

  // 1. Missing variants of the seeded families, then the families.
  const titles = new Set(UNIVERSAL_FAMILIES.flatMap(f => f.variants.map(v => v.title)))
  const have = new Set((await prisma.clauseLibraryItem.findMany({ where: { orgId, title: { in: [...titles] } }, select: { title: true } })).map(i => i.title))
  for (const c of UNIVERSAL_CLAUSES.filter(c => titles.has(c.title) && !have.has(c.title))) {
    const categoryId = idBySlug.get(c.categorySlug)
    if (!categoryId) continue
    did.push(`add clause “${c.title}”`)
    if (apply) {
      const item = await prisma.clauseLibraryItem.create({ data: { orgId, categoryId, title: c.title, content: c.content, tags: c.tags, riskRating: c.riskRating, isApproved: c.isApproved, createdById: adminId } })
      await recordClauseVersion(prisma, item, adminId, 'Initial version')
    }
  }
  const before = await prisma.clauseFamily.count({ where: { orgId, deletedAt: null } })
  const families = apply ? await seedClauseFamilies(orgId, adminId, idBySlug, { bump: true }) : new Map<string, string>()
  if (apply) {
    await ensureClauseVersions(orgId)
    const after = await prisma.clauseFamily.count({ where: { orgId, deletedAt: null } })
    if (after > before) did.push(`${after - before} clause famil${after - before === 1 ? 'y' : 'ies'}`)
  } else did.push('clause families from the seeded library clauses')
  const lawFamily = families.get(GOVERNING_LAW_FAMILY)
    ?? (await prisma.clauseFamily.findFirst({ where: { orgId, deletedAt: null, name: GOVERNING_LAW_FAMILY }, select: { id: true } }))?.id

  // 2–3. Seeded templates the org left as seeded.
  const templates = await prisma.template.findMany({
    where: { orgId, deletedAt: null, name: { in: UNIVERSAL_TEMPLATES_LITERAL.map(t => t.name) } },
    include: { sections: { orderBy: { sortOrder: 'asc' } } },
  })
  const changedIds = new Set<string>()
  for (const t of templates) {
    const literal = UNIVERSAL_TEMPLATES_LITERAL.find(x => x.name === t.name)!
    const slotted = UNIVERSAL_TEMPLATES.find(x => x.name === t.name)!
    let changed = false
    for (const seeded of literal.sections.filter(s => /^Governing Law/.test(s.title) && s.content.includes('{{governingLaw}}'))) {
      const row = t.sections.find(s => s.title === seeded.title && s.content === seeded.content && !s.slotFamilyId)
      if (!row) continue
      const slot = slotted.sections.find(s => s.slotFamily && s.sortOrder === seeded.sortOrder)!
      const rest = slotted.sections.find(s => s.sortOrder === seeded.sortOrder + 1)
      did.push(`${t.name}: governing law as a clause slot`)
      if (apply && lawFamily) {
        await prisma.$transaction([
          prisma.templateSection.update({ where: { id: row.id }, data: { title: slot.title, content: '', slotFamilyId: lawFamily } }),
          ...(rest ? [prisma.templateSection.create({ data: { templateId: t.id, title: rest.title, content: rest.content, sortOrder: rest.sortOrder } })] : []),
        ])
        changed = true
      }
    }
    // The seed's NDA "Term" section was its period of confidentiality; it is now
    // called that, and an NDA gains a real Term and Termination section (the
    // presence rule requires one). An org's edited wording is kept: only the
    // old seeded 3-year text is replaced.
    const period = slotted.sections.find(s => s.title === 'Period of Confidentiality')
    const termination = slotted.sections.find(s => s.title === 'Term and Termination')
    if (period && termination) {
      const term = t.sections.find(s => s.title === 'Term')
      if (term) {
        const oldText = term.content === OLD_NDA_TERM
        did.push(`${t.name}: "Term" renamed "Period of Confidentiality"${oldText ? ', confidentiality term 3 → 5 years' : ''}`)
        if (apply) {
          await prisma.templateSection.update({ where: { id: term.id }, data: { title: period.title, ...(oldText ? { content: period.content } : {}) } })
          changed = true
        }
      }
      if (!t.sections.some(s => s.title === termination.title)) {
        did.push(`${t.name}: Term and Termination section added`)
        if (apply) {
          await prisma.templateSection.create({ data: { templateId: t.id, title: termination.title, content: termination.content, sortOrder: termination.sortOrder } })
          changed = true
        }
      }
    }
    const vars = Array.isArray(t.variables) ? t.variables as Array<Record<string, unknown>> : []
    const years = vars.findIndex(v => v.key === 'confidentialityYears' && String(v.defaultValue) === '3')
    if (t.name === 'Mutual Non-Disclosure Agreement' && years >= 0) {
      did.push(`${t.name}: confidentiality term default 3 → 5 years`)
      if (apply) {
        const next = [...vars]
        next[years] = { ...next[years], defaultValue: '5' }
        await prisma.template.update({ where: { id: t.id }, data: { variables: next as never } })
        changed = true
      }
    }
    if (changed) {
      await prisma.template.update({ where: { id: t.id }, data: { version: { increment: 1 } } })
      changedIds.add(t.id)
    }
  }

  // 4. A default template per type where the org has none.
  for (const seeded of UNIVERSAL_TEMPLATES.filter(t => t.isDefaultForType)) {
    const has = await prisma.template.count({ where: { orgId, deletedAt: null, contractType: seeded.contractType, isDefaultForType: true } })
    if (has) continue
    const t = await prisma.template.findFirst({ where: { orgId, deletedAt: null, isPublished: true, name: seeded.name }, select: { id: true } })
    if (!t) continue
    did.push(`${seeded.name}: default for ${seeded.contractType}`)
    if (apply) await prisma.template.update({ where: { id: t.id }, data: { isDefaultForType: true } })
  }

  // 5. Snapshots: every published template published again (lint included).
  const published = await prisma.template.findMany({ where: { orgId, deletedAt: null, isPublished: true }, select: { id: true, publishedVersionId: true, hasUnpublishedChanges: true } })
  const toPublish = published.filter(t => !t.publishedVersionId || t.hasUnpublishedChanges || changedIds.has(t.id))
  if (toPublish.length) did.push(`publish ${toPublish.length} template snapshot${toPublish.length === 1 ? '' : 's'}`)
  if (apply) for (const t of toPublish) await publishTemplate(orgId, t.id, adminId)
  return did
}

async function main() {
  const orgs = await prisma.organization.findMany({ where: onlyOrg ? { id: onlyOrg } : {}, select: { id: true, name: true } })
  for (const org of orgs) {
    const admin = await prisma.user.findFirst({ where: { orgId: org.id, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    if (!admin) continue
    const did = await backfillOrg(org.id, admin.id)
    console.log(`${org.name}${apply ? '' : ' (dry run)'}:${did.length ? '' : ' nothing to do'}`)
    for (const d of did) console.log(`  - ${d}`)
  }
  if (!apply) console.log('Dry run. Pass --apply to write.')
}

main()
  .catch(err => { console.error(err.message ?? err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
