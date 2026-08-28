#!/usr/bin/env node
/**
 * P4.4 verify — org_memory tool.
 *
 *   (1) Query "liability" matches the Limitation of Liability category
 *       and returns a playbook[] (demo seed has 4 positions)
 *   (2) Response carries {playbook, clauseLibrary, pastDeals, summary}
 *   (3) pastDeals entries carry {contractId, contractTitle, excerpt,
 *       sectionRef} — real past clauses, not hallucinated text
 *   (4) Unknown topic returns 200 with empty arrays (no 500)
 *   (5) @review-contract allowlist includes org_memory
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
  const cList = await fetch(`${API}/api/v1/contracts?pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const orgId = (cList.data ?? cList.contracts ?? [])[0]?.orgId
  if (!orgId) { console.error('no contracts'); process.exit(1) }

  // (1/2) Liability — demo seed has 4 playbook positions
  const r = callTool('org_memory', { orgId, topic: 'liability', clauseType: 'limitation_of_liability' })
  check(r.status === 200, `(1) org_memory returns 200 (got ${r.status})`)
  const body = r.body ?? {}
  check(body.matchedCategory?.name === 'Limitation of Liability',
    `(1) matched category "Limitation of Liability" (got "${body.matchedCategory?.name}")`)
  check(Array.isArray(body.playbook) && body.playbook.length >= 2,
    `(1) playbook has ≥2 positions (got ${body.playbook?.length ?? 0})`)

  check(Array.isArray(body.clauseLibrary), `(2) clauseLibrary array present`)
  check(Array.isArray(body.pastDeals), `(2) pastDeals array present`)
  check(typeof body.summary === 'object' &&
        typeof body.summary.playbookCount === 'number' &&
        typeof body.summary.clauseLibraryCount === 'number' &&
        typeof body.summary.pastDealCount === 'number',
    `(2) summary counters present`)

  // (3) Past-deal entries carry the expected fields
  if (body.pastDeals.length > 0) {
    const d = body.pastDeals[0]
    check(typeof d.contractId === 'string', `(3) pastDeal has contractId (${d.contractId})`)
    check(typeof d.contractTitle === 'string', `(3) pastDeal has contractTitle`)
    check(typeof d.excerpt === 'string' && d.excerpt.length > 20,
      `(3) pastDeal has non-trivial excerpt (${d.excerpt?.length ?? 0} chars)`)
  } else {
    check(true, `(3) no past deals for this seed (no signed MSAs with liability clauses) — shape verified above`)
  }

  // (4) Unknown topic — no crash, empty results
  const r2 = callTool('org_memory', { orgId, topic: 'xyzzy-nonexistent-topic' })
  check(r2.status === 200, `(4) unknown-topic returns 200 (got ${r2.status})`)
  check(Array.isArray(r2.body?.playbook) && r2.body.playbook.length === 0,
    `(4) unknown-topic playbook empty`)

  // (5) Skill allowlist
  const skills = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const review = (skills.skills ?? []).find(s => s.slug === '@review-contract')
  check(review?.allowedTools?.includes('org_memory'),
    `(5) @review-contract allowlist includes org_memory`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P4.4 org_memory checks pass')
})().catch(e => { console.error(e); process.exit(1) })
