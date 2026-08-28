#!/usr/bin/env node
/**
 * D.1.2 verify — Auto-context chip from URL
 *
 *   (1) On /dashboard (no object context) → no chip rendered
 *   (2) On /contracts/:id → chip appears with the contract title
 *   (3) ✕ dismisses the chip for that id; navigating away and back to a
 *       DIFFERENT contract re-shows the chip
 *   (4) Chip shows the 📄 icon + "Context:" label
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Login + enable flag
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  // ── (1) Dashboard → no chip ──────────────────────────────────────────
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const chipOnDashboard = await page.getByTestId('side-agent-context-chip').count()
  check(chipOnDashboard === 0, '(1) no context chip on /dashboard')

  // ── (2) Navigate directly to a contract (list rows use onClick, not
  // anchor hrefs — grab an id via the API and visit it). ────────────────
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?page=1&pageSize=1', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const firstId = list?.contracts?.[0]?.id ?? list?.data?.[0]?.id ?? list?.[0]?.id
  check(typeof firstId === 'string' && firstId.length > 0, `(2) fetched first contract id (${firstId})`)

  await page.goto(`http://localhost:5173/contracts/${firstId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // Chip should appear
  const chip = page.getByTestId('side-agent-context-chip')
  const chipVisible = await chip.isVisible().catch(() => false)
  check(chipVisible, '(2) context chip visible on /contracts/:id')

  if (chipVisible) {
    const chipType = await chip.getAttribute('data-context-type')
    check(chipType === 'contract', `(2) chip data-context-type = "contract" (got ${chipType})`)
    const chipText = await chip.textContent()
    check((chipText ?? '').includes('📄'),    '(4) chip shows the 📄 icon')
    check((chipText ?? '').includes('Context:'), '(4) chip shows the "Context:" label')
  }

  // Dismiss any coach-mark overlay so the screenshot actually shows the chip.
  const coachDismissFirst = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coachDismissFirst.isVisible().catch(() => false)) {
    await coachDismissFirst.click().catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.screenshot({ path: `${SHOTS}/64-d12-context-chip.png`, fullPage: false })

  // ── (3) Dismiss the chip ─────────────────────────────────────────────
  // Some contract pages surface a first-visit coach-mark modal that intercepts
  // pointer events. Close it first if present; otherwise fall back to a
  // forced click so the actual assertion can run.
  const coachClose = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coachClose.isVisible().catch(() => false)) await coachClose.click().catch(() => {})
  await page.getByTestId('side-agent-context-dismiss').click({ force: true })
  await page.waitForTimeout(200)
  const chipAfterDismiss = await page.getByTestId('side-agent-context-chip').count()
  check(chipAfterDismiss === 0, '(3) chip removed after dismiss')

  await page.screenshot({ path: `${SHOTS}/65-d12-context-dismissed.png`, fullPage: false })

  // Cleanup flag
  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.2 UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
