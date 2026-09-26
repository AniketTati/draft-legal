/**
 * Seed the demo org's PlaybookPosition rows with structured rules
 * (P1.2 / docs/28 C.2.1). Idempotent — running twice just refreshes
 * the JSON without bumping version counters.
 *
 * Today we seed the "Limitation of Liability" category because the
 * demo org already has matching ClauseCategory + contract clauses
 * (an MSA whose §9.2 exercises the bound + must-have checks). The
 * schema is general — later orgs add rules to any category/position
 * they like.
 */
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { DEMO_ORG_SLUG } from '../src/lib/demo-workspace.js'
import { LIABILITY_RULES } from '../src/lib/demo-liability-rules.js'

/** Exported helper so seed-ai-demo can call this inline. */
export async function seedPlaybookRules(
  prisma: PrismaClient,
  log: (m: string) => void = console.log,
) {
  const org = await prisma.organization.findUnique({
    where: { slug: DEMO_ORG_SLUG },
    select: { id: true },
  })
  if (!org) return log('Demo Org not found — skipping playbook rules seed')
  const liabilityCat = await prisma.clauseCategory.findFirst({
    where: { orgId: org.id, name: { equals: 'Limitation of Liability', mode: 'insensitive' } },
    select: { id: true },
  })
  if (!liabilityCat) return log('Limitation of Liability category not found — skipping')
  const positions = await prisma.playbookPosition.findMany({
    where: { orgId: org.id, clauseCategoryId: liabilityCat.id },
    select: { id: true, positionType: true },
  })
  for (const pos of positions) {
    if (pos.positionType !== 'preferred' && pos.positionType !== 'walkaway') continue
    const rules = pos.positionType === 'preferred'
      ? LIABILITY_RULES
      : { must_not: LIABILITY_RULES.must_not }
    await prisma.playbookPosition.update({
      where: { id: pos.id },
      data:  { rules },
    })
    log(`  ✓ seeded rules on ${pos.positionType} position`)
  }
}

const p = new PrismaClient()

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isCli) {
  seedPlaybookRules(p)
    .then(async () => { console.log('Done.'); await p.$disconnect() })
    .catch(async e => { console.error(e); await p.$disconnect(); process.exit(1) })
}
