#!/usr/bin/env node
/**
 * P7.4.14 verify — Counterparty picker on New Request modal (F-56).
 *
 * Before: plain text input — easy to create duplicate counterparties
 * by typing slight variations of an existing name.
 *
 * After: typeahead that fetches existing counterparties as the user
 * types. Click match → links the FK. No match → "Create new
 * counterparty 'X'" affordance creates it inline + links it.
 *
 * Checks:
 *   (1) Open New Request modal → counterparty input is the picker
 *   (2) Type partial name → existing counterparties appear in dropdown
 *   (3) Click an option → input fills + checkmark badge shows
 *   (4) Type a never-seen name → "Create new counterparty 'X'" appears
 *   (5) Click Create → new counterparty exists in /counterparties
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API  = 'http://localhost:3001/api/v1'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // Open Requests page → New Request
  await page.goto(`${BASE}/requests`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Find the New Request button
  const newReq = page.locator('button:has-text("New Request"), button:has-text("+ New Request")').first()
  await newReq.click()
  await page.waitForTimeout(700)

  // ── (1) Picker is mounted
  console.log('\n=== (1) Picker input present ===')
  const pickerInput = page.getByTestId('cp-picker-input')
  check(await pickerInput.count() === 1, `cp-picker-input visible`)

  // ── (2) Type → dropdown with matches
  console.log('\n=== (2) Typing shows existing matches ===')
  await pickerInput.fill('Zyn')
  await page.waitForTimeout(800)
  const dropdownVisible = await page.getByTestId('cp-picker-dropdown').count()
  check(dropdownVisible === 1, `dropdown visible after typing (got ${dropdownVisible})`)
  const optionCount = await page.locator('[data-testid^="cp-picker-option-"]').count()
  check(optionCount >= 1, `≥1 matching option (got ${optionCount})`)

  await page.screenshot({ path: path.join(OUT, '228-p74-14-cp-picker-search.png'), fullPage: false })

  // ── (3) Click option → fills input + linked badge
  console.log('\n=== (3) Click option → linked badge ===')
  await page.locator('[data-testid^="cp-picker-option-"]').first().click()
  await page.waitForTimeout(500)
  const linkedBadge = await page.getByTestId('cp-picker-linked').count()
  check(linkedBadge === 1, `linked checkmark badge visible after picking`)
  const filled = await pickerInput.inputValue()
  check(/Zyn/i.test(filled), `input value reflects picked counterparty (got "${filled}")`)

  // ── (4) Type a never-seen name → Create option
  console.log('\n=== (4) Unknown name shows Create option ===')
  // Clear via the X button so we go back to empty + retype
  const clearBtn = page.getByTestId('cp-picker-clear')
  if (await clearBtn.count() > 0) await clearBtn.click()
  await page.waitForTimeout(200)
  const unique = `P744-Verify-${Date.now()}`
  await pickerInput.fill(unique)
  await page.waitForTimeout(800)
  const createBtn = page.getByTestId('cp-picker-create')
  check(await createBtn.count() === 1, `Create option visible for unknown name`)
  const createTxt = await createBtn.innerText().catch(() => '')
  check(createTxt.includes(unique), `Create button text includes the typed name`)

  await page.screenshot({ path: path.join(OUT, '229-p74-14-cp-picker-create.png'), fullPage: false })

  // ── (5) Click Create → new counterparty exists
  console.log('\n=== (5) Create new → counterparty persists ===')
  await createBtn.click()
  await page.waitForTimeout(1500)
  // Verify the new counterparty exists via API
  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()
  const cpsRes = await fetch(`${API}/counterparties?q=${encodeURIComponent(unique)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const cps = (await cpsRes.json()).data
  check(Array.isArray(cps) && cps.some(c => c.name === unique), `new counterparty "${unique}" persisted`)

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.14 counterparty-picker checks pass')
})().catch(e => { console.error(e); process.exit(1) })
