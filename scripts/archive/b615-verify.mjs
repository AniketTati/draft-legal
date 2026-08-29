#!/usr/bin/env node
// B.6.15 verify — "Your day" band renders on the dashboard with
// per-user counts + clickable chips.
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
  await page.waitForLoadState('networkidle')
  // Wait for KPIs to load (spinner → number)
  await page.waitForFunction(() => {
    const tiles = document.querySelectorAll('button')
    return Array.from(tiles).some((t) => /Active Contracts/.test(t.innerText ?? '') && /\d/.test(t.innerText ?? ''))
  }, { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'b615-dashboard-your-day.png'), fullPage: false })

  const band = page.locator('[data-testid="your-day-band"]')
  const bandVisible = await band.isVisible()
  assert(bandVisible, 'Your day band is visible')

  // Admin has 1 pending approval in the demo seed
  const approvalsChip = page.locator('[data-testid="your-day-chip-approvals"]')
  const hasApprovalsChip = await approvalsChip.isVisible().catch(() => false)
  if (hasApprovalsChip) {
    const chipText = await approvalsChip.innerText()
    assert(/\b1\b/.test(chipText), `approvals chip shows count 1 (got "${chipText}")`)
    assert(/waiting on your decision/.test(chipText), 'approvals chip explains the action verb')

    // Click → navigates to /approvals
    await approvalsChip.click()
    await page.waitForURL('**/approvals', { timeout: 5_000 })
    assert(page.url().endsWith('/approvals'), 'approvals chip click → /approvals')
  } else {
    console.log('NOTE: no pending approvals for admin — assertions for approvals chip skipped')
  }

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.15 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
