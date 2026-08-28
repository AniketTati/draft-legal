#!/usr/bin/env node
// B.6.22 verify — Admin Roles page distinguishes unconfigured roles
// and lets admins toggle their visibility.
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
  await page.goto(`${WEB}/admin/roles`)
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: path.join(OUT, 'b622-roles.png'), fullPage: false })

  const html = await page.content()
  // If FINANCE / PROCUREMENT / SALES_REP exist in the seed they should
  // now be tagged "Not yet configured".
  const hasUnconfiguredTag = /Not yet configured/.test(html)
  assert(hasUnconfiguredTag, '"Not yet configured" pill visible on unconfigured roles')

  // Toggle button should be present
  const toggle = page.locator('[data-testid="toggle-unconfigured"]')
  assert(await toggle.isVisible(), 'toggle button visible')

  // Click to hide
  await toggle.click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(OUT, 'b622-hidden.png'), fullPage: false })
  const afterHtml = await page.content()
  assert(!/Not yet configured/.test(afterHtml), 'hidden state — unconfigured roles absent from list')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.22 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
