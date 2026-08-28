#!/usr/bin/env node
/**
 * P4.5 verify — remaining read-tool wrappers.
 *
 *   (1) approval_list returns the caller's pending steps
 *   (2) counterparty_get by name returns items + contractCount
 *   (3) request_list returns recent requests
 *   (4) custom_field_list returns the org's field definitions
 *   (5) Each tool handles an empty-result case without 500
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
  return { token: r.accessToken, userId: r.user?.id }
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const { token, userId } = await login()
  const list = await fetch(`${API}/api/v1/contracts?pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const first = (list.data ?? list.contracts ?? [])[0]
  const orgId = first?.orgId
  if (!orgId) { console.error('no contracts'); process.exit(1) }

  // (1) approval_list — my-queue default
  const r1 = callTool('approval_list', { orgId, userId: userId ?? 'system', scope: 'my-queue' })
  check(r1.status === 200, `(1) approval_list returns 200 (got ${r1.status})`)
  check(Array.isArray(r1.body?.items), `(1) items is an array (len=${r1.body?.items?.length ?? 0})`)
  check(typeof r1.body?.total === 'number', `(1) total is a number`)

  // (2) counterparty_get — fuzzy name match
  const r2 = callTool('counterparty_get', { orgId, name: 'Acme' })
  // Some demo environments may not have an Acme counterparty row
  // (vs inline counterpartyName), so tolerate 404. Otherwise require
  // items[] with contractCount present.
  if (r2.status === 200) {
    check(Array.isArray(r2.body?.items) && r2.body.items.length >= 1,
      `(2) counterparty_get returns items[] (len=${r2.body?.items?.length ?? 0})`)
    check(typeof r2.body?.items?.[0]?.contractCount === 'number',
      `(2) items[0].contractCount is a number`)
  } else {
    check(r2.status === 404,
      `(2) counterparty_get 404 when no match (got ${r2.status})`)
  }

  // (3) request_list — recent
  const r3 = callTool('request_list', { orgId, limit: 5 })
  check(r3.status === 200, `(3) request_list returns 200 (got ${r3.status})`)
  check(Array.isArray(r3.body?.items), `(3) items is an array (len=${r3.body?.items?.length ?? 0})`)

  // (4) custom_field_list — all
  const r4 = callTool('custom_field_list', { orgId })
  check(r4.status === 200, `(4) custom_field_list returns 200 (got ${r4.status})`)
  check(Array.isArray(r4.body?.items), `(4) items is an array (len=${r4.body?.items?.length ?? 0})`)

  // (4b) Filter to MSA
  const r4b = callTool('custom_field_list', { orgId, contractType: 'MSA' })
  check(r4b.status === 200, `(4) contractType=MSA returns 200`)
  const all = r4b.body?.items ?? []
  const allMatch = all.every(f => f.contractType === 'MSA' || f.contractType === null)
  check(allMatch, `(4) each field's contractType is MSA or null (got ${all.map(f => f.contractType).join(', ')})`)

  // (5) Empty-result case — filter by a priority nobody uses
  const r5 = callTool('request_list', { orgId, priority: 'URGENT', type: 'OTHER', limit: 5 })
  check(r5.status === 200, `(5) request_list with no-match filters still 200 (got ${r5.status})`)
  check(Array.isArray(r5.body?.items), `(5) items array even when empty`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P4.5 tool-wrapper checks pass')
})().catch(e => { console.error(e); process.exit(1) })
