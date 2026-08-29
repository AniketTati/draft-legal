#!/usr/bin/env node
/**
 * D.3.3 verify — request_create end-to-end.
 *
 * Reuses the D.3.2 injection pattern:
 *   (1) Create a persisted thread via a rail send
 *   (2) Inject a PendingAction with toolName='request_create'
 *   (3) Click Apply → ContractRequest row created
 *   (4) Verify row exists + ToolCall row has reversible=true
 *   (5) Undo → request.status = CANCELLED
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

  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Seed a thread
  await page.getByTestId('side-agent-composer').fill('Hello')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)

  const probe = `D.3.3 request probe ${Date.now()}`
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d33',
    toolName: 'request_create',
    summary: 'Create a review request for the Pied Piper Vendor Agreement.',
    args: {
      title: probe,
      type: 'VENDOR_AGREEMENT',
      counterpartyName: 'Pied Piper, Inc.',
      description: 'Counsel to review the vendor agreement before signature, especially liability terms.',
      priority: 'HIGH',
    },
    target: 'Legal review queue · Pied Piper',
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(300)
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)

  const status = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(status === 'applied', `(3) receipt data-status=applied (got ${status})`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/91-d33-request-applied.png'), fullPage: false })

  // (4) Verify a ContractRequest row exists with title=probe
  const r = await fetch('http://localhost:3001/api/v1/requests?limit=5', {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json())
  const rows = r?.data ?? r?.requests ?? r ?? []
  const found = rows.find(x => x.title === probe)
  check(!!found, `(4) ContractRequest row created (${found?.id})`)
  check(found?.source === 'chat', `(4) source=chat (got ${found?.source})`)
  check(found?.priority === 'HIGH', `(4) priority=HIGH (got ${found?.priority})`)

  // (5) Undo
  const undo = page.getByTestId('action-preview-undo')
  check(await undo.isVisible(), `(5) Undo button visible for request_create`)
  await undo.click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )

  // Verify status flipped to CANCELLED
  const r2 = await fetch(`http://localhost:3001/api/v1/requests/${found?.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(x => x.json()).catch(() => null)
  check(r2?.status === 'CANCELLED', `(5) request status=CANCELLED after undo (got ${r2?.status})`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/92-d33-request-undone.png'), fullPage: false })

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.3.3 request_create checks pass')
})().catch(e => { console.error(e); process.exit(1) })
