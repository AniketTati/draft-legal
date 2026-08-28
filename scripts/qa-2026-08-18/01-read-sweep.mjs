/**
 * 01 — Read sweep.
 *
 * GETs every registered read endpoint as an authenticated ADMIN, binding real
 * seed IDs into path params. Records status, latency and a shape summary.
 * Anything that is not 2xx (or an intentional 4xx) is a finding.
 */
import { writeFileSync } from 'node:fs'
import { login, apiGet, sqlOne, API_BASE } from './lib/harness.mjs'

const ORG = 'cmpsae8pm00007olj83jzzess' // Demo Org, Inc.

function shape(body) {
  if (body === undefined) return 'non-json'
  if (Array.isArray(body)) return `array[${body.length}]`
  if (body && typeof body === 'object') {
    const keys = Object.keys(body)
    const counts = keys
      .filter((k) => Array.isArray(body[k]))
      .map((k) => `${k}[${body[k].length}]`)
    return `{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}${counts.length ? ' ' + counts.join(' ') : ''}`
  }
  return typeof body
}

async function main() {
  const auth = await login('admin@demo.com')
  const T = auth.accessToken
  console.log(`logged in as ${auth.user.email} org=${auth.user.orgId} roles=${auth.user.roles}\n`)

  // ── Resolve real IDs for path params ──────────────────────────────────
  const fx = {
    contractId: sqlOne(`SELECT id FROM contracts WHERE "orgId"='${ORG}' AND status='EXECUTED' ORDER BY "createdAt" DESC LIMIT 1`),
    draftId: sqlOne(`SELECT id FROM contracts WHERE "orgId"='${ORG}' AND status='DRAFT' ORDER BY "createdAt" DESC LIMIT 1`),
    counterpartyId: sqlOne(`SELECT id FROM counterparties WHERE "orgId"='${ORG}' LIMIT 1`),
    templateId: sqlOne(`SELECT id FROM templates WHERE "orgId"='${ORG}' LIMIT 1`),
    clauseId: sqlOne(`SELECT id FROM clause_library_items WHERE "orgId"='${ORG}' LIMIT 1`),
    categoryId: sqlOne(`SELECT id FROM clause_categories WHERE "orgId"='${ORG}' LIMIT 1`),
    matterId: sqlOne(`SELECT id FROM matters WHERE "orgId"='${ORG}' LIMIT 1`),
    approvalId: sqlOne(`SELECT id FROM approval_instances WHERE "orgId"='${ORG}' LIMIT 1`),
    requestId: sqlOne(`SELECT id FROM contract_requests WHERE "orgId"='${ORG}' LIMIT 1`),
    diligenceId: sqlOne(`SELECT id FROM diligence_rooms WHERE "orgId"='${ORG}' LIMIT 1`),
    obligationId: sqlOne(`SELECT id FROM obligations WHERE "orgId"='${ORG}' LIMIT 1`),
    invoiceId: sqlOne(`SELECT id FROM invoices WHERE "orgId"='${ORG}' LIMIT 1`),
    userId: auth.user.id,
    threadId: sqlOne(`SELECT id FROM agent_threads WHERE "orgId"='${ORG}' ORDER BY "createdAt" DESC LIMIT 1`),
    skillId: sqlOne(`SELECT id FROM skills WHERE "orgId"='${ORG}' LIMIT 1`),
    positionId: sqlOne(`SELECT id FROM playbook_positions WHERE "orgId"='${ORG}' LIMIT 1`),
    webhookId: sqlOne(`SELECT id FROM webhooks WHERE "orgId"='${ORG}' LIMIT 1`),
    roleId: sqlOne(`SELECT id FROM roles WHERE "orgId"='${ORG}' LIMIT 1`),
    workflowId: sqlOne(`SELECT id FROM workflow_definitions WHERE "orgId"='${ORG}' LIMIT 1`),
    sigRequestId: sqlOne(`SELECT id FROM signature_requests WHERE "orgId"='${ORG}' LIMIT 1`),
    fieldDefId: sqlOne(`SELECT id FROM contract_field_definitions WHERE "orgId"='${ORG}' LIMIT 1`),
  }
  // versions need a contract that has them
  fx.versionedContractId = sqlOne(
    `SELECT "contractId" FROM contract_versions GROUP BY "contractId" HAVING count(*)>=2 LIMIT 1`,
  )
  const vrows = fx.versionedContractId
    ? sqlOne(`SELECT string_agg(id, ',') FROM (SELECT id FROM contract_versions WHERE "contractId"='${fx.versionedContractId}' ORDER BY "versionNumber" LIMIT 2) s`)
    : null
  if (vrows) { const [a, b] = vrows.split(','); fx.v1Id = a; fx.v2Id = b }

  console.log('fixtures:')
  for (const [k, v] of Object.entries(fx)) console.log(`  ${k.padEnd(22)} ${v ?? '(none)'}`)
  console.log()

  // ── The read surface ──────────────────────────────────────────────────
  // [path, note, expectNon2xx?]
  const paths = [
    // health / meta
    ['/health', 'liveness'],
    ['/health/live', 'k8s live'],
    ['/health/ready', 'k8s ready'],
    ['/api/health', 'alias'],
    // auth / me
    ['/api/v1/auth/me', 'session user'],
    ['/api/v1/users/me', 'profile'],
    ['/api/v1/users/notifications', 'notifications'],
    // dashboard + analytics
    ['/api/v1/dashboard', 'dashboard root'],
    ['/api/v1/dashboard/stats', 'kpis'],
    ['/api/v1/dashboard/my-queue', 'my queue'],
    ['/api/v1/dashboard/workload', 'workload'],
    ['/api/v1/analytics/summary', 'analytics summary'],
    ['/api/v1/analytics/timeseries', 'timeseries'],
    ['/api/v1/analytics/distributions', 'distributions'],
    ['/api/v1/analytics/top-counterparties', 'top cps'],
    ['/api/v1/metrics/counts', 'metric counts'],
    // contracts
    ['/api/v1/contracts', 'list'],
    ['/api/v1/contracts?limit=5&page=1', 'paged'],
    ['/api/v1/contracts?status=EXECUTED', 'filter status'],
    ['/api/v1/contracts?status=DRAFT', 'filter draft'],
    ['/api/v1/contracts?q=services', 'search q'],
    ['/api/v1/contracts?sort=createdAt&order=desc', 'sorted'],
    ['/api/v1/contracts/export?format=csv', 'csv export'],
    [`/api/v1/contracts/${fx.contractId}`, 'detail'],
    [`/api/v1/contracts/${fx.contractId}/clauses`, 'clauses tab'],
    [`/api/v1/contracts/${fx.contractId}/versions`, 'versions tab'],
    [`/api/v1/contracts/${fx.contractId}/timeline`, 'activity tab'],
    [`/api/v1/contracts/${fx.contractId}/obligations`, 'obligations'],
    [`/api/v1/contracts/${fx.contractId}/compliance`, 'compliance'],
    [`/api/v1/contracts/${fx.contractId}/family`, 'family'],
    [`/api/v1/contracts/${fx.contractId}/precedents`, 'precedents'],
    [`/api/v1/contracts/${fx.contractId}/playbook-review`, 'playbook review'],
    [`/api/v1/contracts/${fx.contractId}/comments`, 'comments'],
    [`/api/v1/contracts/${fx.contractId}/share`, 'share links'],
    [`/api/v1/contracts/${fx.contractId}/download`, 'download'],
    [`/api/v1/contracts/${fx.contractId}/compliance-export`, 'compliance export'],
    fx.v1Id && fx.v2Id ? [`/api/v1/contracts/${fx.versionedContractId}/versions/${fx.v1Id}/diff/${fx.v2Id}`, 'version diff'] : null,
    // search
    ['/api/v1/search?q=agreement', 'search'],
    ['/api/v1/search?q=indemnification&type=clause', 'clause search'],
    ['/api/v1/search/facets', 'facets'],
    // counterparties
    ['/api/v1/counterparties', 'list'],
    [`/api/v1/counterparties/${fx.counterpartyId}`, 'detail'],
    // requests
    ['/api/v1/requests', 'list'],
    fx.requestId ? [`/api/v1/requests/${fx.requestId}`, 'detail'] : null,
    // templates
    ['/api/v1/templates', 'list'],
    [`/api/v1/templates/${fx.templateId}`, 'detail'],
    // clauses
    ['/api/v1/clauses', 'library'],
    ['/api/v1/clauses/categories', 'categories'],
    [`/api/v1/clauses/${fx.clauseId}`, 'detail'],
    // playbook
    ['/api/v1/playbook/positions', 'positions'],
    fx.positionId ? [`/api/v1/playbook/positions/${fx.positionId}`, 'position detail'] : null,
    // approvals
    ['/api/v1/approvals', 'list'],
    ['/api/v1/approvals/workflows', 'workflow defs'],
    fx.approvalId ? [`/api/v1/approvals/${fx.approvalId}`, 'instance'] : null,
    // signatures
    ['/api/v1/signature-requests', 'sig list'],
    fx.sigRequestId ? [`/api/v1/signature-requests/${fx.sigRequestId}`, 'sig detail'] : null,
    // obligations / renewals / invoices
    ['/api/v1/obligations', 'list'],
    ['/api/v1/renewals', 'list'],
    ['/api/v1/invoices', 'list'],
    // diligence
    ['/api/v1/diligence', 'rooms'],
    fx.diligenceId ? [`/api/v1/diligence/${fx.diligenceId}`, 'room detail'] : null,
    fx.diligenceId ? [`/api/v1/diligence/${fx.diligenceId}/documents`, 'room docs'] : null,
    // matters
    ['/api/v1/matters', 'list'],
    fx.matterId ? [`/api/v1/matters/${fx.matterId}`, 'detail'] : null,
    // review queue
    ['/api/v1/review-queue', 'queue'],
    // team / org
    ['/api/v1/team', 'team'],
    ['/api/v1/organization', 'org'],
    ['/api/v1/organization/settings', 'org settings'],
    // field definitions
    ['/api/v1/field-definitions', 'custom fields'],
    // skills
    ['/api/v1/skills', 'skills'],
    // agent threads
    ['/api/v1/agent/threads', 'thread list'],
    fx.threadId ? [`/api/v1/agent/threads/${fx.threadId}`, 'thread detail'] : null,
    // admin
    ['/api/v1/admin/users', 'admin users'],
    ['/api/v1/admin/users/roles', 'roles'],
    ['/api/v1/admin/audit', 'audit log'],
    ['/api/v1/admin/ai/settings', 'ai settings'],
    ['/api/v1/admin/ai/keys', 'ai keys'],
    ['/api/v1/admin/ai/usage', 'ai usage'],
    ['/api/v1/admin/ai/cap-status', 'ai cap'],
    ['/api/v1/admin/ai/audit', 'ai audit'],
    ['/api/v1/admin/ai/models', 'ai models'],
    ['/api/v1/admin/packs/industry-packs', 'industry packs'],
    ['/api/v1/admin/integrations/webhooks', 'webhooks'],
    ['/api/v1/admin/integrations/api-keys', 'api keys'],
    ['/api/v1/admin/integrations/slack', 'slack cfg'],
    ['/api/v1/admin/integrations/health', 'integration health'],
    ['/api/v1/admin/integrations/events', 'integration events'],
    fx.webhookId ? [`/api/v1/admin/integrations/webhooks/${fx.webhookId}/deliveries`, 'deliveries'] : null,
    // marketing (public)
    ['/api/v1/marketing/contact/health', 'marketing health'],
  ].filter(Boolean)

  const rows = []
  for (const [path, note] of paths) {
    if (path.includes('undefined') || path.includes('null')) {
      rows.push({ path, note, status: 'SKIP', ms: 0, shape: 'no fixture' })
      console.log(`[SKIP] ${path} — no fixture`)
      continue
    }
    const r = await apiGet(path, T)
    const s = r.status
    const mark = r.ok ? 'PASS' : 'FAIL'
    const detail = r.ok ? shape(r.body) : r.text.slice(0, 180).replace(/\s+/g, ' ')
    rows.push({ path, note, status: s, ms: r.ms, shape: detail })
    console.log(`[${mark}] ${String(s).padEnd(3)} ${String(r.ms).padStart(5)}ms  ${path}\n         ${detail}`)
  }

  const fails = rows.filter((r) => typeof r.status === 'number' && (r.status < 200 || r.status >= 300))
  const slow = rows.filter((r) => r.ms > 2000)
  console.log(`\n──────── ${rows.length} endpoints · ${fails.length} non-2xx · ${slow.length} slower than 2s ────────`)
  for (const f of fails) console.log(`  FAIL ${f.status} ${f.path} — ${f.shape}`)
  for (const s of slow) console.log(`  SLOW ${s.ms}ms ${s.path}`)

  writeFileSync(
    new URL('./out/01-read-sweep.json', import.meta.url),
    JSON.stringify({ fixtures: fx, rows }, null, 2),
  )
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
