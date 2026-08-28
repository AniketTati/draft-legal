#!/usr/bin/env node
// B.6.21 verify — Approvals warns when the org has zero workflow
// definitions.
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
  await page.goto(`${WEB}/approvals`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'b621-approvals.png'), fullPage: false })

  // Check workflow count via the API to decide expectation
  const tokenResp = await page.request.post(`${WEB.replace(':5173', ':3001')}/api/v1/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  })
  const { accessToken } = await tokenResp.json()
  const wfResp = await page.request.get(`${WEB.replace(':5173', ':3001')}/api/v1/approvals/workflows`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const wfBody = await wfResp.json()
  const wfCount = Array.isArray(wfBody?.data) ? wfBody.data.length : 0
  console.log(`  org has ${wfCount} workflow definition(s)`)

  const warningVisible = await page.locator('[data-testid="no-workflows-warning"]').isVisible().catch(() => false)
  if (wfCount === 0) {
    assert(warningVisible, 'warning banner visible when workflow count is 0')
    const html = await page.content()
    assert(/fail quietly|won't know/.test(html), 'warning copy explains the consequence')
    // Clicking "Create workflow →" switches to the Manage Workflows tab
    await page.click('button:has-text("Create workflow")')
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(OUT, 'b621-after-click.png'), fullPage: false })
    const afterHtml = await page.content()
    assert(/Workflow definitions|Manage Workflows/i.test(afterHtml), 'clicking the CTA routes to the workflows tab')
  } else {
    assert(!warningVisible, 'warning banner hidden when workflows already exist')
  }

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.21 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
