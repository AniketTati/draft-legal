#!/usr/bin/env node
/**
 * U.8 verify — Polish.
 *
 * (1) Sidebar nav says "Extraction Queue" (not "Review Queue")
 * (2) /review-queue page heading says "Extraction Queue"
 * (3) URL /review-queue still works (no broken bookmarks)
 * (4) Header user dropdown has avatar with initials
 * (5) Open dropdown shows identity block (name + email)
 * (6) Dropdown has Profile + Settings + Sign out
 * (7) Dropdown is reachable below xl viewport (responsive doesn't break it)
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
const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'maya@demo.com')
await page.fill('input[type="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForTimeout(1500)

// ── (1) Sidebar nav label
console.log('\n=== (1) Sidebar shows "Extraction Queue" ===')
const sidebarText = await page.locator('[data-testid="app-sidebar"]').innerText()
check(/extraction queue/i.test(sidebarText), `nav has "Extraction Queue"`)
check(!/review queue/i.test(sidebarText), `no "Review Queue" left`)

// ── (2) Page heading
console.log('\n=== (2) /review-queue page renamed ===')
await page.locator('[data-testid="nav-review-queue"]').click()
await page.waitForTimeout(1000)
const h1 = await page.locator('[data-testid="review-queue-page"] h1').innerText()
console.log(`  page heading: "${h1.trim()}"`)
check(/extraction queue/i.test(h1), `H1 says Extraction Queue`)

// ── (3) URL preserved
console.log('\n=== (3) URL /review-queue still works ===')
const url = page.url()
check(url.includes('/review-queue'), `URL is still /review-queue (got ${url})`)

// ── (4) Avatar with initials
console.log('\n=== (4) Header user trigger shows initials avatar ===')
const trigger = page.locator('[data-testid="user-menu-trigger"]')
check(await trigger.count() === 1, `user menu trigger present`)
const triggerText = await trigger.innerText()
console.log(`  trigger text: "${triggerText}"`)
check(/MG/.test(triggerText), `avatar shows "MG" initials for Maya Goldberg`)

// ── (5) Dropdown identity block
console.log('\n=== (5) Open dropdown — identity block ===')
await trigger.click()
await page.waitForTimeout(200)
const menu = page.locator('[data-testid="user-menu"]')
check(await menu.isVisible(), `menu opens`)
const nameInMenu = await page.locator('[data-testid="user-menu-name"]').innerText()
const emailInMenu = await page.locator('[data-testid="user-menu-email"]').innerText()
console.log(`  name in menu: "${nameInMenu}" | email: "${emailInMenu}"`)
check(/maya/i.test(nameInMenu), `name shown in menu`)
check(/maya@demo\.com/i.test(emailInMenu), `email shown in menu`)

// ── (6) Items
console.log('\n=== (6) Dropdown items ===')
const profile = await page.locator('[data-testid="user-menu-profile"]').count()
const settings = await page.locator('[data-testid="user-menu-settings"]').count()
const signout = await page.locator('[data-testid="user-menu-logout"]').count()
check(profile === 1, `Profile link`)
check(settings === 1, `Settings link`)
check(signout === 1, `Sign out button`)

await page.screenshot({ path: path.join(OUT, 'u8-user-dropdown.png'), fullPage: false })

// ── (7) Below xl
console.log('\n=== (7) Dropdown still works at 900px viewport ===')
await page.setViewportSize({ width: 900, height: 700 })
await page.waitForTimeout(300)
// Close any open menu first.
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(150)
// Below xl, the rail is a drawer; if it's open it covers the header. Dismiss it.
const railBackdrop = page.locator('[data-testid="side-agent-rail-backdrop"]')
if (await railBackdrop.isVisible().catch(() => false)) {
  await railBackdrop.click({ position: { x: 10, y: 10 } })
  await page.waitForTimeout(250)
}
await page.locator('[data-testid="user-menu-trigger"]').click()
await page.waitForTimeout(200)
const menuVisible = await page.locator('[data-testid="user-menu"]').isVisible()
check(menuVisible, `dropdown still opens at 900px (after dismissing rail drawer)`)
await page.screenshot({ path: path.join(OUT, 'u8-user-dropdown-narrow.png'), fullPage: false })

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.8 polish checks pass')
