#!/usr/bin/env node
// B.6.6 verify — Quick Actions open modals in place.
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
async function shot(n) { await page.screenshot({ path: path.join(OUT, n), fullPage: false }) }

let fail = 0
function assert(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++ }

try {
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await page.waitForLoadState('networkidle')

  // 1. Click "Upload Contract" — modal opens, URL does NOT change to /contracts
  const urlBefore = page.url()
  await page.click('[data-testid="quick-upload-contract"]')
  await page.waitForTimeout(400)
  await shot('b66-upload-modal.png')
  const urlAfter = page.url()
  assert(urlBefore === urlAfter, `URL unchanged after click (before=${urlBefore}, after=${urlAfter})`)
  // Modal presence — the UploadModal has a drop-zone with the "Drag & drop" or "Select files" text
  const hasDropzone = await page.locator('text=/drop|browse files|select files|drag/i').first().isVisible().catch(() => false)
  assert(hasDropzone, 'Upload dropzone is visible')

  // 2. Close modal — modal goes away, still on /dashboard
  const closeBtn = page.locator('button[aria-label="Close"], button:has(svg.lucide-x)').first()
  await closeBtn.click().catch(() => page.keyboard.press('Escape'))
  await page.waitForTimeout(300)
  const closedUrl = page.url()
  assert(closedUrl === urlBefore, `still on /dashboard after close (url=${closedUrl})`)

  // 3. Click "New Request" — NewRequestModal opens in place
  await page.click('[data-testid="quick-new-request"]')
  await page.waitForTimeout(400)
  await shot('b66-new-request-modal.png')
  const urlAfter2 = page.url()
  assert(urlBefore === urlAfter2, `URL unchanged after New Request click (url=${urlAfter2})`)
  const requestModalText = await page.locator('text=/new request|request details|priority/i').first().isVisible().catch(() => false)
  assert(requestModalText, 'New Request modal is visible')

  // Close — NewRequestModal has an X button in the header
  const reqClose = page.locator('.fixed.inset-0 button').filter({ hasText: /^$/ }).first()
  await reqClose.click().catch(async () => {
    await page.keyboard.press('Escape').catch(() => {})
  })
  await page.waitForTimeout(300)
  // Fallback: force-reload dashboard so any stuck modal goes away
  if (await page.locator('text=New Contract Request').isVisible().catch(() => false)) {
    await page.goto(`${WEB}/dashboard`)
    await page.waitForLoadState('networkidle')
  }

  // 4. "View Approvals" should still navigate (it's a pure navigation)
  await page.click('[data-testid="quick-view-approvals"]')
  await page.waitForURL('**/approvals', { timeout: 5_000 })
  assert(page.url().endsWith('/approvals'), 'View Approvals still navigates to /approvals')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.6 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
