#!/usr/bin/env node
/**
 * U.6.3 verify — Forgot password real flow.
 *
 * (1) Endpoint POST /auth/request-password-reset returns ok:true
 * (2) Admin gets a PASSWORD_RESET_REQUEST notification
 * (3) Bogus email format returns 400 (validation)
 * (4) Unknown email returns ok:true (no enumeration leak)
 * (5) UI: clicking "Forgot password?" opens the new dialog
 *      with email input + submit button (NOT the old stub)
 * (6) UI: submitting transitions to success state
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API = 'http://localhost:3001'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

// ── (1) Endpoint happy path
console.log('\n=== (1) POST /auth/request-password-reset returns ok ===')
const okRes = await fetch(`${API}/api/v1/auth/request-password-reset`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maya@demo.com' }),
})
const okBody = await okRes.json()
check(okRes.status === 200, `200 status (got ${okRes.status})`)
check(okBody.ok === true, `body.ok === true`)
check(typeof okBody.message === 'string' && okBody.message.length > 20, `helpful message returned`)

// ── (2) Admin received notification
console.log('\n=== (2) Admin notification created ===')
// give the background task a moment to fire
await new Promise(r => setTimeout(r, 500))
const adminTokenRes = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
})
const { accessToken: adminTok } = await adminTokenRes.json()
const notif = await fetch(`${API}/api/v1/approvals/notifications?limit=20`, {
  headers: { Authorization: `Bearer ${adminTok}` },
}).then(r => r.json())
const found = (notif.data ?? []).find(n => n.type === 'PASSWORD_RESET_REQUEST')
check(!!found, `PASSWORD_RESET_REQUEST notification exists for admin`)
if (found) {
  check(/maya@demo\.com/i.test(found.body), `notification body mentions requesting user`)
  check(/admin/i.test(found.body), `notification suggests an action ("Admin → Users")`)
}

// ── (3) Bad email format returns 400
console.log('\n=== (3) Validation: bad email → 400 ===')
const badRes = await fetch(`${API}/api/v1/auth/request-password-reset`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'not-an-email' }),
})
check(badRes.status === 400, `400 status (got ${badRes.status})`)

// ── (4) Unknown email still returns ok (no leak)
console.log('\n=== (4) Account-existence not leaked ===')
const ghostRes = await fetch(`${API}/api/v1/auth/request-password-reset`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'noone-here-at-all-12345@example.com' }),
})
const ghostBody = await ghostRes.json()
check(ghostRes.status === 200, `unknown email → 200 (got ${ghostRes.status})`)
check(ghostBody.ok === true, `body.ok === true even for unknown email`)
// And the message must be IDENTICAL to the happy-path one — otherwise an attacker can enumerate.
check(ghostBody.message === okBody.message, `same message — no enumeration via copy diff`)

// ── (5)+(6) UI flow
const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })

console.log('\n=== (5) UI: dialog opens with input (not old stub) ===')
await page.locator('[data-testid="forgot-password-link"]').click()
await page.waitForTimeout(400)

const dlgVisible = await page.locator('[data-testid="forgot-password-dialog"]').isVisible()
check(dlgVisible, `forgot-password-dialog visible`)
const emailInput = await page.locator('[data-testid="forgot-password-email"]').count()
check(emailInput === 1, `email input present (this is the real form, not the stub)`)
const submitBtn = await page.locator('[data-testid="forgot-password-submit"]').count()
check(submitBtn === 1, `"Notify my admin" button present`)

await page.screenshot({ path: path.join(OUT, 'u6-3-forgot-form.png'), fullPage: false })

console.log('\n=== (6) UI: submit transitions to success state ===')
await page.locator('[data-testid="forgot-password-email"]').fill('maya@demo.com')
await page.locator('[data-testid="forgot-password-submit"]').click()
await page.waitForTimeout(1500)

const success = await page.locator('[data-testid="forgot-password-close"]').count()
check(success === 1, `success state shown (Back to sign in button)`)
const dlgText = await page.locator('[data-testid="forgot-password-dialog"]').innerText()
check(/notified|administrator|temporary password/i.test(dlgText), `success copy mentions admin / reset`)

await page.screenshot({ path: path.join(OUT, 'u6-3-forgot-success.png'), fullPage: false })

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.6.3 forgot-password checks pass')
