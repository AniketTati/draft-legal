#!/usr/bin/env node
// B.6.14 verify — /register gains password strength meter, confirm
// field, and terms checkbox. Button stays disabled until all three
// are satisfied.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const OUT = path.resolve('scripts/screenshots/b6')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

let fail = 0
function assert(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++ }

try {
  await page.goto(`${WEB}/register`)
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: path.join(OUT, 'b614-register-initial.png'), fullPage: false })

  // Fill everything except the password so we can test the gating
  await page.fill('input[name="orgName"]', 'Acme Corp')
  await page.fill('input[name="name"]', 'Jane Smith')
  await page.fill('input[name="email"]', 'jane+b614@acme.test')

  // Weak password → strength meter appears, button stays disabled
  await page.fill('input[name="password"]', 'abc')
  await page.waitForTimeout(100)
  const strengthVisible = await page.locator('[data-testid="password-strength"]').isVisible()
  assert(strengthVisible, 'password strength meter shown for any password')
  const weakHtml = await page.content()
  assert(/Weak/.test(weakHtml), 'weak label appears for short password')
  await page.screenshot({ path: path.join(OUT, 'b614-weak.png'), fullPage: false })

  // Stronger password
  await page.fill('input[name="password"]', 'CorrectHorseBattery42!')
  await page.waitForTimeout(100)
  const strongHtml = await page.content()
  assert(/Strong/.test(strongHtml) || /Good/.test(strongHtml), 'Strong/Good label for robust password')
  await page.screenshot({ path: path.join(OUT, 'b614-strong.png'), fullPage: false })

  // Confirm mismatch
  await page.fill('input[name="confirmPassword"]', 'nope')
  await page.waitForTimeout(100)
  const mismatchHtml = await page.content()
  assert(/Passwords don.?t match/i.test(mismatchHtml), 'mismatch message shown when passwords differ')

  // Still disabled (mismatch)
  let submitDisabled = await page.locator('button[type=submit]').isDisabled()
  assert(submitDisabled, 'Create account button disabled when passwords don\'t match')

  // Fix confirm
  await page.fill('input[name="confirmPassword"]', 'CorrectHorseBattery42!')
  await page.waitForTimeout(100)
  const matchHtml = await page.content()
  assert(/Passwords match/.test(matchHtml), 'match confirmation shown')

  // Still disabled because terms not checked
  submitDisabled = await page.locator('button[type=submit]').isDisabled()
  assert(submitDisabled, 'Create account still disabled until terms checked')

  // Check terms
  await page.locator('[data-testid="terms-checkbox"]').check()
  await page.waitForTimeout(100)
  submitDisabled = await page.locator('button[type=submit]').isDisabled()
  assert(!submitDisabled, 'Create account enabled once everything is satisfied')
  await page.screenshot({ path: path.join(OUT, 'b614-ready.png'), fullPage: false })

  // Terms links present
  const termsLinkVisible = await page.locator('a[href="/terms"]').isVisible()
  const privacyLinkVisible = await page.locator('a[href="/privacy"]').isVisible()
  assert(termsLinkVisible, 'Terms of Service link visible')
  assert(privacyLinkVisible, 'Privacy Policy link visible')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.14 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
