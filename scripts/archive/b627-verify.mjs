#!/usr/bin/env node
// B.6.27 verify — toast appears after a save and auto-dismisses.
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
  await page.goto(`${WEB}/profile`)
  await page.waitForLoadState('networkidle')

  // Toaster is mounted
  const toaster = page.locator('[data-testid="toaster"]')
  assert(await toaster.count() > 0, 'Toaster mounted in the tree')

  // Save profile → success toast
  await page.click('button[type=submit]')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'b627-toast.png'), fullPage: false })
  const successToast = page.locator('[data-testid="toast-success"]').first()
  assert(await successToast.isVisible(), 'success toast visible after profile save')
  const text = await successToast.innerText()
  assert(/Profile saved/i.test(text), `toast text is "Profile saved" (got "${text.replace(/\n/g, ' | ')}")`)

  // Dismiss button
  await successToast.locator('button[aria-label="Dismiss notification"]').click()
  await page.waitForTimeout(150)
  const stillThere = await page.locator('[data-testid="toast-success"]').count()
  assert(stillThere === 0, 'dismiss button removes the toast')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.27 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
