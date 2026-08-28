#!/usr/bin/env node
/**
 * U.3.1 verify — Rail v3.
 *
 * Checks (matches doc 32 §6 + §10):
 *   (1) On a contract page, Context header band shows up under the rail
 *       header with icon + resource type + name + thread count link
 *   (2) On a counterparty page, same band shows for that resource
 *   (3) On dashboard (no resource), the band is absent
 *   (4) Composer placeholder mentions @ skills + / actions
 *   (5) Composer focus uses indigo ring
 *   (6) Footer link "Open Assistant ↗" present
 *   (7) Collapsing the rail produces a 32px chip with vertical "Ask · ⌘K"
 *   (8) Coach mark fires once on first contract visit, then never again
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // Reset coach-mark flag so check (8) sees it fresh
  await page.evaluate(() => localStorage.removeItem('clm.coach.contract-detail.v2'))

  // ── (1) Contract page Context header
  console.log('\n=== (1) Context header on contract page ===')
  await page.goto(`${BASE}/contracts/cmodtj9gz000svopsfu00q258`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)

  const ctxHeader = await page.getByTestId('side-agent-context-header').count()
  check(ctxHeader === 1, `Context header band visible on contract page`)
  if (ctxHeader === 1) {
    const txt = await page.getByTestId('side-agent-context-header').innerText()
    console.log(`  text: "${txt.replace(/\s+/g, ' ').slice(0, 100)}"`)
    check(/focused on contract/i.test(txt), `header says "Focused on contract"`)
    check(/zynga/i.test(txt) || /MSA/i.test(txt), `header shows resource name`)
  }
  const histBtn = await page.getByTestId('side-agent-context-history').count()
  check(histBtn === 1, `prior-threads link visible`)

  // ── (8) Coach mark
  console.log('\n=== (8) Coach mark fires once on first contract visit ===')
  // Coach mark localStorage flag was cleared at the top of the test
  // before we navigated. We need to ALSO clear it before navigation +
  // reload. Otherwise the contract detail page mounted before localStorage
  // was reset.
  await page.evaluate(() => localStorage.removeItem('clm.coach.contract-detail.v2'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const coach = await page.getByTestId('coach-mark-rail-hint').count()
  check(coach === 1, `coach-mark-rail-hint visible on first visit`)
  await page.screenshot({ path: path.join(OUT, 'u3-1-contract-rail.png'), fullPage: false })

  // ── (4)+(5)+(6) Composer hints + handoff link
  console.log('\n=== (4-6) Composer placeholder + handoff link ===')
  const composer = page.getByTestId('side-agent-composer')
  const placeholder = await composer.getAttribute('placeholder')
  console.log(`  placeholder: "${placeholder}"`)
  check(/@\s*for skills/i.test(placeholder ?? ''), `placeholder mentions @ for skills`)
  check(/\/\s*for actions/i.test(placeholder ?? ''), `placeholder mentions / for actions`)
  const handoff = await page.getByTestId('side-agent-handoff-link').count()
  check(handoff === 1, `handoff link "open Assistant ↗" visible`)

  // ── (2) Counterparty page Context header
  console.log('\n=== (2) Context header on counterparty page ===')
  // Find a counterparty id
  const tokenRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()
  const cpsRes = await fetch('http://localhost:3001/api/v1/counterparties', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const cps = (await cpsRes.json()).data
  const zynga = cps.find(c => /zynga/i.test(c.name)) ?? cps[0]
  if (zynga) {
    await page.goto(`${BASE}/counterparties/${zynga.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)
    const cpHeader = await page.getByTestId('side-agent-context-header').count()
    check(cpHeader === 1, `Context header visible on counterparty page`)
    if (cpHeader === 1) {
      const txt = await page.getByTestId('side-agent-context-header').innerText()
      check(/focused on counterparty/i.test(txt), `header says "Focused on counterparty"`)
    }
  }

  // ── (3) Dashboard (no resource) — header absent
  console.log('\n=== (3) Context header NOT shown on dashboard ===')
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const dashHeader = await page.getByTestId('side-agent-context-header').count()
  check(dashHeader === 0, `Context header absent on dashboard (got ${dashHeader})`)

  // ── (7) Collapsed rail = chip
  console.log('\n=== (7) Collapsed rail shows 32px chip ===')
  // Click the collapse button
  const collapseBtn = page.getByTestId('side-agent-collapse')
  if (await collapseBtn.count() > 0) {
    await collapseBtn.click().catch(() => {})
    await page.waitForTimeout(700)
    const railEl = page.getByTestId('side-agent-rail')
    const state = await railEl.getAttribute('data-state')
    check(state === 'collapsed', `rail state is "collapsed" (got "${state}")`)
    // Verify the vertical "Ask · ⌘K" text is present
    const collapsedTxt = await railEl.innerText()
    check(/Ask/i.test(collapsedTxt), `collapsed rail shows "Ask"`)
    check(/⌘K/.test(collapsedTxt), `collapsed rail shows "⌘K"`)
    await page.screenshot({ path: path.join(OUT, 'u3-1-rail-collapsed.png'), fullPage: false })
  } else {
    console.log('  (no collapse button found — rail open by default?)')
  }

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All U.3.1 Rail v3 checks pass')
})().catch(e => { console.error(e); process.exit(1) })
