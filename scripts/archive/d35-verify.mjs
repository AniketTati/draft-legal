#!/usr/bin/env node
/**
 * D.3.5 verify — Undo on reversible actions (15-min window).
 *
 *   (1) Apply a comment_add action → Applied receipt has Undo button
 *   (2) Click Undo → receipt transitions to Undone + row soft-deleted
 *   (3) Second-click on the undone row returns 409 (idempotent guard)
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

;(async () => {
  reseed()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?page=1&pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const msa = (list.contracts ?? list.data ?? []).find(c => /Acme.*Master Services/i.test(c.title ?? ''))

  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Create a persisted thread
  await page.getByTestId('side-agent-composer').fill('Brief summary please')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)

  const probe = `D.3.5 undo probe ${Date.now()}`
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d35',
    toolName: 'comment_add',
    summary: 'Add a comment asking about wilful misconduct carve-outs.',
    args: { contractId: msa.id, clauseRef: '§9.2', body: probe },
    target: 'Acme MSA · §9.2',
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(300)

  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 10_000 })
  const status1 = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(status1 === 'applied', `(1) applied receipt rendered (got ${status1})`)

  const undoBtn = page.getByTestId('action-preview-undo')
  const undoVisible = await undoBtn.isVisible().catch(() => false)
  check(undoVisible, '(1) Undo button visible on applied receipt (within 15-min window)')

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/89-d35-applied-with-undo.png'), fullPage: false })

  // (2) Click Undo
  await undoBtn.click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )
  const status2 = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(status2 === 'undone', `(2) receipt data-status=undone (got ${status2})`)

  // Confirm the comment is soft-deleted in DB
  const cmtResp = await fetch(`http://localhost:3001/api/v1/contracts/${msa.id}/comments`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const stillVisible = (cmtResp.data ?? []).some(c => c.body === probe)
  check(!stillVisible, '(2) comment no longer visible in GET /comments (soft-deleted)')

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/90-d35-undone-receipt.png'), fullPage: false })

  // (3) Idempotency — a second undo via direct API returns 409
  // Grab the toolCallId from the rail's state via DB
  const thread = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-agent') ?? '{}').state?.activeThread ?? null }
    catch { return null }
  })
  const t = await fetch(`http://localhost:3001/api/v1/agent/threads/${thread.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const tc = (t.toolCalls ?? []).find(x => x.toolName === 'comment_add')
  const r2 = await fetch(`http://localhost:3001/api/v1/agent/threads/${thread.id}/actions/${tc.id}/undo`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  })
  check(r2.status === 409, `(3) second undo returns 409 (got ${r2.status})`)

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.3.5 Undo checks pass')
})().catch(e => { console.error(e); process.exit(1) })
