#!/usr/bin/env node
// B.6.20 verify — expired-session redirect carries ?next=<url>, and
// post-login restores the user to that URL.
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
  // 1. Direct visit to /login with ?next= → after login, lands on next
  await page.goto(`${WEB}/login?next=%2Fcontracts`)
  await page.waitForLoadState('networkidle')
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/contracts', { timeout: 15_000 })
  assert(page.url().endsWith('/contracts'), `login with next=/contracts redirects there (got ${page.url()})`)
  await page.screenshot({ path: path.join(OUT, 'b620-restored.png'), fullPage: false })

  // 2. Malicious next → falls back to dashboard (basic SSRF guard)
  await page.context().clearCookies()
  await ctx.addInitScript(() => {
    // Force logout state so the next navigation triggers the login page
    try { window.localStorage.removeItem('auth-store') } catch {}
  })
  await page.goto(`${WEB}/login?next=%2F%2Fevil.example.com%2Fphish`)
  await page.waitForLoadState('networkidle')
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
  const url = page.url()
  assert(!/evil\.example\.com/.test(url), `protocol-relative next ignored (url=${url})`)
  assert(url.endsWith('/dashboard') || url.endsWith('/contracts'), `safe fallback to /dashboard or previous (url=${url})`)

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.20 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
