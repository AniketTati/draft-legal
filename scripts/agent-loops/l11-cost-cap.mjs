#!/usr/bin/env node
/**
 * L11 — the daily cost cap fails open on every Python-side LLM call.
 *
 * A four-hop chain:
 *
 *   1. aiRouter throws CostCapExceededError when the org is over cap.
 *   2. POST /resolve special-cases only NoProviderAvailable (503) and sends
 *      everything else to `500 Internal error`.
 *   3. router.py calls raise_for_status(), which raises on the 500.
 *   4. `except Exception:` logs a warning and falls through to
 *      _platform_resolve(), which reads the platform key out of the agents
 *      service's own env. THE CALL PROCEEDS.
 *
 * So being over the cap is indistinguishable from "Node is unreachable", and
 * the designed response to that is "bill the platform key anyway".
 *
 * The same fallback silently defeats BYOK: an org with its own key that hits
 * ANY /resolve failure gets the platform key, so we pay and their tier override
 * is ignored. The docstring in router.py shows the author reasoned about
 * exactly this — "which is precisely the BYOK bypass, wearing a different hat"
 * — but guarded only the case where the URL/secret are unset, not the case
 * where the call fails.
 *
 * The Node proxy gates /agent/chat per HTTP request, which is why nobody
 * noticed. But one turn is up to seven LLM calls.
 *
 * Run BEFORE: over-cap resolves as 500, and the Python router bills the
 *             platform key anyway.
 * Run AFTER:  over-cap is a distinct status the router refuses to paper over.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { login, internal, db, check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

const routerPy = fs.readFileSync(`${REPO}/apps/agents/app/router.py`, 'utf8')
const internalTs = fs.readFileSync(`${REPO}/apps/api/src/routes/internal-ai.ts`, 'utf8')
const workerTs = fs.readFileSync(`${REPO}/apps/api/src/workers/agent.worker.ts`, 'utf8')

// ─── 1. Over-cap must be distinguishable from infra failure ────────────────

section('1. The cap has its own status code')
{
  check('/resolve special-cases CostCapExceededError',
    /CostCapExceededError/.test(internalTs),
    'it falls into the generic 500 branch, so "over budget" and "Node is broken" look identical to the caller')

  check('the cap maps to 429, not 500',
    /CostCapExceededError[\s\S]{0,400}?status\(429\)/.test(internalTs),
    'a 5xx invites a retry or a fallback; 429 says stop')
}

// ─── 2. The Python router must not paper over it ───────────────────────────

section('2. The router refuses to bill the platform key when we are over cap')
{
  check('router.py distinguishes a cap refusal from unreachable infra',
    /CostCapExceeded|429/.test(routerPy),
    'its `except Exception` treats every failure as transient infra and falls through to _platform_resolve()')

  // Assert the HANDLER, not the class definition. A looser version of this
  // searched from the first mention of CostCapExceeded — which is now the class
  // docstring — and reported a correct fix as missing.
  check('the except chain re-raises a cap refusal before the blanket handler',
    /except CostCapExceeded:[\s\S]{0,600}?raise\b/.test(routerPy),
    'the blanket `except Exception` falls through to _platform_resolve(), which bills the platform key for the call the cap just declined')

  check('a 429 from /resolve is translated, not passed to raise_for_status',
    /status_code\s*==\s*429[\s\S]{0,400}?raise CostCapExceeded/.test(routerPy),
    'raise_for_status turns it into a generic HTTPStatusError the blanket handler treats as flaky infra')
}

// ─── 3. The behaviour, end to end ──────────────────────────────────────────

section('3. Over-cap actually refuses')
{
  // The cap lives on OrgAiSettings (dailyCostCapUsd / capPolicy), read through
  // a 30s Redis cache — an earlier version of this probe guessed fields on
  // Organization, found nothing, and soft-passed while asserting nothing.
  const prev = await prisma.orgAiSettings.findUnique({
    where: { orgId }, select: { dailyCostCapUsd: true, capPolicy: true },
  })

  // A cap of zero under `block` puts the org over budget immediately, with no
  // tokens spent.
  await prisma.orgAiSettings.upsert({
    where:  { orgId },
    update: { dailyCostCapUsd: 0, capPolicy: 'block' },
    create: { orgId, dailyCostCapUsd: 0, capPolicy: 'block' },
  })
  // resolveCap caches for 30s; clear it so the probe sees the new value.
  try {
    execFileSync('docker', ['exec', 'clm_redis', 'redis-cli', 'DEL', `cost-cap-config:${orgId}`],
      { stdio: 'ignore', timeout: 8000 })
  } catch { /* best effort; the upsert still lands within 30s */ }

  const res = await internal('/resolve', { orgId, tier: 'default' }, orgId)
  check('over-cap resolve is refused with 429', res.status === 429,
    `status ${res.status} — a 500 is what makes the Python router treat this as flaky infra and fall back to the platform key`)

  // Restore.
  if (prev) {
    await prisma.orgAiSettings.update({
      where: { orgId },
      data: { dailyCostCapUsd: prev.dailyCostCapUsd, capPolicy: prev.capPolicy },
    })
  } else {
    await prisma.orgAiSettings.delete({ where: { orgId } }).catch(() => {})
  }
  try {
    execFileSync('docker', ['exec', 'clm_redis', 'redis-cli', 'DEL', `cost-cap-config:${orgId}`],
      { stdio: 'ignore', timeout: 8000 })
  } catch { /* */ }
}

// ─── 4. The background pipeline is accounted for at all ────────────────────

section('4. Worker spend reaches the usage rollup')
{
  // Nine job types call the agents service directly. Their spend never reaches
  // OrgUsageDaily, so the admin usage panel W0-6 fixed under-reports by the
  // entire background pipeline.
  const accounted = /recordUsage|recordCost|assertCostCapNotExceeded/.test(workerTs)
  check('agent.worker.ts participates in cost accounting', accounted,
    accounted ? 'referenced' : 'zero references to costCap/recordUsage — every background AI job is invisible to the cap AND to the usage panel')
}

await prisma.$disconnect()
report('L11 cost cap')
