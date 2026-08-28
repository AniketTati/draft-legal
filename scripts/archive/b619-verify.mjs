#!/usr/bin/env node
// B.6.19 verify — Playbook page shows an explainer + ghost preview
// before a category is picked, and the preview teaches what a
// populated playbook looks like.
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
  await page.goto(`${WEB}/playbook`)
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: path.join(OUT, 'b619-playbook-explainer.png'), fullPage: false })

  const explainer = page.locator('[data-testid="playbook-explainer"]')
  assert(await explainer.isVisible(), 'playbook explainer visible')

  const html = await page.content()
  assert(/What's a playbook\?/.test(html), 'explainer heading present')
  assert(/ground truth/.test(html), 'explainer explains the purpose')
  assert(/Example — Limitation of Liability/.test(html), 'ghost example preview shown')
  // All 4 position types in the sample
  for (const t of ['PREFERRED', 'ACCEPTABLE', 'FALLBACK', 'WALKAWAY']) {
    assert(new RegExp(t, 'i').test(html), `sample includes ${t} card`)
  }

  // Start-with-first-category button navigates us past the explainer
  await page.locator('[data-testid="pick-first-category"]').click()
  await page.waitForTimeout(400)
  const afterHtml = await page.content()
  assert(!/What's a playbook\?/.test(afterHtml), 'clicking the CTA replaces the explainer with the category editor')
  await page.screenshot({ path: path.join(OUT, 'b619-after-pick.png'), fullPage: false })

  console.log()
  if (fail) { console.log(`✗ ${fail} check(s) failed.`); process.exitCode = 1 }
  else console.log('✓ All B.6.19 checks pass.')
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
