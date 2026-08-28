#!/usr/bin/env node
/**
 * P3.3 verify — counterparty_memory tool.
 *
 *   (1) Look up a known-seeded counterparty (Acme Corporation) →
 *       dealCount ≥ 1
 *   (2) Response carries aggregate {totalValue, types, severity
 *       distribution, signedSince, lastSignedAt, avgRiskScore}
 *   (3) Severity distribution keys are the expected 5 buckets
 *       (favorable/neutral/unfavorable/unusual/unrated)
 *   (4) Asking for clauseType=limitation_of_liability attaches
 *       excerpts on matching deals (not every deal has that clause,
 *       but ≥1 should)
 *   (5) Unknown counterparty returns dealCount=0 + warning (no 500)
 *   (6) @review-contract allowlist includes counterparty_memory
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
}

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  return r.accessToken
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()
  const list = await fetch(`${API}/api/v1/contracts?pageSize=5`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const orgId = (list.data ?? list.contracts ?? [])[0]?.orgId
  if (!orgId) { console.error('no contracts'); process.exit(1) }

  // (1/2/3) Known counterparty — the seed has several Acme deals
  const r = callTool('counterparty_memory', {
    orgId, counterpartyName: 'Acme',
  })
  check(r.status === 200, `(1) counterparty_memory returns 200 (got ${r.status})`)
  const body = r.body ?? {}
  check(body.dealCount >= 1, `(1) dealCount ≥1 for Acme (got ${body.dealCount})`)
  check(body.counterpartyName === 'Acme', `(1) echoes counterpartyName`)

  const agg = body.aggregate ?? {}
  check(typeof agg.totalValue === 'number', `(2) aggregate.totalValue is a number (${agg.totalValue})`)
  check(Array.isArray(agg.types), `(2) aggregate.types is an array (${agg.types?.join(', ')})`)
  check(typeof agg.severityDistribution === 'object',
    `(2) aggregate.severityDistribution is an object`)
  check('signedSince' in agg, `(2) aggregate.signedSince present`)
  check('lastSignedAt' in agg, `(2) aggregate.lastSignedAt present`)
  check('avgRiskScore' in agg, `(2) aggregate.avgRiskScore present`)

  // (3) Severity buckets
  const sev = agg.severityDistribution ?? {}
  for (const key of ['favorable', 'neutral', 'unfavorable', 'unusual', 'unrated']) {
    check(typeof sev[key] === 'number',
      `(3) severity.${key} is a number (${sev[key]})`)
  }

  // (4) Filtered by clauseType
  const r2 = callTool('counterparty_memory', {
    orgId, counterpartyName: 'Acme', clauseType: 'limitation_of_liability',
  })
  check(r2.status === 200, `(4) clauseType-filtered call returns 200 (got ${r2.status})`)
  const withLiabExcerpt = (r2.body?.deals ?? []).filter(d => d.excerpt && d.excerpt.length > 30)
  check(withLiabExcerpt.length >= 1,
    `(4) at least one deal carries a limitation_of_liability excerpt (got ${withLiabExcerpt.length})`)

  // (5) Unknown counterparty — no 500, dealCount=0, warning
  const r3 = callTool('counterparty_memory', {
    orgId, counterpartyName: 'Nonexistent Party XYZ-9999',
  })
  check(r3.status === 200, `(5) unknown counterparty returns 200 (got ${r3.status})`)
  check(r3.body?.dealCount === 0, `(5) dealCount=0 on miss (got ${r3.body?.dealCount})`)
  check(typeof r3.body?.warning === 'string' && r3.body.warning.length > 0,
    `(5) warning string present`)

  // (6) Skill allowlist includes counterparty_memory
  const skills = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const review = (skills.skills ?? []).find(s => s.slug === '@review-contract')
  check(review?.allowedTools?.includes('counterparty_memory'),
    `(6) @review-contract allowlist includes counterparty_memory`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P3.3 counterparty_memory checks pass')
})().catch(e => { console.error(e); process.exit(1) })
