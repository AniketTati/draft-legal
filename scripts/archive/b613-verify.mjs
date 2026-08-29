#!/usr/bin/env node
// B.6.13 verify — clicking the CLM Platform logo in the sidebar
// returns the user to /dashboard from any page.
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

  // Navigate somewhere else
  await page.goto(`${WEB}/counterparties`)
  await page.waitForLoadState('networkidle')

  // The logo should be a link
  const logo = page.locator('[data-testid="logo-home-link"]')
  const tag = await logo.evaluate(el => el.tagName)
  assert(tag === 'A', `logo is an <a> link (got <${tag}>)`)
  const href = await logo.getAttribute('href')
  assert(href === '/dashboard', `logo href is /dashboard (got "${href}")`)
  const ariaLabel = await logo.getAttribute('aria-label')
  assert(/dashboard|home/i.test(ariaLabel ?? ''), `logo has screen-reader label (got "${ariaLabel}")`)

  // Click should navigate back to dashboard
  await logo.click()
  await page.waitForURL('**/dashboard', { timeout: 5_000 })
  assert(page.url().endsWith('/dashboard'), `click navigates to /dashboard (got ${page.url()})`)
  await page.screenshot({ path: path.join(OUT, 'b613-logo-home.png'), fullPage: false })

  // Also works from a contract detail page (deep nesting)
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  const row = page.locator('.grid.cursor-pointer').first()
  await row.click()
  await page.waitForURL(/\/contracts\/[^/]+/, { timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
  await logo.click()
  await page.waitForURL('**/dashboard', { timeout: 5_000 })
  assert(page.url().endsWith('/dashboard'), 'logo click from deep contract detail returns to /dashboard')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.13 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
