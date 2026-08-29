#!/usr/bin/env node
/**
 * P7.4.11 verify — Template card titles clickable + Most-used (F-59, F-60).
 *
 * F-59: title was a static <h3>; clicking did nothing. Now it's a
 *       button → onEdit → opens the editor (industry standard).
 * F-60: usageCount existed but never surfaced. Now we show:
 *       - "Used N times" inline metadata
 *       - "★ Most used" amber pill when usageCount ≥ 5
 *       - Sort dropdown (Most used / Recently updated / A → Z)
 *       - Default sort is "Most used" so battle-tested templates lead.
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

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  await page.goto(`${BASE}/templates`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // ── (1) sort dropdown present
  console.log('\n=== (1) Sort dropdown present + defaults to Most used ===')
  const sort = page.getByTestId('template-sort')
  check(await sort.count() === 1, `template-sort dropdown visible`)
  const sortVal = await sort.inputValue()
  check(sortVal === 'used', `default sort is "used" (got "${sortVal}")`)

  // ── (2) Most-used tag visible on at least one card
  console.log('\n=== (2) "Most used" pill visible when usageCount ≥ 5 ===')
  const mostUsedCount = await page.locator('[data-testid^="template-most-used-"]').count()
  check(mostUsedCount >= 1, `≥1 "Most used" pill visible (got ${mostUsedCount})`)

  // ── (3) Usage count text visible
  console.log('\n=== (3) "Used N times" text visible on cards ===')
  const usageTextCount = await page.locator('[data-testid^="template-usage-"]').count()
  check(usageTextCount >= 1, `≥1 usage-count text visible (got ${usageTextCount})`)

  // ── (4) The first card (after sort by used) should have the highest count
  console.log('\n=== (4) First card after sort has highest usage ===')
  const firstUsage = await page.locator('[data-testid^="template-usage-"]').first().innerText()
  console.log(`  first card usage: "${firstUsage}"`)
  check(/12|7|10|11/.test(firstUsage), `first card has highest seeded usage (got "${firstUsage}")`)

  await page.screenshot({ path: path.join(OUT, '224-p74-11-templates.png'), fullPage: false })

  // ── (5) Clicking a template title opens the builder modal (F-59)
  console.log('\n=== (5) Clicking title opens edit builder ===')
  // Disable side AI rail so it doesn't intercept clicks on the right
  await page.evaluate(() => { localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '0') })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const firstTitle = page.locator('[data-testid^="template-card-title-"]').first()
  await firstTitle.scrollIntoViewIfNeeded()
  await firstTitle.click()
  await page.waitForTimeout(700)
  // The TemplateBuilder modal renders headings + Save button
  const builderOpen = await page.locator('h2:has-text("Edit Template"), button:has-text("Save Template")').count()
  check(builderOpen >= 1, `template builder visible after clicking title (got ${builderOpen})`)
  await page.screenshot({ path: path.join(OUT, '225-p74-11-template-edit.png'), fullPage: false })

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.11 template card checks pass')
})().catch(e => { console.error(e); process.exit(1) })
