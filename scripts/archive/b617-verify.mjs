#!/usr/bin/env node
// B.6.17 verify — Failed contracts show a Retry button inline;
// clicking it queues re-analysis.
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

  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  await page.screenshot({ path: path.join(OUT, 'b617-list.png'), fullPage: false })

  // Find any Failed row's Retry button
  const retryBtn = page.locator('[data-testid^="retry-"]').first()
  const hasFailedRow = await retryBtn.count() > 0
  assert(hasFailedRow, 'at least one Failed row shows a Retry button')

  if (hasFailedRow) {
    const buttonText = await retryBtn.innerText()
    assert(/Retry/.test(buttonText), `Retry button labelled correctly (got "${buttonText}")`)

    // Click — should NOT navigate (we stopPropagation). Should queue analysis.
    const urlBefore = page.url()
    await retryBtn.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, 'b617-clicked.png'), fullPage: false })
    const urlAfter = page.url()
    assert(urlBefore === urlAfter, `URL unchanged after retry click (still on /contracts)`)

    // The row should briefly show a pipeline phase pill (Queued / Parsing / etc.)
    // or the Failed pill is gone.
    const html = await page.content()
    const progressed = /Queued|Parsing|Classifying|Extracting|Analyzing/.test(html)
    assert(progressed, 'row shows pipeline progress after retry')
  }

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.17 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
