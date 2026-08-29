#!/usr/bin/env node
/**
 * U.8.1 verify — Settings General + Notifications tabs.
 *
 * (1) /settings has 3 working tabs (Custom Fields | General | Notifications)
 * (2) General tab has profile (name+email) and workspace (currency/date/tz) sections
 * (3) Editing the name + clicking Save persists via PATCH /users/me
 * (4) Notifications tab has 5 trigger toggles + 3 cadence options
 * (5) Toggling a notification persists immediately to user.preferences
 * (6) On reload, the new preference value is what the API returns
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

const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'maya@demo.com')
await page.fill('input[type="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForTimeout(1500)

await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

console.log('\n=== (1) Three working tabs ===')
const tabs = ['Custom Fields', 'General', 'Notifications']
for (const t of tabs) {
  const exists = await page.locator(`aside button:has-text("${t}")`).count()
  check(exists >= 1, `tab "${t}" present`)
}

// Switch to General
console.log('\n=== (2) General tab structure ===')
await page.locator('aside button:has-text("General")').first().click()
await page.waitForTimeout(800)
check(await page.getByTestId('general-tab').count() === 1, `general-tab root rendered`)
check(await page.getByTestId('general-profile').count() === 1, `profile section`)
check(await page.getByTestId('general-workspace').count() === 1, `workspace section`)
check(await page.getByTestId('general-currency').count() === 1, `currency dropdown`)
check(await page.getByTestId('general-date-format').count() === 1, `date format dropdown`)
check(await page.getByTestId('general-timezone').count() === 1, `timezone dropdown`)

await page.screenshot({ path: path.join(OUT, 'u8-1-general-tab.png'), fullPage: false })

console.log('\n=== (3) Save profile name ===')
const newName = `Maya Goldberg ${Math.floor(Math.random() * 1000)}`
await page.getByTestId('general-name-input').fill(newName)
await page.getByTestId('general-save-profile').click()
await page.waitForTimeout(800)
// Verify the API actually has the new name
const tokenRes = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
})
const { accessToken } = await tokenRes.json()
const me = await fetch(`${API}/api/v1/users/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
check(me.name === newName, `API persisted new name (got "${me.name}")`)

console.log('\n=== (4) Notifications tab structure ===')
await page.locator('aside button:has-text("Notifications")').first().click()
await page.waitForTimeout(800)
check(await page.getByTestId('notifications-tab').count() === 1, `notifications-tab root rendered`)
const triggerKeys = ['approvalRequested', 'approvalDecided', 'contractUpdated', 'contractExpiringSoon', 'mentioned']
for (const k of triggerKeys) {
  const ex = await page.getByTestId(`notif-${k}-toggle`).count()
  check(ex === 1, `trigger toggle: ${k}`)
}
check(await page.getByTestId('notif-digest-real-time').count() === 1, `cadence: real-time`)
check(await page.getByTestId('notif-digest-daily').count() === 1, `cadence: daily`)
check(await page.getByTestId('notif-digest-off').count() === 1, `cadence: off`)

await page.screenshot({ path: path.join(OUT, 'u8-1-notifications-tab.png'), fullPage: false })

console.log('\n=== (5) Toggle a notification → persists ===')
// Read current state of contractUpdated, flip it, verify
const beforeChecked = await page.getByTestId('notif-contractUpdated-toggle').isChecked()
await page.getByTestId('notif-contractUpdated-toggle').click()
await page.waitForTimeout(800)
const afterChecked = await page.getByTestId('notif-contractUpdated-toggle').isChecked()
check(beforeChecked !== afterChecked, `toggle flipped in UI (${beforeChecked} → ${afterChecked})`)

console.log('\n=== (6) API has the new toggle value ===')
await page.waitForTimeout(800) // give the mutation time to settle
const me2 = await fetch(`${API}/api/v1/users/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
const persisted = me2?.preferences?.notifications?.contractUpdated
console.log(`  API returns contractUpdated = ${persisted}`)
check(persisted === afterChecked, `notification preference persisted (${persisted} === ${afterChecked})`)

console.log('\n=== (7) Cadence change persists ===')
await page.getByTestId('notif-digest-daily').click()
await page.waitForTimeout(800)
const me3 = await fetch(`${API}/api/v1/users/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
check(me3?.preferences?.notifications?.digest === 'daily', `digest persisted as "daily"`)

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.8.1 Settings tabs checks pass')
