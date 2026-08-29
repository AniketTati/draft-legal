#!/usr/bin/env node
/**
 * U.3.2 verify — /-slash quick-action menu in rail composer.
 *
 * Replaces the deleted Cmd-K palette modal:
 *   - Type "/" in the rail composer → popover opens with curated actions
 *   - Type more chars → list filters live
 *   - On a contract page, contract-specific actions appear (Liability cap, etc)
 *   - Pick → fills composer + sends immediately
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

  // Open Zynga MSA so contract-specific actions show
  await page.goto(`${BASE}/contracts/cmodtj9gz000svopsfu00q258`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.evaluate(() => localStorage.setItem('clm.coach.contract-detail.v2', 'seen'))

  // ── (1) Type "/" → popover opens with default top-5 actions
  console.log('\n=== (1) Type "/" opens slash popover ===')
  const composer = page.getByTestId('side-agent-composer')
  await composer.click()
  await composer.fill('/')
  await page.waitForTimeout(400)
  const pop = await page.getByTestId('side-agent-slash-popover').count()
  check(pop === 1, `slash popover visible (got ${pop})`)
  const items = await page.locator('[data-testid^="side-agent-slash-item-"]').count()
  check(items >= 3, `≥3 actions shown (got ${items})`)

  await page.screenshot({ path: path.join(OUT, 'u3-2-slash-default.png'), fullPage: false })

  // ── (2) Filter as you type
  console.log('\n=== (2) Type "liab" → only Liability cap ===')
  await composer.fill('/liab')
  await page.waitForTimeout(400)
  const filteredItems = await page.locator('[data-testid^="side-agent-slash-item-"]').count()
  check(filteredItems === 1, `exactly 1 match for /liab (got ${filteredItems})`)
  const liab = await page.getByTestId('side-agent-slash-item-liability').count()
  check(liab === 1, `Liability cap action visible`)

  await page.screenshot({ path: path.join(OUT, 'u3-2-slash-filtered.png'), fullPage: false })

  // ── (3) Esc closes popover
  console.log('\n=== (3) Esc closes popover ===')
  await composer.press('Escape')
  await page.waitForTimeout(300)
  const popClosed = await page.getByTestId('side-agent-slash-popover').count()
  check(popClosed === 0, `popover closed`)

  // ── (4) Contract-only actions hidden on dashboard
  console.log('\n=== (4) Contract-specific actions hidden on dashboard ===')
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Re-find composer
  const dashComposer = page.getByTestId('side-agent-composer')
  await dashComposer.click()
  await dashComposer.fill('/')
  await page.waitForTimeout(400)
  const liabOnDash = await page.getByTestId('side-agent-slash-item-liability').count()
  check(liabOnDash === 0, `"Liability cap" NOT shown on dashboard (got ${liabOnDash})`)
  const queueOnDash = await page.getByTestId('side-agent-slash-item-queue').count()
  check(queueOnDash === 1, `"My approval queue" still shown on dashboard`)

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All U.3.2 /-slash menu checks pass')
})().catch(e => { console.error(e); process.exit(1) })
