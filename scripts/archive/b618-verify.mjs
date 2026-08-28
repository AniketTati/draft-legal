#!/usr/bin/env node
// B.6.18 verify — Clause Library exposes a "New clause" button in
// both the list header and the right-pane empty state.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const EMAIL = process.env.E2E_EMAIL ?? 'admin@demo.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'password123'
const OUT = path.resolve('scripts/screenshots/b6')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

let fail = 0
function assert(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++ }

try {
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`${WEB}/clauses`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'b618-clauses.png'), fullPage: false })

  // 1. The New clause button is visible even without a category selected
  const headerBtn = page.locator('[data-testid="new-clause-button"]')
  assert(await headerBtn.isVisible(), 'New clause button visible in list header')

  // 2. Empty right-pane has its own button
  const emptyBtn = page.locator('[data-testid="empty-new-clause-button"]')
  assert(await emptyBtn.isVisible(), 'New clause button in right-pane empty state')

  // 3. Clicking it opens the editor in the right pane
  await emptyBtn.click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'b618-editor.png'), fullPage: false })
  const editorOpen = await page.locator('text=/^New Clause$/').isVisible().catch(() => false)
  assert(editorOpen, 'editor opens with "New Clause" heading')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.18 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
