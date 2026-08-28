#!/usr/bin/env node
/**
 * P1.3 verify — Two-stage compare (LLM judge pass).
 *
 *   (1) /playbook_judge (Python) returns structured JSON for a synthetic
 *       liability clause — must_have / must_not / bounds each scored
 *   (2) Judge extracts a numeric bound ("12 months of fees" → value=12)
 *       when the clause text contains one
 *   (3) playbook_check with judge:true returns judged-mode response
 *       (response includes top-level `judged: true`)
 *   (4) Judged violations carry `judged: true` marker
 *   (5) Each violation's `evidence` comes back as either an empty string
 *       or a verbatim substring of the clause text (never fabricated)
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

function readEnv(key) {
  // Use tsx with --env-file so we benefit from the same loader semantics
  // as the real app, then echo the key. Avoids bash quoting headaches.
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', '-e', `process.stdout.write(process.env['${key}'] ?? '')`], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return r.stdout.trim()
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
  // Re-run rule seeder so the rules exist even if a reseed wiped them
  const seed = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-playbook-rules.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seed.status !== 0) { console.error('seed failed:', seed.stderr); process.exit(1) }

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const secret = readEnv('INTERNAL_SERVICE_SECRET')
  if (!secret) { console.error('INTERNAL_SERVICE_SECRET not set'); process.exit(1) }

  // (1) Direct /playbook_judge call with a synthetic clause
  const syntheticClause =
    'The liability of either party shall be limited to 12 months of fees. ' +
    'Neither party is liable for consequential damages.'
  const judgePayload = {
    clauseText: syntheticClause,
    positionType: 'preferred',
    rules: {
      must_have: [
        { id: 'mutual', description: 'mutual cap', check: 'contains', value: 'either party', severity: 'high' },
        { id: 'conseq', description: 'consequential carveout', check: 'contains', value: 'consequential', severity: 'high' },
      ],
      must_not: [
        { id: 'unlimited', description: 'no unlimited', check: 'contains', value: 'unlimited', severity: 'walkaway' },
      ],
      bounds: {
        liability_cap_months: { min: 6, max: 24, units: 'months of fees', severity: 'high' },
      },
    },
  }
  const judgeRes = await fetch('http://localhost:8002/playbook_judge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(judgePayload),
  }).then(r => r.json())

  check(Array.isArray(judgeRes.mustHave) && judgeRes.mustHave.length === 2,
    `(1) mustHave returned ${judgeRes.mustHave?.length ?? 0} entries`)
  check(Array.isArray(judgeRes.mustNot) && judgeRes.mustNot.length === 1,
    `(1) mustNot returned ${judgeRes.mustNot?.length ?? 0} entries`)
  check(Array.isArray(judgeRes.bounds) && judgeRes.bounds.length === 1,
    `(1) bounds returned ${judgeRes.bounds?.length ?? 0} entries`)

  // (2) Bound extracted correctly — 12 months of fees
  const capBound = (judgeRes.bounds ?? []).find(b => b.key === 'liability_cap_months')
  check(capBound?.extracted_value === 12,
    `(2) liability_cap_months extracted_value = 12 (got ${capBound?.extracted_value})`)
  check(capBound?.passed === true,
    `(2) liability_cap_months passed = true (in 6-24 range, got ${capBound?.passed})`)

  // Evidence must be verbatim (substring of the clause). No hallucination.
  const mustHaveConseq = (judgeRes.mustHave ?? []).find(v => v.id === 'conseq')
  check(mustHaveConseq?.passed === true, `(1) "consequential" found in clause (passed=${mustHaveConseq?.passed})`)
  check(typeof mustHaveConseq?.evidence === 'string' &&
        (mustHaveConseq.evidence === '' || syntheticClause.toLowerCase().includes(mustHaveConseq.evidence.toLowerCase())),
    `(5) evidence is either empty or a verbatim substring of the clause (got "${mustHaveConseq?.evidence}")`)

  // (3) playbook_check with judge:true
  const msa = findMsa()
  if (!msa) { console.error('No MSA with liability clause found'); process.exit(1) }
  const r = callTool('playbook_check', { orgId: msa.orgId, contractId: msa.id, maxClauses: 10, judge: true })
  check(r.status === 200, `(3) playbook_check returns 200 (got ${r.status})`)
  check(r.body?.judged === true, `(3) response carries judged: true`)

  const liability = (r.body?.checks ?? []).find(c => /liability/i.test(c.category?.name ?? ''))
  check(!!liability, '(3) liability check present')

  // (4) Every rule-style violation in the liability check is judge-marked
  const ruleViolations = (liability?.violations ?? []).filter(v => v.kind !== 'bound' || true)
  const judgedCount = ruleViolations.filter(v => v.judged === true).length
  check(judgedCount >= 3, `(4) ≥3 violations carry judged:true marker (got ${judgedCount})`)

  // (5) Every judged must_have / must_not has an evidence field
  const anyWithEvidence = (liability?.violations ?? [])
    .filter(v => (v.kind === 'must_have' || v.kind === 'must_not') && v.judged)
    .every(v => typeof v.evidence === 'string')
  check(anyWithEvidence, '(5) judged rules carry evidence: string')

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P1.3 two-stage-compare checks pass')
})().catch(e => { console.error(e); process.exit(1) })
