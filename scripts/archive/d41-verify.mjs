#!/usr/bin/env node
/**
 * D.4.1 verify — Skill invocation engine end-to-end.
 *
 *   (1) GET /api/v1/skills lists the seeded @review-contract built-in
 *   (2) POST /api/v1/agent/chat with { skillSlug: '@review-contract' }
 *       → SSE stream emits tool_call_start / tool_call_result for tools
 *         in the skill's allowedTools list (e.g. contract_get)
 *       → final token stream produced
 *   (3) A SkillInvocation row exists with skillVersion snapshotted
 *   (4) A second call with a bogus skillSlug falls through gracefully
 *       (stream completes, no invocation row)
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1) }

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  if (!r.accessToken) die(`login failed: ${JSON.stringify(r).slice(0, 200)}`)
  return r.accessToken
}

async function readSSEOnce(token, payload) {
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok || !res.body) die(`chat HTTP ${res.status}`)
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

/** Pull the first contract id so contract_get has something to call. */
async function firstContractId(token) {
  const r = await fetch(`${API}/api/v1/contracts?pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const c = (r.contracts ?? r.data ?? [])[0]
  if (!c?.id) die('no contracts to point the skill at — reseed first')
  return { id: c.id, title: c.title }
}

function fetchInvocationRow(sessionId) {
  // Helper script — avoids the `tsx -e` top-level-await limitation.
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_find-invocation.ts', sessionId], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) die(`invocation query failed: ${r.stderr}`)
  const line = r.stdout.trim().split('\n').pop()
  try { return JSON.parse(line) } catch { return null }
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()

  // (1) GET /skills lists the seeded built-in
  const sk = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const review = (sk.skills ?? []).find(s => s.slug === '@review-contract')
  check(!!review, `(1) GET /skills includes @review-contract (ownerType=${review?.ownerType})`)
  check(review?.allowedTools?.includes('contract_get'), `(1) allowedTools includes contract_get`)

  const contract = await firstContractId(token)

  // (2) POST /agent/chat with skillSlug → stream emits tool events
  const sessionId = `d41-${Date.now()}`
  const events = await readSSEOnce(token, {
    message: 'Review this contract end-to-end.',
    sessionId,
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    agentMode: true,
    pageContext: { type: 'contract', id: contract.id, label: contract.title },
    skillSlug: '@review-contract',
  })
  const kinds = new Set(events.map(e => e.type).filter(Boolean))
  check(kinds.has('tool_call_start'),  `(2) stream emitted tool_call_start events`)
  check(kinds.has('tool_call_result'), `(2) stream emitted tool_call_result events`)
  check(kinds.has('token') || kinds.has('done'), `(2) stream produced token / done event`)

  const toolsCalled = new Set(
    events.filter(e => e.type === 'tool_call_start').map(e => e.name)
  )
  const inAllowlist = [...toolsCalled].every(n =>
    review.allowedTools.includes(n)
  )
  check(inAllowlist, `(2) every tool called was in the skill's allowlist (called: ${[...toolsCalled].join(', ') || '—'})`)

  // (3) SkillInvocation row written with version snapshot
  const inv = fetchInvocationRow(sessionId)
  check(!!inv, `(3) SkillInvocation row written for threadId=${sessionId}`)
  check(inv?.skill?.slug === '@review-contract', `(3) row links to @review-contract`)
  check(typeof inv?.skillVersion === 'number' && inv.skillVersion >= 1, `(3) skillVersion snapshot = ${inv?.skillVersion}`)

  // (4) Bogus slug falls through — no invocation row + stream still completes
  const sessionId2 = `d41-miss-${Date.now()}`
  const events2 = await readSSEOnce(token, {
    message: 'Hi',
    sessionId: sessionId2,
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    agentMode: true,
    skillSlug: '@nonexistent-skill-xyz',
  })
  const finished = events2.some(e => e.type === 'done' || e.type === 'token')
  check(finished, `(4) bogus slug still produces a valid stream`)
  const inv2 = fetchInvocationRow(sessionId2)
  check(!inv2, `(4) no SkillInvocation row was written for bogus slug`)

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.4.1 skill invocation checks pass')
})().catch(e => { console.error(e); process.exit(1) })
