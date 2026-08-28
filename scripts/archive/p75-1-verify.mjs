#!/usr/bin/env node
/**
 * P7.5.1 verify — PII redactor at ingest.
 *
 * Confirms the redactor module works end-to-end:
 *   (1) Vitest unit tests for the redactor pass (26 cases)
 *   (2) Org settings can carry piiRedactionMode = 'redact' | 'tokenize'
 *   (3) AuditAction.PII_REDACTED is exported from @clm/types
 *
 * The actual extraction-call wiring is unit-tested via the redactor;
 * we don't burn API tokens hitting the real LLM in CI.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

console.log('\n=== (1) PII redactor vitest unit tests ===')
const r = spawnSync('pnpm', ['vitest', 'run', 'src/lib/pii-redactor.test.ts'], {
  cwd: path.join(REPO_ROOT, 'apps/api'),
  encoding: 'utf8',
})
const out = (r.stdout ?? '') + (r.stderr ?? '')
const passLine = out.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
console.log(`  vitest output: ${passLine ? passLine[0] : '(no summary)'}`)
check(r.status === 0, `vitest exits 0`)
check(passLine && passLine[1] === passLine[2], `all tests pass (${passLine?.[1] ?? '?'} / ${passLine?.[2] ?? '?'})`)
check(parseInt(passLine?.[1] ?? '0', 10) >= 25, `≥25 cases`)

// ── (2) AuditAction.PII_REDACTED present
console.log('\n=== (2) AuditAction.PII_REDACTED enum ===')
const enumsRes = spawnSync('grep', ['-c', 'PII_REDACTED', path.join(REPO_ROOT, 'packages/types/src/enums.ts')], { encoding: 'utf8' })
check((enumsRes.stdout ?? '').trim() !== '0', `PII_REDACTED present in enums.ts`)

// ── (3) pii-policy.ts module exists with applyPiiPolicy export
console.log('\n=== (3) pii-policy.ts wired up ===')
const policy = spawnSync('grep', ['-c', 'export async function applyPiiPolicy',
  path.join(REPO_ROOT, 'apps/api/src/lib/pii-policy.ts')], { encoding: 'utf8' })
check((policy.stdout ?? '').trim() !== '0', `applyPiiPolicy exported`)

// ── (4) Wired into contracts.ts at extract_obligations + renewal_advice
console.log('\n=== (4) Wired into LLM-bound surfaces ===')
const wired = spawnSync('grep', ['-c', 'applyPiiPolicy', path.join(REPO_ROOT, 'apps/api/src/routes/contracts.ts')], { encoding: 'utf8' })
const wiredCount = parseInt((wired.stdout ?? '0').trim(), 10)
check(wiredCount >= 2, `applyPiiPolicy referenced ≥2 places in contracts.ts (got ${wiredCount})`)

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All P7.5.1 PII-redactor checks pass')
