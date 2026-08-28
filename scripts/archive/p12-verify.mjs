#!/usr/bin/env node
/**
 * P1.2 verify — Structured playbook schema + rule evaluator.
 *
 *   (1) PlaybookPosition.rules column exists + is populated for
 *       "Limitation of Liability" preferred position
 *   (2) playbook_check response now carries violations[] + worstSeverity
 *       + passed/failed counts per clause
 *   (3) must_have rule for "consequential damages" is actually evaluated
 *       against the MSA clause text (either passed=true or passed=false)
 *   (4) must_not rule for "unlimited" doesn't fire when the clause
 *       doesn't contain the word → passed=true
 *   (5) bounds rules appear with passed=null (deferred to P1.3 judge)
 *   (6) ruleCount on each position matches the seeded rule count
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

function reseedRules() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-playbook-rules.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr); process.exit(1) }
}

function findMsa() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_find-msa-with-liability.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const line = r.stdout.trim().split('\n').pop() || 'null'
  return line === 'null' ? null : JSON.parse(line)
}

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
}

;(async () => {
  reseedRules()
  const msa = findMsa()
  if (!msa) { console.error('MSA with liability clause not found'); process.exit(1) }

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // (1) DB-side check — PlaybookPosition with rules populated (scoped
  //     to the Limitation of Liability category).
  const db = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_dump-playbook-position.ts',
    msa.orgId, 'preferred', 'Limitation of Liability'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const line = db.stdout.trim().split('\n').pop() || 'null'
  const pos = JSON.parse(line)
  check(!!pos?.rules, `(1) preferred PlaybookPosition has rules column populated`)
  check(Array.isArray(pos?.rules?.must_have) && pos.rules.must_have.length >= 3,
    `(1) must_have has ≥3 rules (got ${pos?.rules?.must_have?.length ?? 0})`)
  check(Array.isArray(pos?.rules?.must_not) && pos.rules.must_not.length >= 2,
    `(1) must_not has ≥2 rules (got ${pos?.rules?.must_not?.length ?? 0})`)
  check(pos?.rules?.bounds && Object.keys(pos.rules.bounds).length >= 1,
    `(1) bounds object has entries`)

  // (2) playbook_check now returns violations[] + worstSeverity
  const r = callTool('playbook_check', { orgId: msa.orgId, contractId: msa.id, maxClauses: 10 })
  check(r.status === 200, `(2) playbook_check returns 200 (got ${r.status})`)
  const liability = (r.body?.checks ?? []).find(c => /liability/i.test(c.category?.name ?? ''))
  check(!!liability, '(2) liability check present in response')
  check(Array.isArray(liability?.violations) && liability.violations.length > 0,
    `(2) liability check has violations[] (got ${liability?.violations?.length ?? 0})`)
  check('worstSeverity' in (liability ?? {}),
    `(2) liability check includes worstSeverity field`)
  check(typeof liability?.passed === 'number' && typeof liability?.failed === 'number',
    `(2) passed/failed counters present (passed=${liability?.passed}, failed=${liability?.failed})`)

  // (3) must_have "consequential" — the MSA text mentions "consequential
  //     or indirect damages" so this rule should pass.
  const mustHaveConseq = (liability?.violations ?? []).find(v =>
    v.kind === 'must_have' && v.value === 'consequential'
  )
  check(!!mustHaveConseq, '(3) must_have "consequential" rule was evaluated')
  check(typeof mustHaveConseq?.passed === 'boolean', '(3) must_have has boolean passed')

  // (4) must_not "unlimited" — clause doesn't contain it, should pass
  const mustNotUnlimited = (liability?.violations ?? []).find(v =>
    v.kind === 'must_not' && v.value === 'unlimited'
  )
  check(!!mustNotUnlimited, '(4) must_not "unlimited" rule was evaluated')
  check(mustNotUnlimited?.passed === true,
    `(4) must_not "unlimited" passed=true (got ${mustNotUnlimited?.passed})`)

  // (5) bounds entries appear with passed=null (LLM judge deferred to P1.3)
  const boundRule = (liability?.violations ?? []).find(v => v.kind === 'bound')
  check(!!boundRule, '(5) at least one bound rule surfaces')
  check(boundRule?.passed === null,
    `(5) bound rule passed=null — deferred to P1.3 (got ${boundRule?.passed})`)

  // (6) ruleCount on each position matches seeded count
  const preferredPos = (liability?.positions ?? []).find(p => p.positionType === 'preferred')
  check((preferredPos?.ruleCount ?? 0) >= 5,
    `(6) preferred position ruleCount ≥5 (got ${preferredPos?.ruleCount ?? 0})`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P1.2 structured-playbook checks pass')
})().catch(e => { console.error(e); process.exit(1) })
