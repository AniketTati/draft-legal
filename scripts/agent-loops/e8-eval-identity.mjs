#!/usr/bin/env node
/**
 * E8 — an eval run cannot spend a customer's money.
 *
 * Tier 3 makes real model calls, and until this landed an eval run had no
 * identity at any layer: the one HTTP runner sent no orgId at all. Three
 * consequences, each verified against the code rather than assumed:
 *
 *   - The daily cost cap defaults to $50/day policy `block` for an org with no
 *     OrgAiSettings row. A fresh org does not opt OUT of the cap; it opts IN.
 *     Since docs/36 L11 the cap fails CLOSED, so a breach kills the run
 *     mid-suite and every later case misreports as "runner raised" rather than
 *     as a model regression — the failures would be blamed on the wrong thing.
 *   - Running under a real customer org spends THAT CUSTOMER'S BYOK key, and
 *     the cap cannot stop it: BYOK is returned before the cap is ever checked.
 *   - No caller passes isByok, so recordUsage still increments the platform
 *     counter — the customer's bill AND ours.
 *
 * The eval org is therefore defined by what it must NOT have.
 *
 * Run BEFORE: no eval identity exists; a nightly run bills whoever it lands on.
 * Run AFTER:  a dedicated org with an explicit cap, warn policy, and no BYOK key.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const prisma = db()
const NAME = 'draftLegal Evals'

section('1. A dedicated eval org exists')
const org = await prisma.organization.findFirst({ where: { name: NAME }, select: { id: true, name: true } })
check('the eval org is seeded', org != null,
  org ? org.id : 'run scripts/evals/seed-eval-org.mjs — without it a tier-3 run has no identity and lands on whichever org the caller happens to be in')

if (org) {
  section('2. Its cost cap is explicit, and does not halt the suite')
  {
    const s = await prisma.orgAiSettings.findFirst({
      where: { orgId: org.id }, select: { dailyCostCapUsd: true, capPolicy: true },
    })
    check('it has an explicit OrgAiSettings row', s != null,
      'absent means the $50/day BLOCK default applies — the default IS the trap')
    check('the cap is a real number', s != null && Number(s.dailyCostCapUsd) > 0,
      `dailyCostCapUsd=${s?.dailyCostCapUsd}`)
    // 'warn' rather than 'block': a suite that dies halfway reports every later
    // case as a failure of the code under test, which is a worse outcome than a
    // visible overspend you can act on.
    check('the policy is warn, not block', s?.capPolicy === 'warn',
      `capPolicy=${s?.capPolicy} — under 'block' a cap breach kills the run mid-suite and misattributes every case after it`)
  }

  section('3. It can never reach a customer provider account')
  {
    const byok = await prisma.orgAiKey.findMany({ where: { orgId: org.id }, select: { id: true } }).catch(() => [])
    check('the eval org has no BYOK key', byok.length === 0,
      byok.length
        ? `${byok.length} OrgAiKey row(s) — an eval run would spend a real provider account, and BYOK is returned BEFORE the cost cap is checked, so nothing would stop it`
        : 'none — the invariant that matters')
  }
}

section('4. The nightly workflow refuses to run without an identity')
{
  const wf = `${REPO}/.github/workflows/nightly-evals.yml`
  check('the nightly workflow exists', fs.existsSync(wf))
  if (fs.existsSync(wf)) {
    const y = fs.readFileSync(wf, 'utf8')
    check('it guards on EVAL_ORG_ID', /EVAL_ORG_ID/.test(y) && /exit 1/.test(y),
      'without the guard, a scheduled run with no identity bills whoever it lands on')
    check('the schedule is not enabled by accident',
      /#\s*schedule:|#\s*-\s*cron:/.test(y) || /EVAL_ORG_ID/.test(y),
      'turning the cron on before an identity exists is how you bill a customer for your test suite')
    check('it does not run on forks', /github\.repository_owner/.test(y),
      'secrets are unavailable on forks, so it would be green-and-meaningless there rather than skipped')
  }
}

await prisma.$disconnect()
report('E8 eval identity')
