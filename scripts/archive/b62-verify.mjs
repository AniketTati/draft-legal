#!/usr/bin/env node
// B.6.2 verify — orphan pages now respectful "coming soon" screens
// with description, notify-me form, and a back-to-dashboard link.
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

async function shot(name) {
  const p = path.join(OUT, name)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

let fail = 0
function assert(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg)
  if (!cond) fail++
}

try {
  // Login
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  // --- /analytics ---
  await page.goto(`${WEB}/analytics`)
  await page.waitForLoadState('networkidle')
  await shot('b62-analytics.png')
  const aText = await page.content()
  assert(aText.includes('Launching in v1.1'), '/analytics shows ETA badge')
  assert(aText.includes('Cycle time per contract type'), '/analytics lists capabilities')
  assert(aText.includes('Notify me'), '/analytics has notify-me button')
  assert(aText.includes('Back to dashboard'), '/analytics has back-to-dashboard link')
  assert(await page.locator('button:has-text("Notify me")').count() === 1, '/analytics notify button present once')

  // Click back-to-dashboard
  await page.click('a:has-text("Back to dashboard")')
  await page.waitForURL('**/dashboard', { timeout: 5_000 })
  assert(page.url().endsWith('/dashboard'), 'back-to-dashboard returns to /dashboard')

  // --- /signatures ---
  await page.goto(`${WEB}/signatures`)
  await page.waitForLoadState('networkidle')
  await shot('b62-signatures.png')
  const sText = await page.content()
  assert(sText.includes('In-platform signing'), '/signatures lists capabilities')
  assert(sText.includes('Notify me'), '/signatures has notify-me button')

  // --- Notify flow (analytics) ---
  await page.goto(`${WEB}/analytics`)
  await page.waitForLoadState('networkidle')
  await page.fill('input#notify-email', 'test@acme.com')
  await page.click('button:has-text("Notify me")')
  await page.waitForTimeout(300)
  await shot('b62-analytics-notified.png')
  const afterText = await page.content()
  assert(afterText.includes("We'll email you") || afterText.includes('We\u2019ll email you') || afterText.includes('We\u0026rsquo;ll email'), 'notify confirmation shown')

  // --- No sidebar nav for analytics/signatures ---
  await page.goto(`${WEB}/dashboard`)
  await page.waitForLoadState('networkidle')
  const sidebarLinks = await page.locator('aside a').allInnerTexts()
  const lc = sidebarLinks.join(' | ').toLowerCase()
  assert(!lc.includes('analytics'), 'sidebar does NOT contain analytics (intentional)')
  assert(!lc.includes('signatures'), 'sidebar does NOT contain signatures (intentional)')

  console.log()
  if (fail) {
    console.log(`✗ ${fail} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log(`✓ All B.6.2 checks pass. Screenshots in ${OUT}/`)
  }
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
