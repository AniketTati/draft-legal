#!/usr/bin/env node
// B.6.7 verify — contracts header buttons disambiguated.
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
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await shot('b67-contracts-header.png')

  const uploadVisible = await page.locator('[data-testid="upload-pdf-button"]').isVisible()
  const draftVisible = await page.locator('[data-testid="draft-new-button"]').isVisible()
  assert(uploadVisible, 'Upload PDF button visible')
  assert(draftVisible, 'Draft new button visible')

  const uploadText = await page.locator('[data-testid="upload-pdf-button"]').innerText()
  const draftText = await page.locator('[data-testid="draft-new-button"]').innerText()
  assert(/upload pdf/i.test(uploadText), `Upload button says "Upload PDF" (got "${uploadText}")`)
  assert(/draft new/i.test(draftText), `Draft button says "Draft new" (got "${draftText}")`)

  // Title tooltips explain the difference
  const uploadTitle = await page.locator('[data-testid="upload-pdf-button"]').getAttribute('title')
  const draftTitle = await page.locator('[data-testid="draft-new-button"]').getAttribute('title')
  assert(/existing/i.test(uploadTitle ?? ''), `Upload tooltip mentions existing: "${uploadTitle}"`)
  assert(/template/i.test(draftTitle ?? ''), `Draft tooltip mentions template: "${draftTitle}"`)

  // Click Upload PDF → UploadModal opens
  await page.locator('[data-testid="upload-pdf-button"]').click()
  await page.waitForTimeout(300)
  const hasDropzone = await page.locator('text=/drag & drop|drop or click to browse/i').isVisible()
  assert(hasDropzone, 'Upload PDF button opens file dropzone')
  await shot('b67-upload-pdf-clicked.png')

  // Close
  await page.keyboard.press('Escape').catch(() => {})
  // Force reload to avoid stuck modal
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')

  // Click Draft new → NewContractFlow opens
  await page.locator('[data-testid="draft-new-button"]').click()
  await page.waitForTimeout(400)
  await shot('b67-draft-new-clicked.png')
  // NewContractFlow opens a stepper — the first step mentions a template
  const draftFlowVisible = await page.locator('text=/template|draft|select/i').first().isVisible()
  assert(draftFlowVisible, 'Draft new button opens a flow that mentions templates / drafting')

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log(`✓ All B.6.7 checks pass.`)
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
