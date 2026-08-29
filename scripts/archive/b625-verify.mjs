#!/usr/bin/env node
// B.6.25 verify — global search in the header, keyboard shortcut,
// cross-entity results, navigation on pick.
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

  // 1. Trigger is visible
  const trigger = page.locator('[data-testid="global-search-trigger"]')
  assert(await trigger.isVisible(), 'global search trigger visible in header')

  // 2. Click → palette opens
  await trigger.click()
  await page.waitForTimeout(200)
  assert(await page.locator('[data-testid="global-search-input"]').isVisible(), 'palette opens on trigger click')
  await page.screenshot({ path: path.join(OUT, 'b625-empty.png'), fullPage: false })

  // 3. Type "zynga" → WPT Enterprises contract surfaces
  await page.fill('[data-testid="global-search-input"]', 'zynga')
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, 'b625-typed.png'), fullPage: false })
  const html = await page.content()
  assert(/WPT Enterprises|Zynga/.test(html), 'typing "zynga" surfaces matching contract')
  assert(/Contracts/.test(html), 'Contracts group heading present')

  // 4. Enter → navigates to the top hit
  await page.keyboard.press('Enter')
  await page.waitForLoadState('networkidle')
  const url = page.url()
  assert(/\/contracts\//.test(url), `Enter navigates to a contract detail (url=${url})`)
  await page.screenshot({ path: path.join(OUT, 'b625-navigated.png'), fullPage: false })

  // 5. Keyboard shortcut opens from anywhere
  await page.goto(`${WEB}/counterparties`)
  await page.waitForLoadState('networkidle')
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+/`)
  await page.waitForTimeout(200)
  const isOpen = await page.locator('[data-testid="global-search-input"]').isVisible().catch(() => false)
  assert(isOpen, `keyboard shortcut ${modifier}+/ opens the palette from any page`)

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.25 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
