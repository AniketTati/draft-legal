#!/usr/bin/env node
/**
 * U.7 verify — Responsive layout.
 *
 * Three viewport sizes to confirm the breakpoints fire:
 *   1440px (xl+, full): wide sidebar + in-flex rail
 *   1100px (lg, rail drawer): wide sidebar + rail floats over content
 *    900px (sm, both compact): icon-only sidebar + rail still drawer
 *
 * Per doc 32 §6.7 — narrow screens shouldn't break the layout, just
 * gracefully shed labels and turn the rail into a drawer.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

const br = await chromium.launch({ headless: true })

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
}

// ── Viewport 1: 1440 wide (xl+) — everything visible
{
  console.log('\n=== Viewport 1440 × 900 (xl+) — full layout ===')
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await login(page)

  const sidebar = page.locator('[data-testid="app-sidebar"]')
  const sbBox = await sidebar.boundingBox()
  console.log(`  sidebar width: ${sbBox?.width}px`)
  check(sbBox && sbBox.width >= 200, `sidebar is wide (≥200px)`)

  // Sidebar should show text labels
  const dashLabelVisible = await page.locator('[data-testid="nav-dashboard"]').innerText()
  check(/dashboard/i.test(dashLabelVisible), `nav labels visible at 1440`)

  // Rail backdrop should NOT be visible (in-flex mode)
  const backdrop = page.locator('[data-testid="side-agent-rail-backdrop"]')
  const backdropVisible = await backdrop.isVisible().catch(() => false)
  check(!backdropVisible, `rail backdrop hidden at xl+`)

  await page.screenshot({ path: path.join(OUT, 'u7-1440-full.png'), fullPage: false })
  await ctx.close()
}

// ── Viewport 2: 1100 wide (lg, between 1024 + 1280) — sidebar full, rail drawer
{
  console.log('\n=== Viewport 1100 × 800 (lg, between breakpoints) — rail as drawer ===')
  const ctx = await br.newContext({ viewport: { width: 1100, height: 800 } })
  const page = await ctx.newPage()
  await login(page)

  const sidebar = page.locator('[data-testid="app-sidebar"]')
  const sbBox = await sidebar.boundingBox()
  console.log(`  sidebar width: ${sbBox?.width}px`)
  check(sbBox && sbBox.width >= 200, `sidebar still wide at 1100`)

  // U.8 (revert): rail is ALWAYS in-flex, never a modal overlay. The
  // user controls open/close via the chevron — no backdrop is rendered.
  // Verify the backdrop testid is GONE (we deleted the wrapper).
  const railState = await page.locator('[data-testid="side-agent-rail"]').getAttribute('data-state')
  console.log(`  rail state: ${railState}`)
  if (railState === 'collapsed') {
    await page.locator('[data-testid="side-agent-rail"]').click()
    await page.waitForTimeout(400)
  }
  const backdropCount = await page.locator('[data-testid="side-agent-rail-backdrop"]').count()
  check(backdropCount === 0, `no rail backdrop element exists (rail is always in-flex)`)

  // When the rail is open the page must NOT scroll horizontally (the
  // rail's 420px should sit alongside the content, not overflow).
  const docHasHScroll = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  )
  check(!docHasHScroll, `no horizontal scrollbar with rail expanded at 1100px`)

  await page.screenshot({ path: path.join(OUT, 'u7-1100-rail-drawer.png'), fullPage: false })
  await ctx.close()
}

// ── Viewport 3: 900 wide (below lg + below xl) — both compact
{
  console.log('\n=== Viewport 900 × 700 (below lg) — sidebar icons + rail drawer ===')
  const ctx = await br.newContext({ viewport: { width: 900, height: 700 } })
  const page = await ctx.newPage()
  await login(page)

  const sidebar = page.locator('[data-testid="app-sidebar"]')
  const sbBox = await sidebar.boundingBox()
  console.log(`  sidebar width: ${sbBox?.width}px`)
  check(sbBox && sbBox.width <= 80, `sidebar collapsed to icons (≤80px)`)

  // Nav labels should be hidden — icon-only state
  // We verify by checking that the dashboard nav cell is narrower than 60px
  const dashCellBox = await page.locator('[data-testid="nav-dashboard"]').boundingBox()
  console.log(`  nav cell width: ${dashCellBox?.width}px`)
  check(dashCellBox && dashCellBox.width <= 60, `nav cells icon-only`)

  // Tooltips: title attribute is set on each nav link
  const dashTitle = await page.locator('[data-testid="nav-dashboard"]').getAttribute('title')
  check(dashTitle === 'Dashboard', `nav has tooltip via title attr (got "${dashTitle}")`)

  await page.screenshot({ path: path.join(OUT, 'u7-900-both-compact.png'), fullPage: false })
  await ctx.close()
}

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.7 responsive checks pass')
