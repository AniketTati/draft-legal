#!/usr/bin/env node
/**
 * P4.1 verify — Matter entity REST routes.
 *
 *   (1) POST /matters creates with status=OPEN by default
 *   (2) GET /matters lists the new row; filters by status=OPEN
 *   (3) POST /:id/attach links a contract → Matter; contract.matterId set
 *   (4) GET /:id returns nested contracts / requests / threads + counts
 *   (5) PATCH /:id → status=CLOSED sets closedAt
 *   (6) DELETE /:id soft-deletes + unlinks children (contract.matterId=null)
 */
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

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
  const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

  // (1) Create
  const name = `P4.1 test matter ${Date.now()}`
  const createRes = await fetch(`${API}/api/v1/matters`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name, description: 'Acme acquisition diligence', tags: ['ma', 'diligence'],
    }),
  })
  check(createRes.status === 201, `(1) create returns 201 (got ${createRes.status})`)
  const matter = await createRes.json()
  check(matter.status === 'OPEN', `(1) default status=OPEN (got ${matter.status})`)
  check(matter.name === name, `(1) name echoed`)

  // (2) List + filter
  const listRes = await fetch(`${API}/api/v1/matters?status=OPEN&limit=100`, { headers: H }).then(r => r.json())
  const found = (listRes.items ?? []).some(m => m.id === matter.id)
  check(found, `(2) GET /matters?status=OPEN returns the new matter`)

  // (3) Attach a contract
  const cList = await fetch(`${API}/api/v1/contracts?pageSize=1`, { headers: H }).then(r => r.json())
  const contractId = (cList.data ?? cList.contracts ?? [])[0]?.id
  if (!contractId) { console.error('no contracts'); process.exit(1) }
  const attachRes = await fetch(`${API}/api/v1/matters/${matter.id}/attach`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ kind: 'contract', entityId: contractId }),
  })
  check(attachRes.status === 200, `(3) attach returns 200 (got ${attachRes.status})`)

  // (4) Detail
  const detail = await fetch(`${API}/api/v1/matters/${matter.id}`, { headers: H }).then(r => r.json())
  const ctr = (detail.contracts ?? []).find(c => c.id === contractId)
  check(!!ctr, `(4) detail includes the attached contract`)
  check(Array.isArray(detail.requests), `(4) detail.requests is an array`)
  check(Array.isArray(detail.threads), `(4) detail.threads is an array`)

  // (5) Close
  const patchRes = await fetch(`${API}/api/v1/matters/${matter.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ status: 'CLOSED' }),
  })
  const closed = await patchRes.json()
  check(closed.status === 'CLOSED', `(5) PATCH → status=CLOSED`)
  check(closed.closedAt != null, `(5) closedAt stamped (${closed.closedAt})`)

  // (6) Delete + unlink
  const delRes = await fetch(`${API}/api/v1/matters/${matter.id}`, {
    method: 'DELETE', headers: H,
  })
  check(delRes.status === 204, `(6) DELETE returns 204 (got ${delRes.status})`)

  const cAfter = await fetch(`${API}/api/v1/contracts/${contractId}`, { headers: H }).then(r => r.json())
  check(cAfter?.matterId == null,
    `(6) contract's matterId was unset after matter delete (got ${cAfter?.matterId})`)

  const detail2 = await fetch(`${API}/api/v1/matters/${matter.id}`, { headers: H })
  check(detail2.status === 404, `(6) GET /:id now returns 404 (got ${detail2.status})`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P4.1 matter-routes checks pass')
})().catch(e => { console.error(e); process.exit(1) })
