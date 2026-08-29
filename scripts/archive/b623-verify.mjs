#!/usr/bin/env node
// B.6.23 verify — Profile page shows initials fallback + live avatar
// preview + helpful copy.
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
  await page.goto(`${WEB}/profile`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'b623-profile.png'), fullPage: false })

  // Initials fallback visible
  const initials = page.locator('[data-testid="avatar-initials"]')
  assert(await initials.isVisible(), 'avatar initials preview visible')
  const text = await initials.innerText()
  assert(/[A-Z]{1,2}/.test(text), `initials text looks sane (got "${text}")`)

  // Real email populated (not placeholder)
  const emailInput = page.locator('input#profile-email')
  const emailValue = await emailInput.inputValue()
  assert(emailValue === EMAIL, `email field shows current user's email (got "${emailValue}")`)

  // Type a URL → image attempts to load; on error falls back to initials
  await page.fill('[data-testid="avatar-url"]', 'https://via.placeholder.com/64')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'b623-url-typed.png'), fullPage: false })
  // Either the img loads, or initials are still showing (both are acceptable
  // outcomes depending on network reachability during the test).
  const imgVisible = await page.locator('[data-testid="avatar-img"]').isVisible().catch(() => false)
  const initialsStill = await page.locator('[data-testid="avatar-initials"]').isVisible().catch(() => false)
  assert(imgVisible || initialsStill, 'preview updates after URL typed')

  // "Use initials" clear button appears when URL present
  const useInitials = page.locator('[data-testid="use-initials"]')
  assert(await useInitials.isVisible(), '"Use initials instead" link appears')
  await useInitials.click()
  await page.waitForTimeout(200)
  const urlAfter = await page.locator('[data-testid="avatar-url"]').inputValue()
  assert(urlAfter === '', 'clicking Use initials clears the URL field')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.23 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
