#!/usr/bin/env node
// B.6.24 verify — Organization settings: logo preview + color picker.
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
  await page.goto(`${WEB}/admin/org`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'b624-org.png'), fullPage: false })

  // Logo preview area visible (either img if URL is set, or placeholder)
  assert(await page.locator('[data-testid="logo-url"]').isVisible(), 'Logo URL field visible')
  // Native color picker
  const picker = page.locator('[data-testid="brand-color-picker"]')
  assert(await picker.count() > 0, 'native color picker element present')
  const pickerType = await picker.getAttribute('type')
  assert(pickerType === 'color', `picker is input[type=color] (got ${pickerType})`)

  // Hex input synced
  const hex = page.locator('[data-testid="brand-color-hex"]')
  assert(await hex.isVisible(), 'hex input visible alongside picker')

  // Typing a valid hex updates the stored value
  await hex.fill('#ff00aa')
  await page.waitForTimeout(100)
  const pickerValue = await picker.inputValue()
  assert(pickerValue === '#ff00aa', `picker syncs to typed hex (got ${pickerValue})`)
  await page.screenshot({ path: path.join(OUT, 'b624-color-updated.png'), fullPage: false })

  // Invalid hex → picker falls back to default without crashing
  await hex.fill('notacolor')
  await page.waitForTimeout(100)
  const pickerValueAfter = await picker.inputValue()
  assert(/^#[0-9a-f]{6}$/i.test(pickerValueAfter), `picker falls back to valid hex for invalid input (got ${pickerValueAfter})`)

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.24 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
