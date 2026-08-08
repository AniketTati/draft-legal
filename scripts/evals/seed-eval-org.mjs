#!/usr/bin/env node
/**
 * Seed the dedicated eval org — docs/37 E8.
 *
 * A tier-3 run makes real model calls, and today an eval run has no identity at
 * any layer. Three things follow from that, all verified against the code:
 *
 *   1. The daily cost cap defaults to $50/day with policy `block` for an org
 *      with no OrgAiSettings row — so a fresh org does not opt OUT of the cap,
 *      it opts IN. And since docs/36 L11 the cap fails CLOSED, so a breach
 *      kills the run mid-suite and every case after it misreports as "runner
 *      raised" rather than as a model regression.
 *
 *   2. Running under a real customer org SPENDS THAT CUSTOMER'S BYOK KEY. BYOK
 *      is returned before assertCostCapNotExceeded is ever reached, so the cap
 *      cannot stop it. This is the one failure here that costs someone else
 *      money.
 *
 *   3. No caller passes isByok, so recordUsage still increments the PLATFORM
 *      counter — the eval would spend the customer's budget and fill ours.
 *
 * So the eval org is defined by what it must NOT have: no OrgAiKey, ever.
 * Idempotent; safe to re-run.
 *
 *   node scripts/evals/seed-eval-org.mjs
 */
import { db } from '../week-zero/lib/harness.mjs'

const prisma = db()
const NAME = 'draftLegal Evals'
const CAP_USD = Number(process.env.EVAL_DAILY_CAP_USD ?? 25)

let org = await prisma.organization.findFirst({ where: { name: NAME }, select: { id: true } })
if (!org) {
  org = await prisma.organization.create({ data: { name: NAME, slug: 'draftlegal-evals' }, select: { id: true } })
  console.log(`created org ${org.id}`)
} else {
  console.log(`org exists ${org.id}`)
}

// An explicit settings row. Leaving it absent would inherit the $50/day block
// default, which is the trap this script exists to avoid.
const existing = await prisma.orgAiSettings.findFirst({ where: { orgId: org.id }, select: { id: true } })
if (existing) {
  await prisma.orgAiSettings.update({
    where: { id: existing.id },
    // 'warn' rather than 'block': a suite that dies halfway through reports
    // every later case as a failure of the code under test, which is worse
    // than an overspend you can see in the log and act on deliberately.
    data: { dailyCostCapUsd: CAP_USD, capPolicy: 'warn' },
  })
} else {
  await prisma.orgAiSettings.create({
    data: { orgId: org.id, dailyCostCapUsd: CAP_USD, capPolicy: 'warn' },
  })
}
console.log(`cap: $${CAP_USD}/day, policy=warn`)

// The invariant that matters. A BYOK key on this org would mean the suite
// silently spends a real provider account, and the cost cap cannot stop it.
const byok = await prisma.orgAiKey.findMany({ where: { orgId: org.id }, select: { id: true } }).catch(() => [])
if (byok.length) {
  console.error(`\nREFUSING: the eval org has ${byok.length} OrgAiKey row(s).`)
  console.error('An eval run under this org would spend a real provider account, and BYOK is')
  console.error('returned before the cost cap is checked, so nothing would stop it. Remove them.')
  process.exit(1)
}

console.log(`\nEVAL_ORG_ID=${org.id}`)
console.log('Set that as a repo secret for the nightly tier-3 workflow.')
await prisma.$disconnect()
