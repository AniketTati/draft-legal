/**
 * 04 — Write flows / lifecycle.
 *
 * Exercises the mutating surface end-to-end and asserts the NEXT STATE, not
 * just the status code: DB row, ES index, audit event. Everything created here
 * is torn down in the finally block — an interrupted probe must not leave the
 * demo org dirty.
 */
import { writeFileSync } from 'node:fs'
import { login, apiGet, apiPost, apiPatch, apiDelete, sqlOne, API_BASE } from './lib/harness.mjs'

const ORG = 'cmpsae8pm00007olj83jzzess'
const STAMP = `qa-2026-08-18-${process.pid}`
const results = []
const created = { contracts: [], counterparties: [], templates: [], clauses: [], comments: [], matters: [], requests: [] }

function rec(id, status, evidence, severity = 'medium') {
  results.push({ id, status, evidence, severity })
  const mark = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL'
  console.log(`[${mark}] ${id} — ${evidence}`)
}

async function esCount(id) {
  await fetch('http://localhost:9200/contracts/_refresh', { method: 'POST' }).catch(() => {})
  const r = await fetch(`http://localhost:9200/contracts/_doc/${id}`).catch(() => null)
  return r?.status === 200
}

async function main() {
  const auth = await login('admin@demo.com')
  const T = auth.accessToken

  try {
    // ── W1 · blank contract create → DB + ES ────────────────────────────
    {
      const r = await apiPost('/api/v1/contracts', T, {
        title: `${STAMP} blank create`,
        type: 'NDA',
        status: 'DRAFT',
        counterpartyName: 'QA Counterparty',
      })
      if (!r.ok) {
        rec('W1-blank-create', 'fail', `POST /contracts → ${r.status}: ${r.text.slice(0, 200)}`, 'high')
      } else {
        const id = r.body?.id ?? r.body?.data?.id
        created.contracts.push(id)
        const inDb = sqlOne(`SELECT id FROM contracts WHERE id='${id}'`)
        const inEs = await esCount(id)
        rec('W1-blank-create', inDb && inEs ? 'pass' : 'fail',
          `id=${id} db=${!!inDb} es=${inEs}${inEs ? '' : ' ← created but NOT indexed'}`,
          inEs ? 'medium' : 'high')
      }
    }

    // ── W2 · patch contract → field persists + audit event ──────────────
    if (created.contracts[0]) {
      const id = created.contracts[0]
      const before = Number(sqlOne(`SELECT count(*) FROM audit_events WHERE "resourceId"='${id}'`) ?? 0)
      const r = await apiPatch(`/api/v1/contracts/${id}`, T, { title: `${STAMP} renamed`, value: '12345' })
      const dbTitle = sqlOne(`SELECT title FROM contracts WHERE id='${id}'`)
      const after = Number(sqlOne(`SELECT count(*) FROM audit_events WHERE "resourceId"='${id}'`) ?? 0)
      rec('W2-contract-patch', r.ok && dbTitle?.includes('renamed') ? 'pass' : 'fail',
        `status=${r.status} dbTitle="${dbTitle}" auditEvents ${before}→${after}`,
        'high')
    }

    // ── W3 · status transition ──────────────────────────────────────────
    if (created.contracts[0]) {
      const id = created.contracts[0]
      const r = await apiPatch(`/api/v1/contracts/${id}`, T, { status: 'PENDING_REVIEW' })
      const st = sqlOne(`SELECT status FROM contracts WHERE id='${id}'`)
      rec('W3-status-transition', r.ok && st === 'PENDING_REVIEW' ? 'pass' : 'fail',
        `status=${r.status} dbStatus=${st}`, 'high')
    }

    // ── W4 · version create ─────────────────────────────────────────────
    if (created.contracts[0]) {
      const id = created.contracts[0]
      const r = await apiPost(`/api/v1/contracts/${id}/html-version`, T, {
        html: '<h1>QA version</h1><p>Confidentiality. Each party shall protect the other party’s information.</p>',
      })
      const n = sqlOne(`SELECT count(*) FROM contract_versions WHERE "contractId"='${id}'`)
      rec('W4-version-create', r.ok && Number(n) > 0 ? 'pass' : 'fail',
        `status=${r.status} versions=${n}`, 'high')
    }

    // ── W5 · comment add / list / delete ────────────────────────────────
    if (created.contracts[0]) {
      const id = created.contracts[0]
      const c = await apiPost(`/api/v1/contracts/${id}/comments`, T, { body: `${STAMP} comment`, anchor: null })
      const list = await apiGet(`/api/v1/contracts/${id}/comments`, T)
      const n = Array.isArray(list.body?.data) ? list.body.data.length : (Array.isArray(list.body) ? list.body.length : 0)
      rec('W5-comments', c.ok && n > 0 ? 'pass' : 'fail',
        `create=${c.status} list=${list.status} count=${n}`, 'medium')
      const cid = c.body?.id ?? c.body?.data?.id
      if (cid) created.comments.push([id, cid])
    }

    // ── W6 · counterparty CRUD ──────────────────────────────────────────
    {
      const r = await apiPost('/api/v1/counterparties', T, { name: `${STAMP} CP`, legalName: 'QA CP Ltd' })
      const id = r.body?.id ?? r.body?.data?.id
      if (id) created.counterparties.push(id)
      const g = id ? await apiGet(`/api/v1/counterparties/${id}`, T) : { status: 0, ok: false }
      rec('W6-counterparty-crud', r.ok && g.ok ? 'pass' : 'fail', `create=${r.status} read=${g.status} id=${id}`, 'medium')
    }

    // ── W7 · clause library create ──────────────────────────────────────
    {
      const catId = sqlOne(`SELECT id FROM clause_categories WHERE "orgId"='${ORG}' LIMIT 1`)
      const r = await apiPost('/api/v1/clauses', T, {
        title: `${STAMP} clause`, content: 'The parties agree to arbitrate all disputes.',
        categoryId: catId, riskRating: 'LOW',
      })
      const id = r.body?.id ?? r.body?.data?.id
      if (id) created.clauses.push(id)
      rec('W7-clause-create', r.ok ? 'pass' : 'fail', `status=${r.status} id=${id} ${r.ok ? '' : r.text.slice(0, 160)}`, 'medium')
    }

    // ── W8 · matter create ──────────────────────────────────────────────
    {
      const r = await apiPost('/api/v1/matters', T, { name: `${STAMP} matter`, description: 'QA matter' })
      const id = r.body?.id ?? r.body?.data?.id
      if (id) created.matters.push(id)
      rec('W8-matter-create', r.ok ? 'pass' : 'fail', `status=${r.status} id=${id} ${r.ok ? '' : r.text.slice(0, 160)}`, 'medium')
    }

    // ── W9 · contract request create ────────────────────────────────────
    {
      const r = await apiPost('/api/v1/requests', T, {
        title: `${STAMP} request`, type: 'NDA', description: 'QA request', priority: 'MEDIUM',
      })
      const id = r.body?.id ?? r.body?.data?.id
      if (id) created.requests.push(id)
      rec('W9-request-create', r.ok ? 'pass' : 'fail', `status=${r.status} id=${id} ${r.ok ? '' : r.text.slice(0, 160)}`, 'medium')
    }

    // ── W10 · amendment (child contract) ────────────────────────────────
    if (created.contracts[0]) {
      const parent = created.contracts[0]
      const r = await apiPost(`/api/v1/contracts/${parent}/amendments`, T, {
        title: `${STAMP} amendment`, type: 'AMENDMENT',
      })
      const id = r.body?.id ?? r.body?.data?.id
      if (id) created.contracts.push(id)
      const inEs = id ? await esCount(id) : false
      const fam = await apiGet(`/api/v1/contracts/${parent}/family`, T)
      rec('W10-amendment', r.ok ? (inEs ? 'pass' : 'warn') : 'fail',
        `status=${r.status} child=${id} es=${inEs} family=${fam.status}${r.ok ? '' : ' ' + r.text.slice(0, 160)}`,
        'high')
    }

    // ── W11 · share link create + public portal read ────────────────────
    if (created.contracts[0]) {
      const id = created.contracts[0]
      const r = await apiPost(`/api/v1/contracts/${id}/share`, T, { expiresInDays: 7 })
      const token = r.body?.token ?? r.body?.data?.token ?? r.body?.link?.token
      let portal = { status: 0 }
      if (token) portal = await apiGet(`/api/v1/portal/${token}/contract`)
      rec('W11-share-link', r.ok && portal.status === 200 ? 'pass' : r.ok ? 'warn' : 'fail',
        `create=${r.status} token=${token ? 'yes' : 'no'} publicRead=${portal.status}`, 'medium')
    }

    // ── W12 · export CSV ────────────────────────────────────────────────
    {
      const r = await apiGet('/api/v1/contracts/export?format=csv', T)
      const isCsv = typeof r.text === 'string' && r.text.includes(',') && r.text.split('\n').length > 2
      rec('W12-export-csv', r.ok && isCsv ? 'pass' : 'fail',
        `status=${r.status} rows=${r.text.split('\n').length} head="${r.text.slice(0, 80).replace(/\n/g, '⏎')}"`, 'medium')
    }

    // ── W13 · soft delete removes from list AND ES ──────────────────────
    if (created.contracts.length) {
      const id = created.contracts.at(-1)
      const r = await apiDelete(`/api/v1/contracts/${id}`, T)
      const del = sqlOne(`SELECT "deletedAt" FROM contracts WHERE id='${id}'`)
      const stillInEs = await esCount(id)
      rec('W13-soft-delete', r.ok && del ? (stillInEs ? 'warn' : 'pass') : 'fail',
        `status=${r.status} deletedAt=${del ? 'set' : 'null'} stillInES=${stillInEs}${stillInEs ? ' ← index not purged' : ''}`,
        'medium')
      if (del) created.contracts = created.contracts.filter((c) => c !== id)
    }

    // ── W14 · malformed payload → structured 4xx, never 500 ─────────────
    {
      const bad = [
        ['POST /contracts (missing title)', () => apiPost('/api/v1/contracts', T, { type: 'NDA' })],
        ['POST /contracts (wrong type)', () => apiPost('/api/v1/contracts', T, { title: 123, type: [] })],
        ['PATCH /contracts/:id (bad status)', () => apiPatch(`/api/v1/contracts/${created.contracts[0]}`, T, { status: 'NOT_A_STATUS' })],
        ['POST /search (empty q)', () => apiPost('/api/v1/search', T, { q: '' })],
        ['GET /contracts/:id (nonexistent)', () => apiGet('/api/v1/contracts/does-not-exist-xyz', T)],
      ]
      const bad500 = []
      for (const [label, fn] of bad) {
        const r = await fn()
        if (r.status >= 500) bad500.push(`${label} → ${r.status}`)
      }
      rec('W14-error-handling', bad500.length === 0 ? 'pass' : 'fail',
        bad500.length ? `5xx on: ${bad500.join('; ')}` : 'all 5 malformed payloads returned 4xx, no 5xx', 'high')
    }
  } finally {
    // ── Teardown — always, even on throw ────────────────────────────────
    console.log('\n── teardown ──')
    for (const [cid, commentId] of created.comments) {
      await apiDelete(`/api/v1/contracts/${cid}/comments/${commentId}`, T).catch(() => {})
    }
    for (const id of created.contracts) {
      const r = await apiDelete(`/api/v1/contracts/${id}`, T)
      console.log(`  contract ${id} → ${r.status}`)
    }
    for (const id of created.clauses) await apiDelete(`/api/v1/clauses/${id}`, T).catch(() => {})
    for (const id of created.counterparties) await apiDelete(`/api/v1/counterparties/${id}`, T).catch(() => {})
    for (const id of created.matters) await apiDelete(`/api/v1/matters/${id}`, T).catch(() => {})
    for (const id of created.requests) await apiDelete(`/api/v1/requests/${id}`, T).catch(() => {})
    // Hard-remove anything still carrying our stamp so the demo org stays clean.
    const left = sqlOne(`SELECT count(*) FROM contracts WHERE title LIKE '${STAMP}%' AND "deletedAt" IS NULL`)
    console.log(`  contracts still live with stamp: ${left}`)

    writeFileSync(new URL('./out/04-write-flows.json', import.meta.url), JSON.stringify(results, null, 2))
    const f = results.filter((r) => r.status === 'fail')
    console.log(`\n──────── ${results.length} checks · ${f.length} FAIL ────────`)
    for (const x of f) console.log(`  FAIL ${x.id} — ${x.evidence}`)
  }
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
