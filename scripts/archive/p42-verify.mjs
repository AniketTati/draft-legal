#!/usr/bin/env node
/**
 * P4.2 verify — Matter UI (list + detail + contract picker).
 *
 *   (1) /matters renders with a "New matter" button; creating a matter
 *       via the drawer navigates to /matters/:id
 *   (2) /matters/:id shows the Contracts tab with an empty state when
 *       nothing is linked
 *   (3) Contract detail header shows the Matter picker button when no
 *       matter is assigned
 *   (4) Clicking "Add to matter" → picker opens → selecting a matter
 *       attaches the contract + picker collapses to the matter badge
 *   (5) Navigating to the matter workspace now shows that contract
 *       under the Contracts tab
 *   (6) Unlinking via the × on the badge restores "Add to matter"
 *       state + the matter workspace is empty again
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const API = 'http://localhost:3001'

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()

  // (1) /matters list + create
  await page.goto('http://localhost:5173/matters', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  check(await page.getByTestId('matters-page').isVisible(), `(1) MattersPage renders`)
  check(await page.getByTestId('matters-create-btn').isVisible(), `(1) "New matter" button visible`)

  await page.getByTestId('matters-create-btn').click()
  await page.getByTestId('matter-create-drawer').waitFor({ state: 'visible', timeout: 5_000 })
  const matterName = `P4.2 ui matter ${Date.now()}`
  await page.getByTestId('matter-create-name').fill(matterName)
  await page.getByTestId('matter-create-description').fill('UI verify')
  await page.getByTestId('matter-create-counterparty').fill('Acme Corporation')
  await page.getByTestId('matter-create-submit').click()
  await page.waitForURL(u => /\/matters\/[^/]+$/.test(u.toString()), { timeout: 10_000 })
  await page.waitForTimeout(800)
  const matterId = (page.url().match(/\/matters\/([^/?]+)/) ?? [])[1]
  check(!!matterId, `(1) drawer-created matter routed to /matters/${matterId}`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/132-p42-matter-detail.png'), fullPage: false })

  // (2) Empty contracts tab
  const contractsBody = page.getByTestId('matter-tab-contracts-body')
  check(await contractsBody.isVisible(), `(2) contracts tab body renders`)
  const empty1 = await contractsBody.innerText()
  check(/No contracts/i.test(empty1), `(2) empty state shows "No contracts" (got "${empty1.slice(0, 60)}")`)

  // (3) Contract detail picker
  const cList = await fetch(`${API}/api/v1/contracts?pageSize=1`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contractId = (cList.data ?? cList.contracts ?? [])[0]?.id
  if (!contractId) { console.error('no contracts'); process.exit(1) }

  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  const addBtn = page.getByTestId('contract-matter-add-btn')
  check(await addBtn.isVisible(), `(3) "Add to matter" button visible on contract header`)

  // (4) Open picker → select our matter → badge appears
  await addBtn.click()
  await page.getByTestId('contract-matter-picker').waitFor({ state: 'visible', timeout: 5_000 })
  await page.getByTestId(`contract-matter-pick-${matterId}`).click()
  await page.waitForTimeout(1000)
  const badge = page.getByTestId('contract-matter-badge')
  check(await badge.isVisible(), `(4) matter badge visible after assignment`)
  const badgeMatterId = await badge.getAttribute('data-matter-id')
  check(badgeMatterId === matterId, `(4) badge's data-matter-id matches (${badgeMatterId})`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/133-p42-matter-picker.png'), fullPage: false })

  // (5) Matter workspace now has the contract
  await page.goto(`http://localhost:5173/matters/${matterId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  const contractsBody2 = page.getByTestId('matter-tab-contracts-body')
  const populated = await contractsBody2.innerText()
  check(!/No contracts/i.test(populated),
    `(5) matter contracts tab no longer empty (got "${populated.slice(0, 80)}")`)

  // (6) Unlink
  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  await page.getByTestId('contract-matter-unlink').click()
  await page.waitForTimeout(800)
  const addBtnAgain = await page.getByTestId('contract-matter-add-btn').isVisible().catch(() => false)
  check(addBtnAgain, `(6) "Add to matter" button returns after unlink`)

  await page.goto(`http://localhost:5173/matters/${matterId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const empty2 = await page.getByTestId('matter-tab-contracts-body').innerText()
  check(/No contracts/i.test(empty2), `(6) matter workspace is empty again after unlink`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P4.2 matter-UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
