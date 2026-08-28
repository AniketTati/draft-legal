#!/usr/bin/env node
/**
 * D.0.8d verify — Usage section
 *
 * Covers two states:
 *   (1) Empty (no OrgUsageDaily rows) → empty-state message
 *   (2) Populated (seeds 3 rows via API helper script) → 3 tiles, provider
 *       + tier breakdowns with horizontal bars
 *
 * Uses a small subshell call into the API to seed, runs the flow, then
 * cleans up so re-runs are deterministic.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

function seedUsage(action) {
  // action: "seed" | "clear"
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_d08d-seed-usage.ts', action], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe',
  })
  if (r.status !== 0) {
    console.error('seed helper failed:', r.stderr?.toString() ?? '(no stderr)')
    process.exit(1)
  }
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  // Start from clean state
  seedUsage('clear')

  // ── Login ────────────────────────────────────────────────────────────
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // ── (1) Empty state ──────────────────────────────────────────────────
  await page.goto('http://localhost:5173/admin/org', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('heading', { name: /^usage$/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)

  const emptyMsg = await page.getByText(/no platform-paid calls yet/i).isVisible().catch(() => false)
  check(emptyMsg, '(1) empty state shows "No platform-paid calls yet"')

  await page.screenshot({ path: `${SHOTS}/57-d08d-usage-empty.png`, fullPage: true })

  // ── (2) Populated state ─────────────────────────────────────────────
  seedUsage('seed')
  // Invalidate query by reloading the page
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('heading', { name: /^usage$/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)

  // Three tiles
  for (const label of ['Total spend', 'Calls', 'Tokens']) {
    const has = await page.getByText(label, { exact: true }).first().isVisible().catch(() => false)
    check(has, `(2) "${label}" tile visible`)
  }

  // Total spend = $8.00 (seed puts 2+4+2 across three days)
  const dollar8 = await page.getByText('$8.00', { exact: true }).first().isVisible().catch(() => false)
  check(dollar8, '(2) tile shows $8.00 total')

  // Breakdown headers
  const byProvider = await page.getByText(/by provider/i).isVisible().catch(() => false)
  const byTier     = await page.getByText(/by tier/i).isVisible().catch(() => false)
  check(byProvider, '(2) "By provider" breakdown visible')
  check(byTier,     '(2) "By tier" breakdown visible')

  // Provider/tier rows should appear inside the Usage section's breakdown
  // cards (they also appear as substrings in the Models section dropdowns
  // above, so scope to the Usage section to avoid false matches).
  const usageSection = page.locator('section', { has: page.getByRole('heading', { name: /^usage$/i, level: 2 }) })
  const openai    = await usageSection.getByText('openai',    { exact: true }).first().isVisible().catch(() => false)
  const anthropic = await usageSection.getByText('anthropic', { exact: true }).first().isVisible().catch(() => false)
  check(openai,    '(2) provider row "openai" shown in breakdown')
  check(anthropic, '(2) provider row "anthropic" shown in breakdown')

  const tierDefault = await usageSection.getByText('default', { exact: true }).first().isVisible().catch(() => false)
  const tierFast    = await usageSection.getByText('fast',    { exact: true }).first().isVisible().catch(() => false)
  check(tierDefault, '(2) tier row "default" shown')
  check(tierFast,    '(2) tier row "fast" shown')

  await page.screenshot({ path: `${SHOTS}/58-d08d-usage-populated.png`, fullPage: true })

  // Cleanup
  seedUsage('clear')

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.0.8d UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
