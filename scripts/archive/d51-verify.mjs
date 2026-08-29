#!/usr/bin/env node
/**
 * D.5.1 verify — playbook_check read tool.
 *
 *   (1) Direct /tools/playbook_check call returns structured {contract,
 *       checks[], unmapped[]} for a known MSA contract
 *   (2) checks[] includes at least one clause matched to a playbook
 *       category that has positions ("Limitation of Liability" in the
 *       demo seed)
 *   (3) Each check carries positions[] with preferred/acceptable text
 *   (4) When invoked via @review-contract skill through /agent/chat,
 *       the SSE stream shows a tool_call_start with name='playbook_check'
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

function reseedSkills() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-skills.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr); process.exit(1) }
}

async function login(email, pw) {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then(x => x.json())
  return r.accessToken
}

async function readSSEOnce(token, payload) {
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`)
  const events = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try { events.push(JSON.parse(data)) } catch { /* skip */ }
      }
    }
  }
  return events
}

;(async () => {
  reseedSkills()
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login('admin@demo.com', 'password123')

  // Find an Acme MSA that actually has a limitation_of_liability clause
  // row in its currentVersion — not every seeded contract has extraction
  // results persisted, and playbook_check needs clauses to join against.
  const finder = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_find-msa-with-liability.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const firstLine = finder.stdout.trim().split('\n').pop() || 'null'
  const msa = firstLine === 'null' ? null : JSON.parse(firstLine)
  if (!msa) {
    console.error('No Acme MSA with a limitation_of_liability clause found — reseed first')
    process.exit(1)
  }

  // (1/2/3) Direct call to the internal tool endpoint via helper (top-
  //         level await limits `tsx -e`).
  const payload = JSON.stringify({
    orgId: msa.orgId, contractId: msa.id, maxClauses: 10,
  })
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', 'playbook_check', payload], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const line = r.stdout.trim().split('\n').pop() || '{}'
  const parsed = JSON.parse(line)
  check(parsed.status === 200, `(1) /tools/playbook_check returned 200 (got ${parsed.status})`)
  const body = parsed.body
  check(body?.contract?.id === msa.id, `(1) body.contract.id matches (got ${body?.contract?.id})`)
  check(Array.isArray(body?.checks), `(1) body.checks is an array (got ${typeof body?.checks})`)

  const checkRow = (body?.checks ?? []).find(c => /liability/i.test(c.category?.name ?? ''))
  check(!!checkRow, `(2) at least one check matches "Limitation of Liability" (got ${body?.checks?.length ?? 0} checks total)`)
  if (checkRow) {
    check(Array.isArray(checkRow.positions) && checkRow.positions.length > 0,
      `(3) matched check has positions[] (${checkRow.positions?.length ?? 0} positions)`)
    const posTypes = new Set((checkRow.positions ?? []).map(p => p.positionType))
    check(posTypes.size >= 2, `(3) positions cover multiple types (got ${[...posTypes].join(', ')})`)
  }

  // (4) Agent-mode chat with @review-contract → playbook_check in the trace
  const sessionId = `d51-${Date.now()}`
  const events = await readSSEOnce(token, {
    message: 'Does this contract deviate from our playbook? Focus on liability.',
    sessionId,
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    agentMode: true,
    pageContext: { type: 'contract', id: msa.id, label: msa.title },
    skillSlug: '@review-contract',
  })
  const toolsCalled = new Set(events.filter(e => e.type === 'tool_call_start').map(e => e.name))
  check(toolsCalled.has('playbook_check'), `(4) stream included a playbook_check tool call (tools: ${[...toolsCalled].join(', ') || '—'})`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.5.1 playbook_check checks pass')
})().catch(e => { console.error(e); process.exit(1) })
