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
import { PrismaClient } from '@prisma/client'
import { DEMO_ORG_SLUG } from '../src/lib/demo-workspace.js'

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

// Structured rule sample: cap type, consequential-damages carve-out, the
// liability cap itself. The evaluator walks `must_have[]` over the clause
// text and checks `bounds[liability_cap_months]` against any "N months of
// fees" pattern it can spot.
const LIABILITY_RULES = {
  must_have: [
    {
      id: 'lol.mutual_cap',
      description: 'Liability cap must apply MUTUALLY (both parties).',
      check: 'contains',
      value: 'mutual',
      severity: 'high',
    },
    {
      id: 'lol.consequential_damages_carveout',
      description: 'Must exclude consequential / indirect / special damages for both sides.',
      check: 'contains',
      value: 'consequential',
      severity: 'high',
    },
    {
      id: 'lol.cap_is_stated',
      description: 'A specific liability cap amount or multiple must be stated.',
      check: 'regex',
      value: '\\b(?:\\$[\\d,]+|\\d+\\s*(?:months?|years?|x)\\b)',
      severity: 'walkaway',
    },
  ],
  must_not: [
    {
      id: 'lol.uncapped',
      description: 'Must NOT contain "unlimited" or "uncapped" liability language.',
      check: 'contains',
      value: 'unlimited',
      severity: 'walkaway',
    },
    {
      id: 'lol.uncapped_2',
      description: 'Must NOT contain "uncapped" liability language.',
      check: 'contains',
      value: 'uncapped',
      severity: 'walkaway',
    },
  ],
  bounds: {
    liability_cap_months: {
      min: 6,
      max: 24,
      units: 'months of fees',
      severity: 'high',
      description: 'Cap should be 6-24 months of fees. >24 months = off-market.',
    },
    cap_multiplier_of_annual: {
      max: 3,
      units: 'x annual contract value',
      severity: 'walkaway',
      description: 'Any cap > 3× annual contract value → escalate to General Counsel.',
    },
  },
  variables: [
    { key: 'cap_amount', type: 'string', required: true },
    { key: 'cap_unit',   type: 'string', required: true },
  ],
}

const isCli = import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  seedPlaybookRules(p)
    .then(async () => { console.log('Done.'); await p.$disconnect() })
    .catch(async e => { console.error(e); await p.$disconnect(); process.exit(1) })
}
