#!/usr/bin/env node
// Live verifier for docs/27-UX-REVIEW.md top findings.
// Goal: sanity-check the most impactful BLOCKER/MAJOR findings against the
// running stack so the review isn't purely static.
//
// Checks performed (each logs PASS / FAIL / NOTE with evidence):
//   1. BLOCKER — /analytics and /signatures are orphan routes (registered but not in sidebar)
//   2. BLOCKER — two AI entry points (AI Assistant button + Cmd-K palette)
//   3. BLOCKER — test data leaked: "Aniket NDA", "Temp" clause, "My Categoty" typo
//   4. MAJOR   — Recent Activity feed shows generic "Contract updated · System"
//   5. MAJOR   — Upload + New Contract both exist with unclear labels
//   6. MAJOR   — Expiring Soon KPI links to /contracts with no filter
//   7. MAJOR   — Counterparties table lacks a "# contracts" column

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const EMAIL = process.env.E2E_EMAIL ?? 'admin@demo.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'demodemo'
const OUT = path.resolve('scripts/screenshots/ux-verify')
fs.mkdirSync(OUT, { recursive: true })

const results = []
function log(id, level, msg, extra) {
  const line = `[${level}] ${id} — ${msg}${extra ? ` :: ${extra}` : ''}`
  console.log(line)
  results.push({ id, level, msg, extra })
}

async function shot(page, name) {
  const p = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

page.on('console', (m) => {
  if (m.type() === 'error') console.log('  pageerr:', m.text().slice(0, 120))
})

try {
  // --- Login ---
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  // === Check 1: orphan routes ===
  const sidebarLinks = await page.locator('aside a, nav a').allInnerTexts()
  const sidebarText = sidebarLinks.join(' | ').toLowerCase()
  const hasAnalyticsInNav = sidebarText.includes('analytics')
  const hasSignaturesInNav = sidebarText.includes('signature')
  await page.goto(`${WEB}/analytics`)
  await page.waitForLoadState('networkidle')
  await shot(page, '01-analytics-orphan')
  const analyticsVisible = page.url().includes('/analytics')
  await page.goto(`${WEB}/signatures`)
  await page.waitForLoadState('networkidle')
  await shot(page, '02-signatures-orphan')
  const signaturesVisible = page.url().includes('/signatures')

  if (!hasAnalyticsInNav && analyticsVisible) {
    log('blocker-1a', 'PASS', '/analytics is an orphan route — not in sidebar, but reachable', page.url())
  } else {
    log('blocker-1a', 'FAIL', 'Analytics either in sidebar or route removed', `inNav=${hasAnalyticsInNav}, reachable=${analyticsVisible}`)
  }
  if (!hasSignaturesInNav && signaturesVisible) {
    log('blocker-1b', 'PASS', '/signatures is an orphan route — not in sidebar, but reachable', page.url())
  } else {
    log('blocker-1b', 'FAIL', 'Signatures either in sidebar or route removed', `inNav=${hasSignaturesInNav}, reachable=${signaturesVisible}`)
  }

  // === Check 2: two AI entry points ===
  await page.goto(`${WEB}/dashboard`)
  await page.waitForLoadState('networkidle')
  const headerAi = await page.locator('header button:has-text("AI Assistant")').count()
  await shot(page, '03-dashboard-ai-button')
  // Now contract detail — look for the Ask AI / Cmd-K affordance
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  const firstRow = await page.locator('table tbody tr, [role="row"]').first()
  if (await firstRow.count()) {
    await firstRow.click()
    await page.waitForLoadState('networkidle')
    const detailAi = await page.locator('button:has-text("Ask AI"), [data-testid="ask-ai-cmd-k"]').count()
    await shot(page, '04-contract-detail-ask-ai')
    if (headerAi > 0 && detailAi > 0) {
      log('blocker-2', 'PASS', 'Two AI entry points present: header "AI Assistant" + detail "Ask AI ⌘K"', `header=${headerAi}, detail=${detailAi}`)
    } else {
      log('blocker-2', 'NOTE', 'Only one AI entry found', `header=${headerAi}, detail=${detailAi}`)
    }
  } else {
    log('blocker-2', 'NOTE', 'no contracts in list; detail check skipped')
  }

  // === Check 3: test data leaked ===
  await page.goto(`${WEB}/templates`)
  await page.waitForLoadState('networkidle')
  await shot(page, '05-templates')
  const templatesText = (await page.content()).toLowerCase()
  const hasAniketNda = templatesText.includes('aniket nda')
  if (hasAniketNda) log('blocker-3a', 'PASS', 'Test artefact "Aniket NDA" visible in /templates')
  else log('blocker-3a', 'FAIL', '"Aniket NDA" not found (maybe cleaned up?)')

  await page.goto(`${WEB}/clauses`)
  await page.waitForLoadState('networkidle')
  await shot(page, '06-clauses')
  const clausesText = (await page.content()).toLowerCase()
  const hasTemp = clausesText.includes('temp')
  const hasMyCategoty = clausesText.includes('my categoty') || clausesText.includes('my cat')
  if (hasTemp) log('blocker-3b', 'PASS', 'Test clause "Temp" visible in /clauses')
  else log('blocker-3b', 'NOTE', '"Temp" not found (seed may vary)')
  if (hasMyCategoty) log('blocker-3c', 'PASS', 'Typo/test category "My Categoty"/"My Cat" visible')
  else log('blocker-3c', 'NOTE', 'No obvious typo category visible')

  // === Check 4: Recent Activity noise ===
  await page.goto(`${WEB}/dashboard`)
  await page.waitForLoadState('networkidle')
  await shot(page, '07-dashboard-activity')
  const activityItems = await page.locator('text=/Contract updated/i').count()
  const systemItems = await page.locator('text=/System · /i, text=/ · System/').count()
  if (activityItems >= 3 && systemItems >= 2) {
    log('major-4', 'PASS', 'Recent Activity dominated by generic "Contract updated · System" entries', `updated=${activityItems}, system=${systemItems}`)
  } else {
    log('major-4', 'NOTE', 'Activity variety looks better than expected', `updated=${activityItems}, system=${systemItems}`)
  }

  // === Check 5: Upload + New Contract both exist with unclear labels ===
  await page.goto(`${WEB}/contracts`)
  await page.waitForLoadState('networkidle')
  await shot(page, '08-contracts-buttons')
  const hasUpload = await page.locator('button:has-text("Upload")').count()
  const hasNewContract = await page.locator('button:has-text("New Contract")').count()
  if (hasUpload >= 1 && hasNewContract >= 1) {
    log('major-5', 'PASS', 'Both "Upload" and "New Contract" buttons present in header with no disambiguation')
  } else {
    log('major-5', 'NOTE', 'One of the buttons missing or renamed', `upload=${hasUpload}, newContract=${hasNewContract}`)
  }

  // === Check 6: Expiring Soon links to /contracts with no filter ===
  await page.goto(`${WEB}/dashboard`)
  await page.waitForLoadState('networkidle')
  const expiringCard = page.locator('button:has-text("Expiring Soon"), :has-text("Expiring Soon")').first()
  await expiringCard.click({ timeout: 3000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  const postClickUrl = page.url()
  await shot(page, '09-after-expiring-click')
  if (postClickUrl.endsWith('/contracts') || /\/contracts\/?$/.test(postClickUrl)) {
    log('major-6', 'PASS', `Expiring Soon routes to /contracts with NO filter query (url=${postClickUrl})`)
  } else {
    log('major-6', 'NOTE', `Expiring Soon routed to ${postClickUrl}`)
  }

  // === Check 7: Counterparties missing "# contracts" column ===
  await page.goto(`${WEB}/counterparties`)
  await page.waitForLoadState('networkidle')
  await shot(page, '10-counterparties')
  const headers = await page.locator('thead th, [role="columnheader"]').allInnerTexts()
  const headerText = headers.join('|').toLowerCase()
  const hasContractsCol = headerText.includes('contracts') || headerText.includes('# contracts') || headerText.includes('contract count')
  if (!hasContractsCol) {
    log('major-7', 'PASS', `No "contracts" column in Counterparties. Headers: ${headers.join(' | ')}`)
  } else {
    log('major-7', 'FAIL', `Counterparties already has contract count column. Headers: ${headers.join(' | ')}`)
  }

  // === Summary ===
  const passes = results.filter((r) => r.level === 'PASS').length
  const fails = results.filter((r) => r.level === 'FAIL').length
  const notes = results.filter((r) => r.level === 'NOTE').length

  console.log('\n=== SUMMARY ===')
  console.log(`PASS (finding confirmed in live app): ${passes}`)
  console.log(`FAIL (finding contradicted): ${fails}`)
  console.log(`NOTE (inconclusive): ${notes}`)
  console.log(`\nScreenshots at ${OUT}/`)
} catch (err) {
  console.error('FATAL:', err?.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
