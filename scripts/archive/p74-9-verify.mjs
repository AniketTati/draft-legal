#!/usr/bin/env node
/**
 * P7.4.9 verify — Login logo + sidebar Soon badges (F-06, F-14).
 *
 * F-06: /login had no wordmark — pure text, no brand identity. Now
 *       has a wordmark + icon above "Sign in" with a friendly tag.
 *
 * F-14: /signatures and /analytics were navigable by URL but invisible
 *       in the sidebar. Now they appear under a "Coming soon" section
 *       with explicit "SOON" pill so users know they exist + aren't
 *       confused that they're broken.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  // ── (1) Login wordmark
  console.log('\n=== (1) Login page shows wordmark ===')
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const brand = await page.getByTestId('login-brand').count()
  check(brand === 1, `login-brand block visible`)
  const brandTxt = await page.getByTestId('login-brand').innerText()
  check(/CLM Platform/i.test(brandTxt), `wordmark says "CLM Platform" (got "${brandTxt.replace(/\s+/g, ' ')}")`)

  await page.screenshot({ path: path.join(OUT, '220-p74-9-login-logo.png'), fullPage: false })

  // ── (2) Sidebar Coming soon section
  console.log('\n=== (2) Sidebar shows Coming soon items with badges ===')
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2000)

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  const signaturesNav = await page.getByTestId('nav-signatures').count()
  const analyticsNav  = await page.getByTestId('nav-analytics').count()
  check(signaturesNav === 1, `nav-signatures link visible`)
  check(analyticsNav === 1, `nav-analytics link visible`)

  const signaturesBadge = await page.getByTestId('badge-soon-signatures').count()
  const analyticsBadge  = await page.getByTestId('badge-soon-analytics').count()
  check(signaturesBadge === 1, `Soon badge on /signatures visible`)
  check(analyticsBadge === 1, `Soon badge on /analytics visible`)

  // Verify the section header reads "Coming soon"
  const comingSoonHeader = await page.locator('text=Coming soon').count()
  check(comingSoonHeader >= 1, `"Coming soon" section label visible`)

  await page.screenshot({ path: path.join(OUT, '221-p74-9-sidebar-soon.png'), fullPage: false })

  // ── (3) Click /signatures — page renders ComingSoon stub
  console.log('\n=== (3) Clicking /signatures opens the stub ===')
  await page.getByTestId('nav-signatures').click()
  await page.waitForTimeout(800)
  const onSignatures = page.url().endsWith('/signatures')
  check(onSignatures, `URL = /signatures (got ${page.url()})`)
  // ComingSoonPage usually has the title prominently
  const sigPageHasSig = await page.locator('text=Signatures').count()
  check(sigPageHasSig >= 1, `page mentions "Signatures"`)

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.9 logo + Soon-badge checks pass')
})().catch(e => { console.error(e); process.exit(1) })
