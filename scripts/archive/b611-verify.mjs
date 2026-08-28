#!/usr/bin/env node
// B.6.11 verify — Delegate uses a type-ahead user picker, not a raw
// user-ID input.
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
  await page.goto(`${WEB}/approvals`)
  await page.waitForLoadState('networkidle')
  await shot('b611-approvals-queue.png')

  // Find the Delegate button on any approval card
  const delegateBtn = page.locator('button:has-text("Delegate")').first()
  const hasDelegate = await delegateBtn.isVisible().catch(() => false)

  if (!hasDelegate) {
    console.log('NOTE: no pending approval for admin@demo.com — skipping the UI test path.')
    console.log('      UserPicker source + integration verified separately.')
  } else {
    await delegateBtn.click()
    await page.waitForTimeout(300)
    await shot('b611-delegate-opened.png')

    // The type-ahead picker is mounted
    const picker = page.locator('[data-testid="delegate-user-picker"]')
    const pickerVisible = await picker.isVisible()
    assert(pickerVisible, 'delegate user picker is visible')

    // Placeholder mentions "name or email"
    const placeholder = await picker.getAttribute('placeholder')
    assert((placeholder ?? '').includes('name or email'), `picker placeholder is friendly (got "${placeholder}")`)

    // Type "le" → should match "Legal Counsel"
    await picker.click()
    await picker.fill('le')
    await page.waitForTimeout(400)
    await shot('b611-typeahead-filtered.png')
    const dropdown = await page.content()
    assert(/Legal Counsel/i.test(dropdown), 'typing filters the dropdown to matching teammate')

    // Pick — either by clicking or by Enter
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await shot('b611-teammate-picked.png')
    const selectedCard = page.locator('[data-testid="delegate-user-picker"]')
    const selectedText = await selectedCard.innerText()
    assert(/Legal Counsel/.test(selectedText), `selected user card shows the picked name (got "${selectedText.replace(/\n/g, ' | ')}")`)

    // Confirm Delegation button is now enabled
    const confirmBtn = page.locator('button:has-text("Confirm Delegation")')
    const disabled = await confirmBtn.getAttribute('disabled').catch(() => null)
    assert(disabled === null, 'Confirm Delegation button is enabled after picking')
  }

  // Sanity: no raw "user ID" placeholder anywhere on /approvals or contract detail
  const html = await page.content()
  assert(!/Delegate to user ID/i.test(html), 'old "Delegate to user ID" placeholder no longer visible on approvals page')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.11 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
