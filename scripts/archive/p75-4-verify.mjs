#!/usr/bin/env node
/**
 * P7.5.4 verify — Audit log hash chain end-to-end.
 *
 * Spawns Node into a tiny script that:
 *   - Creates a test org
 *   - Writes 5 audit events
 *   - Verifies the chain (must be ok)
 *   - Tampers with one row's metadata
 *   - Re-verifies (must report the breakpoint)
 *
 * Pure-function tests for hashAuditRow are in vitest:
 *   apps/api/src/lib/audit.test.ts
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

console.log('\n=== (1) audit hash-row vitest unit tests ===')
const r = spawnSync('pnpm', ['vitest', 'run', 'src/lib/audit.test.ts'], {
  cwd: path.join(REPO_ROOT, 'apps/api'),
  encoding: 'utf8',
})
const out = (r.stdout ?? '') + (r.stderr ?? '')
const passLine = out.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
check(r.status === 0, `vitest exits 0`)
check(passLine && passLine[1] === passLine[2], `tests pass ${passLine?.[0] ?? ''}`)

// ── (2) DB integration: write events + verify chain end-to-end
// Run via tsx so we don't need to build the api package first.
console.log('\n=== (2) Live chain write + verify ===')
const runRes = spawnSync('pnpm', ['tsx', 'scripts/p75-4-chain-check.ts'], {
  cwd: path.join(REPO_ROOT, 'apps/api'),
  encoding: 'utf8',
})
const runOut = (runRes.stdout ?? '') + (runRes.stderr ?? '')
console.log(runOut.split('\n').filter(l => l.length > 0).slice(0, 20).map(l => '    ' + l).join('\n'))

check(runOut.includes('WROTE 3'), `wrote 3 audit events`)
check(runOut.includes('HAS_HASHES true'), `all 3 events have hashes`)
check(runOut.includes('CHAIN_LINKS true'), `each prevHash matches the previous hash`)
check(runOut.includes('VERIFY_OK true'), `verifyAuditChain passes after legit writes`)
check(runOut.includes('AFTER_TAMPER_OK false'), `verifyAuditChain DETECTS tampering`)
check(/AFTER_TAMPER_BREAK_REASON (hash_mismatch|prev_hash_mismatch)/.test(runOut), `breakpoint is a hash mismatch`)

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All P7.5.4 hash-chain checks pass')
