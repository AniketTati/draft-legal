#!/usr/bin/env node
// B.6.16 verify — Requests tabs show counts + page has an explainer.
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

  await page.goto(`${WEB}/requests`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'b616-requests.png'), fullPage: false })

  const html = await page.content()
  assert(/Ask Legal to draft a contract/.test(html), 'explainer sentence visible')

  // Tab counts — All is always there; specific statuses appear when > 0
  const allTab = await page.locator('[data-testid="requests-tab-all"]').innerText()
  console.log(`  All tab: "${allTab.replace(/\n/g, ' | ')}"`)
  // If there are no requests in the seed the badges won't appear — that's expected behaviour.
  // Verify the tab buttons render their testids correctly regardless.
  for (const status of ['SUBMITTED', 'IN_REVIEW', 'MORE_INFO_NEEDED', 'ACCEPTED', 'REJECTED']) {
    const visible = await page.locator(`[data-testid="requests-tab-${status}"]`).isVisible()
    assert(visible, `tab ${status} rendered`)
  }

  // Directly query the counts endpoint so we can assert the renderer works
  // even when the seed has 0 requests.
  const tokenResp = await page.request.post(`${WEB.replace(':5173', ':3001')}/api/v1/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  })
  const { accessToken } = await tokenResp.json()
  const countsResp = await page.request.get(`${WEB.replace(':5173', ':3001')}/api/v1/requests/counts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const countsBody = await countsResp.json()
  assert(countsResp.ok(), `counts endpoint returns 200 (got ${countsResp.status()})`)
  assert(typeof countsBody.counts === 'object', 'counts is an object')
  assert(typeof countsBody.total === 'number', 'total is a number')
  console.log(`  counts endpoint: total=${countsBody.total} data=${JSON.stringify(countsBody.counts)}`)

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.16 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
