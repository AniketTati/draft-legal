#!/usr/bin/env node
/**
 * P1.4 verify — redline_propose (3 aggression variants).
 *
 *   (1) Direct tool call returns shape {contract, clause, category,
 *       hasPlaybook, variants[]}
 *   (2) Exactly 3 variants come back, one per aggression tier
 *   (3) Each variant has proposedText (non-empty) + rationale + changes[]
 *   (4) At least one variant's changes[].before is a verbatim substring
 *       of the original clause (no hallucinated quotes)
 *   (5) hasPlaybook=true when the clause's category has a preferred
 *       playbook position
 *   (6) @review-contract skill's allowedTools now lists redline_propose
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

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

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  return r.accessToken
}

;(async () => {
  const msa = findMsa()
  if (!msa) { console.error('MSA with liability clause not found'); process.exit(1) }

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // (1/2/3/4/5) Direct tool call
  const r = callTool('redline_propose', {
    orgId: msa.orgId,
    contractId: msa.id,
    clauseType: 'limitation_of_liability',
    instructions: 'Aim for a 12-month mutual cap with consequential-damages carve-out.',
  })
  check(r.status === 200, `(1) redline_propose returns 200 (got ${r.status})`)
  check(!!r.body?.contract && !!r.body?.clause,
    `(1) response includes contract + clause (ids: ${r.body?.contract?.id}, ${r.body?.clause?.id})`)
  check(r.body?.hasPlaybook === true, `(5) hasPlaybook=true (got ${r.body?.hasPlaybook})`)

  const variants = r.body?.variants ?? []
  check(variants.length === 3, `(2) exactly 3 variants returned (got ${variants.length})`)

  const aggressions = variants.map(v => v.aggression)
  check(aggressions.includes('least') && aggressions.includes('moderate') && aggressions.includes('aggressive'),
    `(2) all three aggressions present (got: ${aggressions.join(', ')})`)

  for (const v of variants) {
    check(typeof v.proposedText === 'string' && v.proposedText.length > 50,
      `(3) ${v.aggression} has proposedText ≥50 chars (got ${v.proposedText?.length ?? 0})`)
    check(typeof v.rationale === 'string' && v.rationale.length > 10,
      `(3) ${v.aggression} has rationale (got ${v.rationale?.length ?? 0} chars)`)
    check(Array.isArray(v.changes), `(3) ${v.aggression} has changes[] array`)
  }

  // (4) At least one change in at least one variant has a verbatim `before`
  const original = r.body?.clause?.originalText ?? ''
  let anyVerbatim = false
  for (const v of variants) {
    for (const c of (v.changes ?? [])) {
      if (typeof c.before === 'string' && c.before.length > 5 &&
          original.toLowerCase().includes(c.before.toLowerCase())) {
        anyVerbatim = true
        break
      }
    }
  }
  check(anyVerbatim, `(4) at least one change quotes a verbatim substring of the original`)

  // (6) @review-contract includes redline_propose in allowedTools
  const token = await login()
  const skills = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const review = (skills.skills ?? []).find(s => s.slug === '@review-contract')
  check(review?.allowedTools?.includes('redline_propose'),
    `(6) @review-contract allowedTools includes redline_propose`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P1.4 redline_propose checks pass')
})().catch(e => { console.error(e); process.exit(1) })
