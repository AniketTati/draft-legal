#!/usr/bin/env node
/**
 * D.1.6a verify — AgentThread persistence end-to-end.
 *
 *   (1) Direct API round-trip:
 *       POST /agent/threads → thread id
 *       POST /agent/threads/:id/turns → persists user + assistant + tool_calls
 *       GET  /agent/threads/:id → returns the full persisted exchange
 *       GET  /agent/threads → includes the thread
 *       DELETE /agent/threads/:id → archived, GET no longer lists it
 *
 *   (2) Scope enforcement — a thread created with scopeType=contract is
 *       findable via the ?scopeType=contract&scopeId=… filter.
 *
 *   (3) Cross-user isolation — GET /agent/threads/:id as a different user
 *       (if available) returns 404. We skip this if only one demo user.
 *
 *   (4) End-to-end UI — open the rail, send one turn, verify a new
 *       AgentThread row exists in the DB with the expected message shape.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr || r.stdout); process.exit(1) }
}

function signToken(sub, orgId, roles = ['ADMIN']) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', '-e',
    `import('./src/lib/jwt.js').then(m => console.log(m.signAccessToken({ sub: '${sub}', orgId: '${orgId}', roles: ${JSON.stringify(roles)} })))`,
  ], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return (r.stdout || '').trim().split('\n').pop()
}

async function api(path, opts = {}) {
  const res = await fetch(`http://localhost:3001${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  return { status: res.status, body }
}

;(async () => {
  reseed()

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Grab a token by logging in through the real auth endpoint — this is a
  // more realistic test than minting one ourselves, and uses the same path
  // the rail would.
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  })
  const token = login.body.accessToken
  check(!!token, `logged in as admin@demo.com (status ${login.status})`)
  const auth = { authorization: `Bearer ${token}` }

  // Pre-clean: list all threads for this user, archive them so the following
  // list-and-count assertions are deterministic.
  const pre = await api('/api/v1/agent/threads?limit=100', { headers: auth })
  for (const t of (pre.body.threads ?? [])) {
    await api(`/api/v1/agent/threads/${t.id}`, { method: 'DELETE', headers: auth })
  }
  const afterPreClean = await api('/api/v1/agent/threads?limit=100', { headers: auth })
  check((afterPreClean.body.threads ?? []).length === 0, 'pre-clean leaves 0 live threads')

  // (1a) Create a thread scoped to a seeded contract
  const list = await api('/api/v1/contracts?page=1&pageSize=10', { headers: auth })
  const msa = (list.body.contracts ?? list.body.data ?? []).find(
    c => /master services/i.test(c.title ?? '') && /acme/i.test(c.title ?? '')
  )
  check(!!msa, 'found seeded Acme MSA to scope a thread to')

  const created = await api('/api/v1/agent/threads', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ scopeType: 'contract', scopeId: msa.id }),
  })
  check(created.status === 200, `(1) POST /threads returns 200 (got ${created.status})`)
  const threadId = created.body.id
  check(typeof threadId === 'string' && threadId.length > 0, `(1) returned thread id (${threadId})`)
  check(created.body.scopeType === 'contract' && created.body.scopeId === msa.id,
        '(1) thread carries scopeType=contract + scopeId')
  check(created.body.title === 'New chat', '(1) default title is "New chat"')

  // (1b) Append a turn
  const turn = await api(`/api/v1/agent/threads/${threadId}/turns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      userMessage: 'What is the liability cap?',
      assistant: {
        content: 'The liability cap is $500,000.',
        provider: 'openai', model: 'gpt-4.1-mini', tier: 'default',
      },
      toolCalls: [
        {
          id: 'tc_1', toolName: 'clause_search',
          args: { contract_id: msa.id, query: 'liability cap' },
          status: 'success',
          result: '{"matches":[{"sectionHint":"9.2","match":"LIABILITY CAP"}]}',
        },
      ],
    }),
  })
  check(turn.status === 200, `(1) POST /threads/:id/turns returns 200 (got ${turn.status})`)
  check(typeof turn.body.userMessageId === 'string' && typeof turn.body.assistantMessageId === 'string',
        '(1) turn response returns both message ids')
  check(Array.isArray(turn.body.toolCallIds) && turn.body.toolCallIds.length === 1,
        '(1) turn response returns tool call id')

  // (1c) Fetch the full thread and assert shape
  const full = await api(`/api/v1/agent/threads/${threadId}`, { headers: auth })
  check(full.status === 200, '(1) GET /threads/:id returns 200')
  check((full.body.messages ?? []).length === 2, `(1) thread has 2 messages (got ${full.body.messages?.length})`)
  const userMsg = full.body.messages?.[0]
  const asstMsg = full.body.messages?.[1]
  check(userMsg?.role === 'user' && JSON.stringify(userMsg.content).includes('liability cap'),
        '(1) user message persisted as content block with original text')
  check(asstMsg?.role === 'assistant' && asstMsg.provider === 'openai' && asstMsg.model === 'gpt-4.1-mini',
        '(1) assistant message carries provider + model metadata')
  check((full.body.toolCalls ?? []).length === 1 && full.body.toolCalls[0].toolName === 'clause_search',
        '(1) tool call row persisted with toolName=clause_search')
  check(full.body.toolCalls?.[0]?.input?.query === 'liability cap',
        '(1) tool call input preserved')

  // (1d) Title backfills from first user message
  check(/liability cap/i.test(full.body.title ?? ''),
        `(1) title backfilled from first user message (got ${JSON.stringify(full.body.title)})`)

  // (2) Scope filter — list with scopeType=contract&scopeId=msa.id returns the thread
  const scopedList = await api(`/api/v1/agent/threads?scopeType=contract&scopeId=${msa.id}`, { headers: auth })
  const hasThread = (scopedList.body.threads ?? []).some(t => t.id === threadId)
  check(hasThread, '(2) scoped list includes the thread')
  check((scopedList.body.threads?.[0]?.messageCount ?? 0) >= 2,
        `(2) list response includes messageCount (got ${scopedList.body.threads?.[0]?.messageCount})`)

  // Scoped list with a different scopeId returns empty
  const wrongScope = await api(`/api/v1/agent/threads?scopeType=contract&scopeId=does-not-exist`, { headers: auth })
  check((wrongScope.body.threads ?? []).length === 0, '(2) wrong scope id returns empty list')

  // (3) Cross-tenant — forge a token with a bogus orgId via JWT and expect 404
  //     (reuses existing JWT secret).
  const badTok = signToken('bad-user', 'org-that-doesnt-exist')
  if (badTok) {
    const crossTenant = await api(`/api/v1/agent/threads/${threadId}`, {
      headers: { authorization: `Bearer ${badTok}` },
    })
    check(crossTenant.status === 404, `(3) cross-tenant GET returns 404 (got ${crossTenant.status})`)
  } else {
    console.log('  (skip) (3) cross-tenant probe — could not mint test token')
  }

  // (4) DELETE archives; thread no longer in list
  const del = await api(`/api/v1/agent/threads/${threadId}`, { method: 'DELETE', headers: auth })
  check(del.status === 200 && del.body.archived === true, '(4) DELETE returns archived=true')
  const afterDelete = await api('/api/v1/agent/threads?limit=100', { headers: auth })
  check(!(afterDelete.body.threads ?? []).some(t => t.id === threadId),
        '(4) archived thread no longer in list')
  // But GET /:id still works (soft-delete) — useful for undoing
  const getArchived = await api(`/api/v1/agent/threads/${threadId}`, { headers: auth })
  check(getArchived.status === 200 && getArchived.body.archivedAt,
        '(4) archived thread still fetchable with archivedAt set')

  // (5) End-to-end through the rail UI — send one turn, confirm persistence
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  await page.getByTestId('side-agent-composer').fill('Does this MSA have an auto-renewal clause? Answer yes or no.')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  // Turn-persistence POST happens in the finally — give it a moment.
  await page.waitForTimeout(800)

  const listAfterUi = await api(`/api/v1/agent/threads?scopeType=contract&scopeId=${msa.id}`, { headers: auth })
  const railThread = (listAfterUi.body.threads ?? [])[0]
  check(!!railThread, '(5) rail-created thread appears in list')
  check(railThread?.messageCount === 2, `(5) rail thread has 2 persisted messages (got ${railThread?.messageCount})`)
  check(/auto-renewal/i.test(railThread?.title ?? ''),
        `(5) rail thread title derived from the user message (got ${JSON.stringify(railThread?.title)})`)

  await browser.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.6a persistence checks pass')
})().catch(e => { console.error(e); process.exit(1) })
