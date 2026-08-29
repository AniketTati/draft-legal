#!/usr/bin/env node
/**
 * D.1.6b verify — Thread picker UI.
 *
 * Preseeds 2 threads via the API then drives the rail:
 *   (1) Header shows current thread title after first turn
 *   (2) Click header → picker panel opens with "New thread" + list
 *   (3) Picker groups by scope when on /contracts/:id
 *   (4) Click a different thread → rail loads its messages + title updates
 *   (5) Click "New thread" from the picker → rail clears + new thread on send
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr || r.stdout); process.exit(1) }
}

async function apiCall(path, opts, token) {
  const res = await fetch(`http://localhost:3001${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts?.headers || {}),
    },
  })
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}

;(async () => {
  reseed()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Login
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })

  // Pre-clean user's threads so assertions are deterministic.
  const preList = await apiCall('/api/v1/agent/threads?limit=100', {}, token)
  for (const t of (preList.body.threads ?? [])) {
    await apiCall(`/api/v1/agent/threads/${t.id}`, { method: 'DELETE' }, token)
  }

  // Fetch the Acme MSA id
  const list = await apiCall('/api/v1/contracts?page=1&pageSize=50', {}, token)
  const contracts = list.body.contracts ?? list.body.data ?? []
  const msa = contracts.find(c => /master services/i.test(c.title ?? '') && /acme/i.test(c.title ?? ''))
  check(!!msa, `found the seeded Acme MSA (${msa?.id})`)

  // Pre-seed two threads on this contract so we can test the picker.
  const t1 = await apiCall('/api/v1/agent/threads', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'contract', scopeId: msa.id }),
  }, token)
  await apiCall(`/api/v1/agent/threads/${t1.body.id}/turns`, {
    method: 'POST',
    body: JSON.stringify({
      userMessage: 'Earlier conversation about auto renewal',
      assistant: { content: 'The MSA auto-renews for 1-year terms unless 90-day notice is given.', provider: 'openai', model: 'gpt-4.1-mini' },
      toolCalls: [],
    }),
  }, token)
  const t2 = await apiCall('/api/v1/agent/threads', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'contract', scopeId: msa.id }),
  }, token)
  await apiCall(`/api/v1/agent/threads/${t2.body.id}/turns`, {
    method: 'POST',
    body: JSON.stringify({
      userMessage: 'What is the governing law?',
      assistant: { content: 'Governing law is Delaware.', provider: 'openai', model: 'gpt-4.1-mini' },
      toolCalls: [],
    }),
  }, token)

  // Enable the rail + open the contract
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // (2) Click the picker trigger → panel opens
  await page.getByTestId('side-agent-thread-picker').click()
  await page.waitForTimeout(400)
  const panelVisible = await page.getByTestId('side-agent-thread-picker-panel').isVisible().catch(() => false)
  check(panelVisible, '(2) picker panel opens on header click')

  // New-thread item + the two seeded rows
  const newBtn = await page.getByTestId('side-agent-thread-picker-new').isVisible().catch(() => false)
  check(newBtn, '(2) "New thread" button visible at top of picker')

  // (3) Both threads should be in the "In this contract" section (since both
  // are scoped to the MSA and we're on /contracts/msa.id)
  const scopeLabel = await page.getByText(/^in this contract$/i).first().isVisible().catch(() => false)
  check(scopeLabel, '(3) picker shows "In this contract" grouping label')

  const rows = await page.locator('[data-testid^="side-agent-thread-picker-row-"]').count()
  check(rows === 2, `(3) picker lists 2 pre-seeded threads (got ${rows})`)

  await page.screenshot({ path: `${SHOTS}/73-d16b-picker-open.png`, fullPage: false })

  // (4) Click a specific thread → messages load + title updates
  // t2 is more recent (created last) so it's on top.
  await page.getByTestId(`side-agent-thread-picker-row-${t2.body.id}`).click()
  await page.waitForTimeout(500)

  const headerTitle = await page.getByTestId('side-agent-thread-picker').textContent()
  check((headerTitle ?? '').includes('governing law') || (headerTitle ?? '').toLowerCase().includes('governing'),
        `(4) header title updated to loaded thread (got ${JSON.stringify((headerTitle ?? '').slice(0, 80))})`)

  const loadedUserMsg = await page.getByTestId('side-agent-msg-user').first().textContent()
  check((loadedUserMsg ?? '').includes('governing law'), `(4) loaded thread's user message visible`)
  const loadedAsst = await page.getByTestId('side-agent-msg-assistant').first().textContent()
  check((loadedAsst ?? '').toLowerCase().includes('delaware'), `(4) loaded thread's assistant reply visible`)

  await page.screenshot({ path: `${SHOTS}/74-d16b-thread-loaded.png`, fullPage: false })

  // (5) Click picker → "New thread" → rail clears
  await page.getByTestId('side-agent-thread-picker').click()
  await page.waitForTimeout(250)
  await page.getByTestId('side-agent-thread-picker-new').click()
  await page.waitForTimeout(250)
  const msgCountAfterNew = await page.locator('[data-testid^="side-agent-msg-"]').count()
  check(msgCountAfterNew === 0, `(5) "New thread" clears message list (got ${msgCountAfterNew} messages)`)
  const headerAfterNew = await page.getByTestId('side-agent-thread-picker').textContent()
  check(/ai assistant/i.test(headerAfterNew ?? ''),
        `(5) header reverts to "AI Assistant" (got ${JSON.stringify((headerAfterNew ?? '').slice(0, 40))})`)

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.6b picker UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
