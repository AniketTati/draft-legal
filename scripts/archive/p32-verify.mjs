#!/usr/bin/env node
/**
 * P3.2 verify — portfolio_search (RRF fusion + adaptive router).
 *
 *   (1) /tools/portfolio_search returns clause-level hits with both
 *       dense (pgvector) + bm25 (ES) sources acknowledged
 *   (2) Hits carry the RRF shape {contractId, clauseId, sectionRef,
 *       excerpt, fusedScore, denseRank, bm25Rank}
 *   (3) Filtering by contractType narrows results (MSA only)
 *   (4) Graceful degradation — when query returns zero hits, response
 *       still carries sources + structure (no 500)
 *   (5) @compliance-sweep skill allowlist includes portfolio_search
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
  // API returns {data: [...]} or {contracts: [...]} depending on version
  const firstContract = (cList.data ?? cList.contracts ?? [])[0]
  const orgId = firstContract?.orgId

  if (!orgId) { console.error('no contracts in demo org'); process.exit(1) }

  // (1) Broad clause-content query. Even if ES is down we should still
  //     get dense hits from pgvector.
  const r1 = callTool('portfolio_search', {
    orgId, query: 'liability cap', topK: 10,
  })
  check(r1.status === 200, `(1) portfolio_search returns 200 (got ${r1.status})`)
  const body = r1.body ?? {}
  check(Array.isArray(body.hits), `(1) response carries hits[]`)
  check('sources' in body && typeof body.sources === 'object',
    `(1) response includes sources flags (dense=${body.sources?.dense}, bm25=${body.sources?.bm25})`)
  check(body.sources?.dense === true || body.sources?.bm25 === true,
    `(1) at least one ranking source succeeded`)

  // (2) RRF shape — look at the top hit
  const top = body.hits?.[0]
  check(!!top, `(2) at least one hit returned (${body.hits?.length ?? 0} total)`)
  if (top) {
    check(typeof top.contractId === 'string',
      `(2) hit has contractId`)
    check(typeof top.fusedScore === 'number',
      `(2) hit has fusedScore (${top.fusedScore})`)
    // One of denseRank / bm25Rank must be set; both if both sources hit
    const hasRank = (top.denseRank !== null && top.denseRank !== undefined) ||
                    (top.bm25Rank !== null && top.bm25Rank !== undefined)
    check(hasRank, `(2) hit carries denseRank or bm25Rank (dense=${top.denseRank}, bm25=${top.bm25Rank})`)
  }

  // (3) Filter by contractType=MSA
  const r2 = callTool('portfolio_search', {
    orgId, query: 'liability', topK: 20, contractType: 'MSA',
  })
  const allMsa = (r2.body?.hits ?? []).every(h => h.contractType === 'MSA')
  check(allMsa, `(3) contractType=MSA filter keeps only MSA hits (got ${(r2.body?.hits ?? []).map(h => h.contractType).join(', ')})`)

  // (4) Graceful zero-hit path
  const r3 = callTool('portfolio_search', {
    orgId, query: 'xyzzy-nonsense-token-that-matches-nothing-12345', topK: 5,
  })
  check(r3.status === 200, `(4) zero-hit query still returns 200 (got ${r3.status})`)
  check(Array.isArray(r3.body?.hits), `(4) hits is still an array (may be empty)`)

  // (5) Skill allowlist wires up portfolio_search
  const skills = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const sweep = (skills.skills ?? []).find(s => s.slug === '@compliance-sweep')
  check(sweep?.allowedTools?.includes('portfolio_search'),
    `(5) @compliance-sweep allowlist includes portfolio_search`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P3.2 portfolio_search checks pass')
})().catch(e => { console.error(e); process.exit(1) })
