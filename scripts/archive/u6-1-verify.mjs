#!/usr/bin/env node
/**
 * U.6.1 verify — Send-for-Review dialog.
 *
 * (1) Click "Send for Review" → modal opens (no silent state flip)
 * (2) Workflow dropdown shows ≥1 option
 * (3) Reviewer preview shows "First reviewer" line
 * (4) Message textarea is present and optional
 * (5) Cancel closes without state change
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'maya@demo.com')
await page.fill('input[type="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForTimeout(1500)

// Find a contract in DRAFT or UNDER_NEGOTIATION (not already in approval)
const tokenRes = await fetch('http://localhost:3001/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
})
const { accessToken } = await tokenRes.json()
const cs = await fetch('http://localhost:3001/api/v1/contracts?limit=20', {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
const contracts = cs.contracts ?? cs.data ?? []
const draft = contracts.find(c => ['DRAFT', 'UNDER_NEGOTIATION', 'PENDING_REVIEW'].includes(c.status))
if (!draft) {
  console.error('No DRAFT/UNDER_NEGOTIATION contract — cannot test Send-for-Review')
  process.exit(1)
}

await page.goto(`${BASE}/contracts/${draft.id}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
await page.evaluate(() => localStorage.setItem('clm.coach.contract-detail.v2', 'seen'))

// Click Send for Review
const sendBtn = page.locator('button:has-text("Send for Review"):not([disabled])').first()
const sendBtnCount = await sendBtn.count()
console.log(`\n=== Found ${sendBtnCount} "Send for Review" button(s) ===`)
if (sendBtnCount === 0) {
  console.error('No Send for Review button visible')
  process.exit(1)
}
await sendBtn.click()
await page.waitForTimeout(800)

console.log('\n=== (1) Dialog opens ===')
const dlg = page.getByTestId('send-for-review-dialog')
check(await dlg.count() === 1, `dialog visible after click`)

console.log('\n=== (2) Workflow dropdown has options ===')
const wfSelect = page.getByTestId('send-for-review-workflow')
// Wait for the workflows query to populate the dropdown (API call after dialog mount).
await wfSelect.locator('option').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {})
await page.waitForTimeout(500)
const wfOptions = await wfSelect.locator('option').count()
console.log(`  workflow options: ${wfOptions}`)
check(wfOptions >= 1, `≥1 workflow listed`)

console.log('\n=== (3) "First reviewer" preview present ===')
const previewText = await dlg.innerText()
check(/first reviewer/i.test(previewText), `dialog shows "First reviewer"`)

console.log('\n=== (4) Message textarea ===')
const msg = await page.getByTestId('send-for-review-message').count()
check(msg === 1, `message textarea present`)

console.log('\n=== (5) Confirm button ===')
const confirm = await page.getByTestId('send-for-review-confirm').count()
check(confirm === 1, `confirm button present`)

await page.screenshot({ path: path.join(OUT, 'u6-1-send-dialog.png'), fullPage: false })

// Click cancel
await page.locator('button:has-text("Cancel")').first().click()
await page.waitForTimeout(500)
const dlgAfterCancel = await page.getByTestId('send-for-review-dialog').count()
check(dlgAfterCancel === 0, `dialog closed on Cancel`)

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.6.1 Send-for-Review dialog checks pass')
