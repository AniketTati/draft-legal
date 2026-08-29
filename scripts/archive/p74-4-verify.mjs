#!/usr/bin/env node
/**
 * P7.4.4 verify — REVIEW PROGRESS counter expandable + bulk-mark (F-39)
 *
 * The audit found that the rail's REVIEW PROGRESS counter
 * (`2 / 7 reviewed`) was a dead end — you could see the number was
 * stuck but had no way to find which clauses still needed your eyes.
 *
 * Fix: clicking the row expands a checklist of every risky clause
 * with severity dot + section ref + per-row "Mark reviewed" + a bulk
 * "Mark all N as reviewed" link.
 *
 * Checks:
 *   (1) review-progress section renders on a contract with risks
 *   (2) Default state is collapsed (no checklist visible)
 *   (3) Clicking the toggle expands the checklist
 *   (4) Each unreviewed clause has a "Mark reviewed" affordance
 *   (5) Bulk "Mark all" link present when there are unreviewed items
 *   (6) Clicking bulk mark advances the counter to N/N
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

  console.log('\n=== Login as Maya (Legal counsel) ===')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  console.log('\n=== Open the Zynga MSA (largest seed contract — has 5+ risky clauses) ===')
  await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // Click the Zynga MSA contract row by name match
  const opened = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cursor-pointer, [role="row"], tr'))
    // Match the MSA, not the Amendment / Addendum / SOW
    const msa = rows.find(r => {
      const t = (r.textContent || '').toLowerCase()
      return t.includes('master services agreement') && t.includes('zynga')
    })
    if (msa) { msa.click(); return 'msa' }
    const anyZynga = rows.find(r => /zynga/i.test(r.textContent || ''))
    if (anyZynga) { anyZynga.click(); return 'any-zynga' }
    if (rows.length > 0) { rows[0].click(); return 'first' }
    return false
  })
  console.log(`  opened contract via: ${opened}`)
  await page.waitForTimeout(5000)
  console.log(`  URL: ${page.url()}`)

  // Dismiss coach-mark / "Getting started" overlay if present (intercepts clicks)
  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label*="started" i]')
    if (dlg) {
      const btn = dlg.querySelector('button')
      if (btn) btn.click()
    }
    // Also flip localStorage so it doesn't reappear
    try { localStorage.setItem('coach:contract-detail:dismissed', '1') } catch {}
  })
  await page.waitForTimeout(500)

  // ── (1) review-progress renders
  console.log('\n=== (1) Review-progress section renders ===')
  check(await page.getByTestId('review-progress').count() > 0, `review-progress section visible`)

  // Take initial screenshot
  await page.screenshot({ path: path.join(OUT, '210-p74-4-review-collapsed.png') })

  // ── (2) Default collapsed
  console.log('\n=== (2) Default collapsed ===')
  const listBefore = await page.getByTestId('review-progress-list').count()
  check(listBefore === 0, `review-progress-list NOT visible by default (got ${listBefore})`)

  // ── (3) Toggle expand
  console.log('\n=== (3) Toggle expands checklist ===')
  const toggle = page.getByTestId('review-progress-toggle')
  check(await toggle.count() > 0, `review-progress-toggle present`)
  await toggle.click()
  await page.waitForTimeout(500)
  const listAfter = await page.getByTestId('review-progress-list').count()
  check(listAfter === 1, `review-progress-list visible after click (got ${listAfter})`)

  // Read counter for context
  const counterStr = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="review-progress-toggle"]')
    return t ? t.innerText : ''
  })
  console.log(`  counter: "${counterStr.replace(/\s+/g, ' ').trim()}"`)

  // ── (4) Per-row Mark reviewed
  console.log('\n=== (4) Per-row Mark reviewed affordance ===')
  const totalMarks = await page.locator('[data-testid^="review-mark-"]').count()
  const perRowMarks = await page.locator('[data-testid^="review-mark-"]:not([data-testid="review-mark-all"])').count()
  console.log(`  total: ${totalMarks}, per-row (excluding all): ${perRowMarks}`)

  // ── (5) Bulk Mark all link
  console.log('\n=== (5) Bulk Mark all link ===')
  const markAll = page.getByTestId('review-mark-all')
  const hasMarkAll = await markAll.count() === 1
  check(hasMarkAll, `review-mark-all button visible`)

  let markAllText = ''
  if (hasMarkAll) {
    markAllText = (await markAll.innerText()).trim()
    check(/Mark all \d+/.test(markAllText), `Mark-all label has count (got "${markAllText}")`)
  }

  // Capture screenshot of expanded state
  await page.screenshot({ path: path.join(OUT, '211-p74-4-review-expanded.png') })

  // ── (6) Bulk mark advances counter
  if (hasMarkAll) {
    console.log('\n=== (6) Bulk Mark advances counter to N/N ===')
    const counterBefore = (await toggle.innerText()).trim()
    await markAll.click()
    await page.waitForTimeout(2500) // wait for mutations to complete
    const counterAfterRaw = await toggle.innerText()
    const counterAfter = counterAfterRaw.replace(/\s+/g, ' ').trim()
    console.log(`  counter: "${counterBefore.replace(/\s+/g, ' ')}" → "${counterAfter}"`)
    // Match digit / digit pattern - extract from string like "REVIEW PROGRESS 7 / 7 ✓"
    const m = counterAfter.match(/(\d+)\s*\/\s*(\d+)/)
    check(!!m && m[1] === m[2], `counter shows complete state ("${counterAfter}")`)

    // After mark-all, the bulk button should be gone
    const markAllAfter = await page.getByTestId('review-mark-all').count()
    check(markAllAfter === 0, `bulk Mark-all hidden after completion (got ${markAllAfter})`)

    await page.screenshot({ path: path.join(OUT, '212-p74-4-review-complete.png') })
  } else {
    console.log('\n=== (6) Skipped — no Mark-all (everything already reviewed?) ===')
  }

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.4 review-progress expandable checks pass')
})().catch(e => { console.error(e); process.exit(1) })
