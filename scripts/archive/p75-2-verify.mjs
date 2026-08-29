#!/usr/bin/env node
/**
 * P7.5.2 verify — Per-tenant daily cost cap.
 *
 * Existing module from D.0.5 already covers Redis-backed counter +
 * resolveCap + assertCostCapNotExceeded. P7.5 adds:
 *   - estimateCostUsd helper for surfaces where exact LLM cost is
 *     not echoed back from upstream (Python services).
 *   - Wiring into the Python-bound LLM surfaces (extract_obligations,
 *     renewal_advice) so over-cap orgs get a 429 instead of silently
 *     consuming budget.
 *
 * Checks:
 *   (1) Vitest unit tests pass for the estimator
 *   (2) costCap.ts exports estimateCostUsd
 *   (3) contracts.ts gates extract_obligations + renewal_advice with
 *       assertCostCapNotExceeded + 429-on-throw
 *   (4) recordCost called after each LLM-bound call
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

console.log('\n=== (1) costCap unit tests ===')
const r = spawnSync('pnpm', ['vitest', 'run', 'src/lib/costCap.test.ts'], {
  cwd: path.join(REPO_ROOT, 'apps/api'),
  encoding: 'utf8',
})
const out = (r.stdout ?? '') + (r.stderr ?? '')
check(r.status === 0, `vitest exits 0`)
const passLine = out.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
check(passLine && passLine[1] === passLine[2], `tests pass ${passLine?.[0] ?? ''}`)

console.log('\n=== (2) estimateCostUsd exported ===')
const src = fs.readFileSync(path.join(REPO_ROOT, 'apps/api/src/lib/costCap.ts'), 'utf8')
check(/export function estimateCostUsd/.test(src), `estimateCostUsd export present`)

console.log('\n=== (3) Cost cap gates LLM-bound surfaces ===')
const ct = fs.readFileSync(path.join(REPO_ROOT, 'apps/api/src/routes/contracts.ts'), 'utf8')
const gateCount = (ct.match(/assertCostCapNotExceeded/g) ?? []).length
check(gateCount >= 2, `assertCostCapNotExceeded called ≥2 times in contracts.ts (got ${gateCount})`)
check(/CostCapExceededError/.test(ct), `CostCapExceededError handled with 429`)
check(/429/.test(ct) && /retryAfter/.test(ct), `429 + retryAfter returned to client`)

console.log('\n=== (4) recordCost called after LLM responses ===')
const recordCalls = (ct.match(/recordCost\(orgId, estimateCostUsd/g) ?? []).length
check(recordCalls >= 2, `recordCost called ≥2 times after LLM responses (got ${recordCalls})`)

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All P7.5.2 cost-cap checks pass')
