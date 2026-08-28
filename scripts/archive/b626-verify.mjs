#!/usr/bin/env node
// B.6.26 verify — breadcrumbs render on detail pages, each segment
// clickable except the last.
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
  await page.evaluate(() => localStorage.setItem('clm.coach.contract-detail.v1', 'seen'))
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  // Root page — breadcrumb hidden
  await page.waitForLoadState('networkidle')
  let crumbsVisible = await page.locator('[data-testid="breadcrumbs"]').isVisible().catch(() => false)
  assert(!crumbsVisible, 'breadcrumbs hidden on dashboard (root)')

  // Contract detail — breadcrumb shows
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  const row = page.locator('.grid.cursor-pointer').first()
  await row.click()
  await page.waitForURL(/\/contracts\/[^/]+/)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, 'b626-contract-detail.png'), fullPage: false })

  const crumbs = page.locator('[data-testid="breadcrumbs"]')
  assert(await crumbs.isVisible(), 'breadcrumbs visible on contract detail')
  const html = await page.content()
  assert(/Contracts/.test(await crumbs.innerText()), '"Contracts" segment in breadcrumb')

  // Click Contracts segment → back to list
  await crumbs.locator('a:has-text("Contracts")').click()
  await page.waitForURL('**/contracts')
  assert(page.url().endsWith('/contracts'), 'clicking the Contracts segment goes back up one level')

  // Admin subroute: /admin/roles → "Admin › Roles"
  await page.goto(`${WEB}/admin/roles`)
  await page.waitForLoadState('networkidle')
  const adminCrumb = await page.locator('[data-testid="breadcrumbs"]').innerText()
  assert(/Admin/.test(adminCrumb) && /Roles/.test(adminCrumb), `admin subroute shows two-segment breadcrumb (got "${adminCrumb.replace(/\n/g, ' | ')}")`)
  await page.screenshot({ path: path.join(OUT, 'b626-admin-roles.png'), fullPage: false })

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.26 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
