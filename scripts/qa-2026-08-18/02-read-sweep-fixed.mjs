/**
 * 02 — Corrected read sweep.
 *
 * Round 1 used guessed paths; 17 of its 19 "failures" were my own bad URLs.
 * This round uses the paths as actually registered (extracted from source,
 * generics-aware), plus the POST-based search endpoints that round 1 missed.
 */
import { writeFileSync } from 'node:fs'
import { login, apiGet, apiPost, sqlOne } from './lib/harness.mjs'

const ORG = 'cmpsae8pm00007olj83jzzess'

function shape(body) {
  if (body === undefined) return 'non-json'
  if (Array.isArray(body)) return `array[${body.length}]`
  if (body && typeof body === 'object') {
    const keys = Object.keys(body)
    const counts = keys.filter((k) => Array.isArray(body[k])).map((k) => `${k}[${body[k].length}]`)
    return `{${keys.slice(0, 9).join(',')}${keys.length > 9 ? ',…' : ''}}${counts.length ? ' ' + counts.join(' ') : ''}`
  }
  return typeof body
}

async function main() {
  const auth = await login('admin@demo.com')
  const T = auth.accessToken

  const fx = {
    contractId: sqlOne(`SELECT id FROM contracts WHERE "orgId"='${ORG}' AND status='EXECUTED' ORDER BY "createdAt" DESC LIMIT 1`),
    userId: auth.user.id,
    sigContractId: sqlOne(`SELECT "contractId" FROM signature_requests LIMIT 1`),
    sigToken: sqlOne(`SELECT token FROM signers WHERE token IS NOT NULL LIMIT 1`),
    portalToken: sqlOne(`SELECT token FROM contract_share_links WHERE "revokedAt" IS NULL LIMIT 1`),
  }
  console.log('fixtures:', fx, '\n')

  const gets = [
    ['/api/v1/users', 'user list'],
    ['/api/v1/users/me', 'me'],
    ['/api/v1/dashboard', 'dashboard'],
    ['/api/v1/team/workload', 'team workload'],
    ['/api/v1/approvals/all', 'approvals all'],
    ['/api/v1/approvals/my-queue', 'approvals my queue'],
    ['/api/v1/approvals/notifications', 'approval notifications'],
    ['/api/v1/organization', 'org'],
    ['/api/v1/organization/industry-packs', 'industry packs'],
    ['/api/v1/admin/packs', 'admin packs'],
    [`/api/v1/admin/users/${fx.userId}`, 'admin user detail'],
    ['/api/v1/signature-requests', 'signature requests'],
    [`/api/v1/contracts/${fx.sigContractId}/signature-requests`, 'contract sig requests'],
    fx.sigToken ? [`/api/v1/sign/${fx.sigToken}`, 'PUBLIC signer portal'] : null,
    fx.portalToken ? [`/api/v1/portal/${fx.portalToken}/contract`, 'PUBLIC share portal'] : null,
  ].filter(Boolean)

  const posts = [
    ['/api/v1/search', { query: 'services agreement' }, 'search'],
    ['/api/v1/search/advanced', { query: 'indemnification', filters: {} }, 'advanced search'],
    ['/api/v1/search/portfolio-query', { query: 'how many contracts expire in 2026' }, 'portfolio query'],
  ]

  const rows = []
  for (const [path, note] of gets) {
    const r = await apiGet(path, T)
    rows.push({ method: 'GET', path, note, status: r.status, ms: r.ms, detail: r.ok ? shape(r.body) : r.text.slice(0, 200).replace(/\s+/g, ' ') })
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] GET  ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms ${path}\n        ${rows.at(-1).detail}`)
  }
  for (const [path, body, note] of posts) {
    const r = await apiPost(path, T, body)
    rows.push({ method: 'POST', path, note, status: r.status, ms: r.ms, detail: r.ok ? shape(r.body) : r.text.slice(0, 200).replace(/\s+/g, ' ') })
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] POST ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms ${path}\n        ${rows.at(-1).detail}`)
  }

  const fails = rows.filter((r) => r.status < 200 || r.status >= 300)
  console.log(`\n──────── ${rows.length} checked · ${fails.length} non-2xx ────────`)
  for (const f of fails) console.log(`  FAIL ${f.status} ${f.method} ${f.path} — ${f.detail}`)
  writeFileSync(new URL('./out/02-read-sweep-fixed.json', import.meta.url), JSON.stringify({ fx, rows }, null, 2))
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
