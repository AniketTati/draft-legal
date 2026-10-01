/**
 * set-template-org-default.ts — docs/41 P0.4: make a template default the org's own.
 *
 * Drafting no longer fills a legal choice (governing law, venue…) from a
 * template's default unless the org marked that default as its own
 * (`orgDefault` on the variable). A demo org whose drafts are meant to come
 * out filled (docs/41 §6.12 — the GSK and CBRE demos) runs this once.
 *
 * Usage (from apps/api):
 *   npx tsx --env-file=../../.env scripts/set-template-org-default.ts --org=<orgId> --key=governingLaw
 *   npx tsx --env-file=../../.env scripts/set-template-org-default.ts --org=<orgId> --key=governingLaw --value=Delaware --apply
 *
 * --key: the variable key (every template of the org that has it);
 * --value: the default to set (else the template's own default is kept);
 * dry run unless --apply.
 *
 * docs/41 Part 1 — where the law is a clause slot, the default is the clause
 * family's: with --value, the family whose request key is --key (Governing
 * Law) gets the variant named --value as its default, and the templates that
 * slot it are published again so drafts pick it up.
 */
import { matchKey } from '@clm/types'
import { prisma } from '../src/lib/prisma.js'
import { publishTemplate } from '../src/lib/template-publish.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const orgId = flag('org')
const key = flag('key')
const value = flag('value')
const apply = args.includes('--apply')

async function main() {
  if (!orgId || !key) throw new Error('--org=<orgId> and --key=<variable key> are required')
  const templates = await prisma.template.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, variables: true } })
  let changed = 0
  for (const t of templates) {
    const vars = Array.isArray(t.variables) ? t.variables as Array<Record<string, unknown>> : []
    const i = vars.findIndex(v => v.key === key)
    if (i < 0) continue
    const next = { ...vars[i], orgDefault: true, ...(value !== undefined && { defaultValue: value }) }
    if (next.defaultValue === undefined || next.defaultValue === '') {
      console.log(`  ${t.name}: ${key} has no default — pass --value`)
      continue
    }
    console.log(`  ${t.name}: ${key} = ${String(next.defaultValue)} (org default)${apply ? '' : ' — dry run'}`)
    if (apply) {
      const updated = [...vars]
      updated[i] = next
      await prisma.template.update({ where: { id: t.id }, data: { variables: updated as never } })
    }
    changed++
  }
  console.log(`${changed} template${changed === 1 ? '' : 's'}${apply ? ' updated' : ' would be updated (pass --apply)'}.`)

  if (value === undefined) return
  const families = await prisma.clauseFamily.findMany({
    where: { orgId, deletedAt: null, requestKey: key },
    include: { variants: { where: { deletedAt: null, isApproved: true } }, slots: { where: { template: { deletedAt: null, isPublished: true } }, select: { templateId: true } } },
  })
  for (const f of families) {
    const v = f.variants.find(x => [x.variantLabel ?? x.title, ...x.matchValues].some(n => matchKey(n) === matchKey(value)))
    if (!v) { console.log(`  ${f.name}: no approved variant for ${value}`); continue }
    console.log(`  ${f.name}: default ${v.variantLabel ?? v.title}${apply ? '' : ' — dry run'}`)
    if (!apply) continue
    await prisma.$transaction([
      prisma.clauseLibraryItem.updateMany({ where: { orgId, familyId: f.id, isFamilyDefault: true, NOT: { id: v.id } }, data: { isFamilyDefault: false } }),
      prisma.clauseLibraryItem.update({ where: { id: v.id }, data: { isFamilyDefault: true } }),
    ])
    const admin = await prisma.user.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    for (const templateId of new Set(f.slots.map(s => s.templateId))) {
      if (admin) await publishTemplate(orgId, templateId, admin.id)
    }
  }
}

main()
  .catch(err => { console.error(err.message ?? err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
