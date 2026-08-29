#!/usr/bin/env node
/**
 * D.0.8b verify — log in as admin, open AI Config, exercise the BYOK
 * API-keys section end-to-end through the UI:
 *
 *   1. All 6 provider rows visible with "Not set" pills
 *   2. Click "Add key" on OpenAI → input appears → type bogus key → Save &
 *      test → expect error toast (bogus key rejected by OpenAI) → row now
 *      shows "Failed" pill + prefix
 *   3. Click "Rotate" → input reappears → Cancel → no state change
 *   4. Click "Remove" (confirm dialog auto-accepted) → row returns to "Not set"
 *
 * Each waypoint screenshots so the PR can show the full happy path.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // Auto-accept the confirm() on Remove (single handler — registering on both
  // context and page causes "already handled" when the confirm fires).
  page.on('dialog', d => d.accept().catch(() => {}))

  // ── Login + navigate ─────────────────────────────────────────────────
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.waitForTimeout(600)

  await page.goto('http://localhost:5173/admin/org', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1500)

  // Scroll to the API keys heading
  await page.getByRole('heading', { name: /api keys \(byok\)/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // (1) All 6 provider rows present
  for (const label of ['OpenAI', 'Anthropic', 'Google', 'Voyage', 'Cohere', 'Mistral']) {
    const visible = await page.getByText(label, { exact: true }).first().isVisible().catch(() => false)
    check(visible, `"${label}" row visible`)
  }

  // Initial state: all rows show "Not set" pill (before any keys configured)
  // There may be an existing BYOK row from prior runs → pre-clean via DELETE API
  const tokenBefore = await page.evaluate(() => localStorage.getItem('accessToken'))
  for (const p of ['openai', 'anthropic', 'google', 'voyage', 'cohere', 'mistral']) {
    try {
      await fetch(`http://localhost:3001/api/v1/admin/ai/keys/${p}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokenBefore}` },
      })
    } catch {}
  }
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1000)
  await page.getByRole('heading', { name: /api keys \(byok\)/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)

  const notSetPills = await page.getByText('Not set').count()
  check(notSetPills === 6, `6 "Not set" pills before any keys exist (got ${notSetPills})`)

  await page.screenshot({ path: `${SHOTS}/51-d08b-keys-empty.png`, fullPage: true })

  // (2) Add key flow on OpenAI (first row in the BYOK list)
  await page.getByRole('button', { name: /add key/i }).first().click()
  await page.waitForTimeout(200)
  const inputVisible = await page.getByTestId('byok-input-openai').isVisible().catch(() => false)
  check(inputVisible, `inline editor opens for OpenAI`)

  await page.screenshot({ path: `${SHOTS}/52-d08b-keys-editing.png`, fullPage: true })

  await page.getByTestId('byok-input-openai').fill('sk-proj-bogus-smoke-d08b-test-12345678')
  await page.getByRole('button', { name: /save & test/i }).click()
  // Wait for the test call to resolve (OpenAI will reject) and toast to surface
  await page.waitForTimeout(3500)

  // Row should now show "Failed" pill (bogus key) and a key prefix
  const failedPill = await page.getByText('Failed', { exact: true }).count()
  check(failedPill >= 1, `"Failed" pill visible on OpenAI row after bogus key (got ${failedPill} instance)`)
  const hasPrefix = await page.getByText('sk-proj-', { exact: false }).first().isVisible().catch(() => false)
  check(hasPrefix, `key prefix visible after save`)

  await page.screenshot({ path: `${SHOTS}/53-d08b-keys-after-save.png`, fullPage: true })

  // (3) Rotate → Cancel (no state change)
  await page.getByRole('button', { name: /^rotate$/i }).first().click()
  await page.waitForTimeout(200)
  const inputReopens = await page.getByTestId('byok-input-openai').isVisible().catch(() => false)
  check(inputReopens, `inline editor reopens on Rotate`)
  await page.getByRole('button', { name: /cancel/i }).click()
  await page.waitForTimeout(200)
  const inputGone = await page.getByTestId('byok-input-openai').isVisible().catch(() => false)
  check(!inputGone, `inline editor closes on Cancel`)

  // (4) Remove → row flips back to "Not set"
  await page.getByRole('button', { name: /^remove$/i }).first().click()
  await page.waitForTimeout(1200)
  const finalNotSet = await page.getByText('Not set').count()
  check(finalNotSet === 6, `all 6 rows back to "Not set" after Remove (got ${finalNotSet})`)

  await page.screenshot({ path: `${SHOTS}/54-d08b-keys-after-remove.png`, fullPage: true })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.0.8b UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
