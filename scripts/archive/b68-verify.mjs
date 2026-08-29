#!/usr/bin/env node
// B.6.8 verify — placeholder titles no longer appear in the contracts list.
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
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  // Wait for loader to disappear
  await page.waitForFunction(() => !document.body.innerText.includes('Loading contracts…'), { timeout: 10_000 })
  await shot('b68-contracts-list.png')

  const html = (await page.content())
  assert(!/Unnamed Contract - No Identified Parties/.test(html), 'no "Unnamed Contract - No Identified Parties" in list')
  assert(!/Unidentified Contract - Missing Party Details/.test(html), 'no "Unidentified Contract - Missing Party Details" in list')
  // The fallback appears — either the filename or "Untitled contract"
  const fallbackVisible = /Untitled contract/.test(html) || /\.pdf/.test(html)
  assert(fallbackVisible, 'fallback title (filename or "Untitled contract") visible')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.8 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
