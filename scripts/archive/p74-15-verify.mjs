#!/usr/bin/env node
/**
 * P7.4.15 verify — Compare button disabled with 1 version (F-33).
 *
 * Before: Compare entries were entirely hidden when versions.length
 * was < 2, which meant first-time users never learned the feature
 * existed.
 *
 * After: button is always rendered. With 1 version it's disabled +
 * tooltip "Upload a second version to compare…". With ≥2 versions
 * the button is active and opens CompareMode.
 *
 * Checks:
 *   (1) Open Zynga MSA (has multiple versions) → compare-btn enabled
 *   (2) Open a single-version contract → compare-btn disabled
 *   (3) Disabled tooltip mentions "second version"
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API  = 'http://localhost:3001/api/v1'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()
  const contractsRes = await fetch(`${API}/contracts?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const contractsJson = await contractsRes.json()
  const contracts = contractsJson.contracts ?? contractsJson.data ?? []

  // Pick contracts: one with versions ≥ 2, one with versions == 1.
  // Versions live at /contracts/:id/versions (not on the detail).
  console.log(`  scanning ${contracts.length} contracts for version counts...`)
  let multiVersionId = null
  let singleVersionId = null
  for (const c of contracts) {
    const vRes = await fetch(`${API}/contracts/${c.id}/versions`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!vRes.ok) {
      console.log(`    ${c.id.slice(-8)} -> HTTP ${vRes.status}`)
      continue
    }
    const vJson = await vRes.json()
    const arr = vJson.versions ?? vJson.data ?? (Array.isArray(vJson) ? vJson : [])
    const vCount = arr.length
    if (!multiVersionId && vCount >= 2) multiVersionId = c.id
    if (!singleVersionId && vCount === 1) singleVersionId = c.id
    if (multiVersionId && singleVersionId) break
  }
  console.log(`  multi-version contract: ${multiVersionId?.slice(-8) ?? 'none'}`)
  console.log(`  single-version contract: ${singleVersionId?.slice(-8) ?? 'none'}`)

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // Hide AI rail to avoid clipping the Compare button (it's hidden xl:inline-flex; 1680 is xl)
  await page.evaluate(() => { localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '0') })

  // ── (1) Multi-version → button enabled
  if (multiVersionId) {
    console.log('\n=== (1) Multi-version contract → Compare button enabled ===')
    await page.goto(`${BASE}/contracts/${multiVersionId}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const btn = page.getByTestId('compare-btn')
    check(await btn.count() === 1, `compare-btn rendered`)
    const disabled = await btn.getAttribute('disabled')
    check(disabled === null, `compare-btn NOT disabled (got disabled="${disabled}")`)
    await page.screenshot({ path: path.join(OUT, '230-p74-15-compare-enabled.png'), fullPage: false })
  } else {
    console.log('\n=== (1) Skipped — no multi-version contract found ===')
  }

  // ── (2) Single-version → button disabled
  if (singleVersionId) {
    console.log('\n=== (2) Single-version contract → Compare button disabled ===')
    await page.goto(`${BASE}/contracts/${singleVersionId}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const btn = page.getByTestId('compare-btn')
    check(await btn.count() === 1, `compare-btn rendered (visible even with 1 version)`)
    const disabled = await btn.getAttribute('disabled')
    check(disabled !== null, `compare-btn IS disabled (got disabled="${disabled}")`)

    // ── (3) Disabled tooltip mentions "second version"
    console.log('\n=== (3) Disabled tooltip mentions "second version" ===')
    const tooltip = await btn.getAttribute('title')
    console.log(`  tooltip: "${tooltip}"`)
    check(/second version/i.test(tooltip ?? ''),
          `tooltip mentions "second version" (got "${tooltip}")`)

    await page.screenshot({ path: path.join(OUT, '231-p74-15-compare-disabled.png'), fullPage: false })
  } else {
    console.log('\n=== (2+3) Skipped — no single-version contract found ===')
  }

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.15 compare-disabled checks pass')
})().catch(e => { console.error(e); process.exit(1) })
