#!/usr/bin/env node
// B.6.9 verify — counterparties list shows contract counts + last activity
// + rows are clickable to drill into a filtered contract list.
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
async function shot(n) { await page.screenshot({ path: path.join(OUT, n), fullPage: false }) }

let fail = 0
function assert(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++ }

try {
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await page.goto(`${WEB}/counterparties`)
  await page.waitForLoadState('networkidle')
  await shot('b69-counterparties.png')

  const html = await page.content()
  assert(/Contracts<\/span>/i.test(html) || /Contracts/i.test(html), 'Contracts column header visible')
  assert(/Last activity/i.test(html), 'Last activity column header visible')

  // Find a row with contractCount >= 2 (Massive Dynamic has 2)
  const massiveRow = page.locator('div[role="button"]', { hasText: 'Massive Dynamic' }).first()
  const rowText = await massiveRow.innerText()
  assert(/\b2\b/.test(rowText), `Massive Dynamic row shows count >= 2 (got "${rowText.replace(/\n/g, ' | ')}")`)

  // Click it → navigates to /contracts with the counterpartyId filter + filterLabel
  await massiveRow.click()
  await page.waitForLoadState('networkidle')
  const url = page.url()
  assert(/counterpartyId=/.test(url), `URL contains counterpartyId (url=${url})`)
  assert(/filterLabel=Massive/.test(url), `URL contains filterLabel=Massive Dynamic (url=${url})`)
  // Wait for loading to finish
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  await shot('b69-contracts-filtered-by-cp.png')

  // Chip visible
  const chipVisible = await page.locator('text=/Massive Dynamic/i').first().isVisible()
  assert(chipVisible, 'Counterparty chip visible on contracts list')

  // The list shows 2 contracts for Massive Dynamic
  const countText = await page.locator('text=/\\d+ contracts?/i').first().innerText()
  assert(/^2 contract/i.test(countText), `filtered list shows 2 contracts (got "${countText}")`)

  // Dismiss chip
  const chipX = page.locator('span:has-text("Massive Dynamic") button').first()
  await chipX.click().catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300)
  const urlAfter = page.url()
  assert(!urlAfter.includes('counterpartyId'), `URL after chip removal has no counterpartyId (url=${urlAfter})`)

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.9 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
