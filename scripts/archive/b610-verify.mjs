#!/usr/bin/env node
// B.6.10 verify — SSO buttons + Forgot password on /login.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
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
  await page.waitForLoadState('networkidle')
  await shot('b610-login.png')

  const html = await page.content()
  assert(/Continue with Google/.test(html), 'Google SSO button visible')
  assert(/Continue with Microsoft/.test(html), 'Microsoft SSO button visible')
  assert(/Use enterprise SSO \(SAML \/ OIDC\)/.test(html), 'SAML/OIDC SSO link visible')
  assert(/Forgot password\?/.test(html), 'Forgot password link visible')
  assert(/\bor\b/.test(html), 'Divider between SSO and email visible')

  // SSO buttons are ABOVE the email field
  const ssoY = await page.locator('[data-testid="sso-google"]').evaluate(el => el.getBoundingClientRect().top)
  const emailY = await page.locator('input#email').evaluate(el => el.getBoundingClientRect().top)
  assert(ssoY < emailY, `SSO buttons above email field (sso=${Math.round(ssoY)} email=${Math.round(emailY)})`)

  // Click Google → stub dialog explains what's next
  await page.click('[data-testid="sso-google"]')
  await page.waitForTimeout(300)
  await shot('b610-google-stub.png')
  const googleStubHtml = await page.content()
  assert(/Your admin can link/.test(googleStubHtml), 'Google stub explains that admin links workspace')
  assert(/Available in v1\.1/.test(googleStubHtml), 'Google stub shows ETA')

  // Close with "Got it"
  await page.click('button:has-text("Got it")')
  await page.waitForTimeout(200)

  // Click Forgot password → stub explains reset flow
  await page.click('[data-testid="forgot-password-link"]')
  await page.waitForTimeout(300)
  await shot('b610-forgot-password-stub.png')
  const forgotHtml = await page.content()
  assert(/Reset your password/.test(forgotHtml), 'Forgot-password stub shown with correct title')
  assert(/ask your admin to reset/.test(forgotHtml), 'Forgot-password stub offers admin-reset fallback')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.10 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
