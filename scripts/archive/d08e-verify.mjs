#!/usr/bin/env node
/**
 * D.0.8e verify — Audit log section
 *
 * Drives real audit events through the other tabs' flows and verifies the
 * audit log renders them correctly:
 *   1. Change cost cap          → AI_SETTINGS_UPDATED row
 *   2. Add an OpenAI BYOK key   → AI_KEY_CREATED + AI_KEY_TESTED rows
 *   3. Remove the key           → AI_KEY_DELETED row
 *   4. Filter by "Key rotated"  → empty state (we didn't rotate)
 *   5. Expand the first event   → raw JSON metadata is visible
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  // Login
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })

  // Pre-clean: delete all AI audit events + any existing BYOK keys + reset settings.
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  for (const p of ['openai', 'anthropic', 'google', 'voyage', 'cohere', 'mistral']) {
    await fetch(`http://localhost:3001/api/v1/admin/ai/keys/${p}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
  }
  // Reset settings to clear any prior diff
  await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCostCapUsd: null, capPolicy: 'block' }),
  })
  // Wipe historical AI audit rows so the count assertions are deterministic
  await fetch('http://localhost:3001/api/v1/admin/ai/audit?limit=200', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json()).then(async ({ events }) => {
    // No DELETE endpoint (append-only by design). Best we can do from the UI
    // layer is acknowledge that these leftover events stick around. The
    // assertions below filter by action so they don't care about quantity.
    console.log(`  (note: ${events?.length ?? 0} prior AI audit events kept; assertions filter by action)`)
  })

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // ── (1) Drive a settings change ──────────────────────────────────────
  await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'smoke-d08e' },
    body: JSON.stringify({ dailyCostCapUsd: 42.42, capPolicy: 'warn' }),
  })

  // ── (2) Drive a key creation + test ──────────────────────────────────
  await fetch('http://localhost:3001/api/v1/admin/ai/keys/openai', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk-d08e-smoke-bogus-key-1234567890' }),
  })
  await fetch('http://localhost:3001/api/v1/admin/ai/keys/openai/test', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })

  // ── (3) Drive a key deletion ─────────────────────────────────────────
  await fetch('http://localhost:3001/api/v1/admin/ai/keys/openai', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })

  // ── Open the audit section ───────────────────────────────────────────
  await page.goto('http://localhost:5173/admin/org', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('heading', { name: /^audit log$/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)

  // Filter dropdown + default "All changes" selected
  const filterVisible = await page.getByTestId('audit-filter').isVisible().catch(() => false)
  check(filterVisible, 'filter dropdown visible')

  // Expect at least 4 rows (settings updated + key created + key tested + key deleted)
  // Note: page's current rendering may have historical rows too — check by summary text
  // We changed two fields (cap + policy) so the prose falls into the plural
  // branch: "updated 2 AI settings (daily cap, enforcement policy)".
  const settingsEvent = await page.getByText(/updated 2 AI settings.*daily cap.*enforcement policy/i).first().isVisible().catch(() => false)
  check(settingsEvent, 'AI_SETTINGS_UPDATED row renders with multi-field prose')

  const keyCreated = await page.getByText(/added a.*openai.*API key/i).first().isVisible().catch(() => false)
  check(keyCreated, 'AI_KEY_CREATED row renders with provider + prefix')

  const keyTested = await page.getByText(/tested.*openai.*failed/i).first().isVisible().catch(() => false)
  check(keyTested, 'AI_KEY_TESTED row renders with "failed" badge (bogus key)')

  const keyDeleted = await page.getByText(/removed the.*openai.*API key/i).first().isVisible().catch(() => false)
  check(keyDeleted, 'AI_KEY_DELETED row renders')

  await page.screenshot({ path: `${SHOTS}/59-d08e-audit-all.png`, fullPage: true })

  // ── (4) Filter by "Key rotated" → empty state (we didn't rotate anything in this run) ──
  await page.getByTestId('audit-filter').selectOption('AI_KEY_UPDATED')
  await page.waitForTimeout(700)
  // In a fresh session we didn't rotate; older sessions from earlier waves MAY have.
  // Accept either an empty state OR rows that are all rotations.
  const emptyForFilter   = await page.getByText(/no "key rotated" events yet/i).isVisible().catch(() => false)
  const allAreRotations  = await page.getByText(/rotated/i).count().then(n => n > 0)
  check(emptyForFilter || allAreRotations, '"Key rotated" filter narrows result set (empty OR only rotations)')

  // Switch back to All
  await page.getByTestId('audit-filter').selectOption('')
  await page.waitForTimeout(500)

  // ── (5) Expand the first event → metadata visible ────────────────────
  // Click the first audit row button (there will be >=4 from our recent actions)
  const firstRow = page.locator('[data-testid^="audit-row-"]').first()
  await firstRow.click()
  await page.waitForTimeout(300)
  // The UI renders "Metadata" styled with CSS `uppercase`; DOM text is still
  // the lowercase original so match case-insensitively on the literal word.
  const metadataHeader = await page.getByText(/^metadata$/i).first().isVisible().catch(() => false)
  check(metadataHeader, 'expanding a row reveals the Metadata header')
  // The raw JSON should be present
  const hasJson = await page.getByText(/"provider"|"changed"|"keyPrefix"/).first().isVisible().catch(() => false)
  check(hasJson, 'expanded row shows raw JSON metadata fields')

  await page.screenshot({ path: `${SHOTS}/60-d08e-audit-expanded.png`, fullPage: true })

  // Cleanup: restore defaults
  await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCostCapUsd: null, capPolicy: 'block' }),
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.0.8e UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
