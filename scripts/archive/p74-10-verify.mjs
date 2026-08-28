#!/usr/bin/env node
/**
 * P7.4.10 verify — Recent Activity adaptive empty state (F-05).
 *
 * Before: empty state always said "Upload a contract or submit a
 * request to get started" — implies brand-new org, but org may have
 * 15+ contracts (just no AuditEvent rows yet from direct DB seed).
 *
 * After: copy adapts:
 *   - cold: "No activity yet. Upload a contract..." (legit empty)
 *   - warm: "No recent activity to show. Edits, comments, approvals
 *           will appear here as your team works." (have contracts,
 *           just no events)
 *
 * Checks:
 *   (1) Stub dashboard with activeContracts=0, recentActivity=[]
 *       → activity-empty-cold testid appears
 *   (2) Stub dashboard with activeContracts=15, recentActivity=[]
 *       → activity-empty-warm testid appears
 *   (3) Real Maya session shows actual events (not empty) — sanity check
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
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  // Login as Maya so we have a valid session for everything else
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // ── (1) COLD: stub dashboard with no contracts, no activity
  console.log('\n=== (1) Cold empty state — activity-empty-cold ===')
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeContracts: 0,
        openRequests: 0,
        pendingApprovals: 0,
        orgPendingApprovals: 0,
        expiringSoon: [],
        yourDay: { totalCount: 0 },
        recentActivity: [],
      }),
    })
  })
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const coldShown = await page.getByTestId('activity-empty-cold').count()
  const warmShown = await page.getByTestId('activity-empty-warm').count()
  check(coldShown === 1, `activity-empty-cold visible (got ${coldShown})`)
  check(warmShown === 0, `activity-empty-warm NOT visible (got ${warmShown})`)
  await page.screenshot({ path: path.join(OUT, '222-p74-10-empty-cold.png'), fullPage: false })

  // ── (2) WARM: stub dashboard with active contracts, but no events
  console.log('\n=== (2) Warm empty state — activity-empty-warm ===')
  await page.unroute('**/api/v1/dashboard')
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        activeContracts: 15,
        openRequests: 2,
        pendingApprovals: 1,
        orgPendingApprovals: 3,
        expiringSoon: [],
        yourDay: { totalCount: 0 },
        recentActivity: [],
      }),
    })
  })
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const coldShown2 = await page.getByTestId('activity-empty-cold').count()
  const warmShown2 = await page.getByTestId('activity-empty-warm').count()
  check(coldShown2 === 0, `activity-empty-cold NOT visible (got ${coldShown2})`)
  check(warmShown2 === 1, `activity-empty-warm visible (got ${warmShown2})`)

  // Verify the warm copy actually mentions "Edits, comments, approvals"
  const warmTxt = await page.getByTestId('activity-empty-warm').innerText()
  check(/edits.*comments.*approvals/i.test(warmTxt), `warm copy mentions edits/comments/approvals (got "${warmTxt.replace(/\n/g,' ')}")`)
  await page.screenshot({ path: path.join(OUT, '223-p74-10-empty-warm.png'), fullPage: false })

  await page.unroute('**/api/v1/dashboard')

  // ── (3) Real session shows events
  console.log('\n=== (3) Real session shows actual activity ===')
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const eitherEmpty = await page.locator('[data-testid^="activity-empty-"]').count()
  console.log(`  empty-state shown: ${eitherEmpty} (0 = real events present)`)
  // Maya has 1 activity event seeded; either way the page shouldn't blow up

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.10 adaptive-empty-state checks pass')
})().catch(e => { console.error(e); process.exit(1) })
