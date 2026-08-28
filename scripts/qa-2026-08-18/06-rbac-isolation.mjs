/**
 * 06 — RBAC, multi-tenant isolation, auth hardening.
 *
 * Negative-space testing: what should a caller NOT be able to do. A 200 here
 * is the failure. Cross-org probes use a real contract id from another org, so
 * "not found" vs "forbidden" both count as denial but are reported separately.
 */
import { writeFileSync } from 'node:fs'
import { login, apiGet, apiPost, apiPatch, apiDelete, call, sqlOne } from './lib/harness.mjs'

const DEMO_ORG = 'cmpsae8pm00007olj83jzzess'
const results = []
function rec(id, status, evidence, severity = 'high') {
  results.push({ id, status, evidence, severity })
  const m = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL'
  console.log(`[${m}] ${id} — ${evidence}`)
}
const denied = (s) => s === 401 || s === 403 || s === 404

async function main() {
  const admin = await login('admin@demo.com')
  const viewer = await login('viewer.test@demo.com')
  const manager = await login('w0-manager@demo.com')
  const counsel = await login('legal@demo.com')

  const demoContract = sqlOne(`SELECT id FROM contracts WHERE "orgId"='${DEMO_ORG}' AND "deletedAt" IS NULL LIMIT 1`)
  const otherOrg = sqlOne(`SELECT id FROM organizations WHERE id <> '${DEMO_ORG}' LIMIT 1`)
  const otherContract = sqlOne(`SELECT id FROM contracts WHERE "orgId" <> '${DEMO_ORG}' AND "deletedAt" IS NULL LIMIT 1`)

  console.log(`demoContract=${demoContract} otherOrg=${otherOrg} otherContract=${otherContract ?? '(none)'}\n`)

  // ── R1 · unauthenticated access is refused everywhere ─────────────────
  {
    const paths = ['/api/v1/contracts', '/api/v1/users/me', '/api/v1/dashboard', '/api/v1/admin/users/roles',
      '/api/v1/organization', '/api/v1/clauses', '/api/v1/templates', '/api/v1/approvals/all']
    const leaked = []
    for (const p of paths) {
      const r = await apiGet(p, undefined)
      if (!denied(r.status)) leaked.push(`${p} → ${r.status}`)
    }
    rec('R1-unauthenticated', leaked.length === 0 ? 'pass' : 'fail',
      leaked.length ? `LEAKED: ${leaked.join('; ')}` : `all ${paths.length} endpoints refused anonymous access`)
  }

  // ── R2 · forged / tampered JWT is refused ─────────────────────────────
  {
    const good = admin.accessToken
    const parts = good.split('.')
    const tamperedSig = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`
    const tamperedPayload = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'x', orgId: DEMO_ORG, roles: ['ADMIN'], type: 'access', iat: 1, exp: 9999999999 })).toString('base64url')}.${parts[2]}`
    const cases = [['garbage', 'not-a-jwt'], ['tampered-sig', tamperedSig], ['tampered-payload', tamperedPayload], ['empty', '']]
    const leaked = []
    for (const [label, tok] of cases) {
      const r = await apiGet('/api/v1/contracts', tok)
      if (!denied(r.status)) leaked.push(`${label} → ${r.status}`)
    }
    rec('R2-jwt-tampering', leaked.length === 0 ? 'pass' : 'fail',
      leaked.length ? `ACCEPTED BAD TOKEN: ${leaked.join('; ')}` : 'garbage, tampered sig, tampered payload and empty all refused')
  }

  // ── R3 · VIEWER cannot mutate ─────────────────────────────────────────
  {
    const attempts = [
      ['create contract', () => apiPost('/api/v1/contracts', viewer.accessToken, { title: 'rbac probe', type: 'NDA', status: 'DRAFT' })],
      ['patch contract', () => apiPatch(`/api/v1/contracts/${demoContract}`, viewer.accessToken, { title: 'hijacked' })],
      ['delete contract', () => apiDelete(`/api/v1/contracts/${demoContract}`, viewer.accessToken)],
      ['create counterparty', () => apiPost('/api/v1/counterparties', viewer.accessToken, { name: 'rbac probe cp' })],
      ['create clause', () => apiPost('/api/v1/clauses', viewer.accessToken, { title: 'x', content: 'y', categoryId: 'z' })],
    ]
    const allowed = []
    for (const [label, fn] of attempts) {
      const r = await fn()
      if (r.status >= 200 && r.status < 300) allowed.push(`${label} → ${r.status}`)
    }
    rec('R3-viewer-cannot-mutate', allowed.length === 0 ? 'pass' : 'fail',
      allowed.length ? `VIEWER PERFORMED: ${allowed.join('; ')}` : 'all 5 mutations denied for VIEWER')
  }

  // ── R4 · VIEWER can still read ────────────────────────────────────────
  {
    const r = await apiGet('/api/v1/contracts?limit=3', viewer.accessToken)
    rec('R4-viewer-can-read', r.ok ? 'pass' : 'fail',
      `GET /contracts → ${r.status} (${r.body?.data?.length ?? 0} rows) — a VIEWER must not be locked out of reads`,
      'medium')
  }

  // ── R5 · admin-only surfaces refused to non-admins ────────────────────
  {
    const adminPaths = ['/api/v1/admin/users/roles', '/api/v1/admin/ai/settings', '/api/v1/admin/ai/keys',
      '/api/v1/admin/integrations/api-keys', '/api/v1/admin/packs']
    const leakedFor = {}
    for (const [who, tok] of [['viewer', viewer.accessToken], ['manager', manager.accessToken], ['counsel', counsel.accessToken]]) {
      for (const p of adminPaths) {
        const r = await apiGet(p, tok)
        if (r.status >= 200 && r.status < 300) (leakedFor[who] ??= []).push(p)
      }
    }
    const any = Object.keys(leakedFor).length > 0
    rec('R5-admin-surface', any ? 'warn' : 'pass',
      any ? `non-admins reached: ${JSON.stringify(leakedFor)}` : 'viewer/manager/counsel all denied on 5 admin endpoints',
      'medium')
  }

  // ── R6 · cross-org read is impossible ─────────────────────────────────
  if (otherContract) {
    const r = await apiGet(`/api/v1/contracts/${otherContract}`, admin.accessToken)
    rec('R6-cross-org-read', denied(r.status) ? 'pass' : 'fail',
      `demo-org admin reading org ${otherOrg}'s contract → ${r.status}${denied(r.status) ? ' (denied)' : ' ← CROSS-ORG LEAK'}`)
  } else {
    rec('R6-cross-org-read', 'skip', 'no contract exists outside the demo org to test against', 'high')
  }

  // ── R7 · x-org-id header cannot override session org ──────────────────
  {
    const r = await call('GET', '/api/v1/contracts?limit=1', {
      token: admin.accessToken,
      headers: { 'x-org-id': otherOrg, 'x-internal-service': 'agents' },
    })
    const orgOfRows = r.body?.data?.[0]?.orgId
    const overrode = orgOfRows && orgOfRows !== DEMO_ORG
    rec('R7-org-header-override', overrode ? 'fail' : 'pass',
      `sent x-org-id=${otherOrg} → ${r.status}, rows scoped to ${orgOfRows ?? 'n/a'}${overrode ? ' ← HEADER OVERRODE SESSION ORG' : ' (session org held)'}`)
  }

  // ── R8 · internal AI endpoints reject calls without the shared secret ──
  {
    const r = await apiPost('/api/internal/ai/tools/contract_search', undefined, { orgId: DEMO_ORG, query: 'test', limit: 1 })
    const r2 = await call('POST', '/api/internal/ai/tools/contract_search', {
      body: { orgId: DEMO_ORG, query: 'test', limit: 1 },
      headers: { 'x-internal-service': 'agents', 'x-internal-secret': 'wrong-secret' },
    })
    const ok = denied(r.status) && denied(r2.status)
    rec('R8-internal-secret', ok ? 'pass' : 'fail',
      `no-secret → ${r.status}, wrong-secret → ${r2.status}${ok ? ' (both denied)' : ' ← INTERNAL API REACHABLE'}`)
  }

  // ── R9 · agent chat is org-scoped (no cross-org data via the LLM) ─────
  {
    const r = await apiGet(`/api/v1/agent/threads`, viewer.accessToken)
    const threads = r.body?.threads ?? []
    const foreign = threads.filter((t) => t.orgId && t.orgId !== DEMO_ORG)
    rec('R9-agent-thread-scope', foreign.length === 0 ? 'pass' : 'fail',
      `${threads.length} threads visible to viewer, ${foreign.length} from another org`)
  }

  // ── R10 · expired/!revoked token handling on logout ───────────────────
  {
    const tmp = await login('viewer.test@demo.com')
    const before = await apiGet('/api/v1/users/me', tmp.accessToken)
    await apiPost('/api/v1/auth/logout', tmp.accessToken, {})
    const after = await apiGet('/api/v1/users/me', tmp.accessToken)
    // Stateless JWTs commonly stay valid until exp; report the actual behaviour.
    rec('R10-logout-token', 'warn', // informational, not a pass/fail gate
      `before logout ${before.status}, after logout ${after.status} — ${after.status === 200 ? 'access token still valid post-logout (stateless JWT; revocation relies on short 15m exp)' : 'token rejected after logout'}`,
      'low')
  }

  // ── R11 · rate limiting exists ────────────────────────────────────────
  {
    const codes = []
    for (let i = 0; i < 40; i++) {
      const r = await apiPost('/api/v1/auth/login', undefined, { email: 'admin@demo.com', password: 'wrong-password' })
      codes.push(r.status)
      if (r.status === 429) break
    }
    const limited = codes.includes(429)
    rec('R11-rate-limit', limited ? 'pass' : 'warn',
      `${codes.length} bad logins → ${limited ? `429 after ${codes.length}` : `no 429 seen (statuses: ${[...new Set(codes)].join(',')})`}`,
      'medium')
  }

  writeFileSync(new URL('./out/06-rbac-isolation.json', import.meta.url), JSON.stringify(results, null, 2))
  const f = results.filter((r) => r.status === 'fail')
  const w = results.filter((r) => r.status === 'warn')
  console.log(`\n──────── ${results.length} checks · ${f.length} FAIL · ${w.length} WARN ────────`)
  for (const x of f) console.log(`  FAIL ${x.id} — ${x.evidence}`)
  for (const x of w) console.log(`  WARN ${x.id} — ${x.evidence}`)
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
