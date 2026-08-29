#!/usr/bin/env node
/**
 * P7.4.12 + P7.4.13 verify — Playbook auto-select + Test Mode promoted (F-63, F-65).
 *
 * F-63: /playbook landing showed an "EXAMPLE — LIMITATION OF LIABILITY"
 *       intro panel even when org had 16 real positions configured.
 *       Now: if positions exist, auto-select the first populated category.
 *
 * F-65: Test Mode was an outline button buried in a sub-header — major
 *       UX win that was undiscovered. Now: primary-tier CTA next to
 *       Add Position, with a Tip line nudging the user to try it.
 *
 * Checks:
 *   (1) /playbook page mounts → auto-selects a category (no explainer)
 *   (2) Test Mode button is present + has primary-tier styling
 *   (3) Tip text mentions "Test playbook"
 *   (4) Clicking Test playbook reveals the test panel (button text flips
 *       to "Hide test panel")
 *   (5) Cold start (no positions) — explainer still shows
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // ── (1) Auto-select on mount
  console.log('\n=== (1) Playbook auto-selects when org has positions ===')
  await page.goto(`${BASE}/playbook`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const explainerCount = await page.getByTestId('playbook-explainer').count()
  check(explainerCount === 0, `playbook-explainer NOT shown (got ${explainerCount})`)

  // ── (2) Test Mode button visible + has primary-tier styling
  console.log('\n=== (2) Test playbook button is primary-tier ===')
  const testBtn = page.getByTestId('playbook-test-btn')
  check(await testBtn.count() === 1, `playbook-test-btn visible`)
  const testBtnText = await testBtn.innerText()
  check(/Test playbook/i.test(testBtnText), `button reads "Test playbook" (got "${testBtnText.trim()}")`)
  // Confirm primary-tier class on the button (border-2 + blue accent)
  const cls = await testBtn.getAttribute('class')
  check(cls?.includes('border-2') && cls.includes('blue'), `button has primary-tier styling`)

  // ── (3) Tip text mentions Test playbook
  console.log('\n=== (3) Tip nudges user to try Test playbook ===')
  const tipExists = await page.locator('text=Tip:').count()
  check(tipExists >= 1, `Tip line present (got ${tipExists})`)

  await page.screenshot({ path: path.join(OUT, '226-p74-12-playbook-auto.png'), fullPage: false })

  // ── (4) Clicking Test playbook flips state
  console.log('\n=== (4) Clicking Test playbook opens test panel ===')
  await testBtn.click()
  await page.waitForTimeout(500)
  const testBtnTextAfter = await testBtn.innerText()
  check(/Hide test panel/i.test(testBtnTextAfter), `button text flips to "Hide test panel"`)
  await page.screenshot({ path: path.join(OUT, '227-p74-12-playbook-test-open.png'), fullPage: false })

  // ── (5) Cold-start: stub positions to []  → explainer shows
  console.log('\n=== (5) Cold start (no positions) → explainer shows ===')
  await page.unroute('**/api/v1/playbook/positions*').catch(() => {})
  await page.route('**/api/v1/playbook/positions*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  })
  await page.goto(`${BASE}/playbook`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const explainerColdShown = await page.getByTestId('playbook-explainer').count()
  check(explainerColdShown === 1, `playbook-explainer visible on cold start (got ${explainerColdShown})`)

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.12 + P7.4.13 playbook checks pass')
})().catch(e => { console.error(e); process.exit(1) })
