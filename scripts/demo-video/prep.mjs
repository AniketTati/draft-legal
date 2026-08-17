#!/usr/bin/env node
/**
 * prep.mjs — warm the one thing the recording cannot wait for.
 *
 * Scene 5 shows the staged playbook redline: the deviations found on a real
 * contract and the counter-language proposed for each. That is a live model
 * call taking tens of seconds, which would sit as dead air in the middle of
 * the take. It also persists (contract.metadata._playbookRedline), so running
 * it once beforehand makes the scene render instantly.
 *
 *   node scripts/demo-video/prep.mjs
 *   node scripts/demo-video/prep.mjs --detail-search "Acme Corporation"
 *
 * Safe to re-run: staging replaces the previous staged set and changes nothing
 * in the document itself — the rail applies changes only when a reviewer
 * accepts them, which this script never does.
 */
import { chromium } from 'playwright'

const argv = process.argv.slice(2)
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const BASE = flag('base', 'http://localhost:5173')
const SEARCH = flag('detail-search', 'Acme Corporation')
const STATUS = flag('status', 'EXECUTED')
const EMAIL = process.env.DEMO_EMAIL || 'admin@demo.com'
const PASSWORD = process.env.DEMO_PASSWORD || 'password123'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

console.log('→ signing in')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 })
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 30_000 })

console.log(`→ opening "${SEARCH}"`)
await page.goto(`${BASE}/contracts?status=${STATUS}`, { waitUntil: 'networkidle' })
await page.fill('input[placeholder*="Search by title" i]', SEARCH)
await page.waitForTimeout(1800)
const row = page.locator('[data-testid^="contract-row-"]').first()
await row.waitFor({ state: 'visible', timeout: 10_000 })
await row.click()
await page.waitForTimeout(2500)

const already = await page.locator('[data-testid="staged-proposals"]').count()
if (already) {
  console.log('✓ a staged redline is already present — nothing to do')
  await browser.close()
  process.exit(0)
}

const start = page.locator('[data-testid="start-playbook-redline"]')
if (!(await start.count())) {
  console.error(
    '✖ no "Redline against playbook" control on this contract.\n' +
      '  Either the contract has no clauses extracted yet, or the rail is collapsed.'
  )
  await browser.close()
  process.exit(1)
}

console.log('→ staging the redline (this is the slow model call, once)')
await start.click()

const deadline = Date.now() + 240_000
let done = false
while (Date.now() < deadline) {
  await page.waitForTimeout(4000)
  if (await page.locator('[data-testid="staged-proposals"]').count()) {
    done = true
    break
  }
  const failed = await page.locator('text=/could not be completed/i').count()
  if (failed) {
    console.error('✖ the redline pipeline reported a failure — check the agents log on :8002')
    await browser.close()
    process.exit(1)
  }
  process.stdout.write('.')
}
process.stdout.write('\n')

if (!done) {
  console.error('✖ timed out after 4 minutes waiting for the redline to stage')
  await browser.close()
  process.exit(1)
}

const count = await page.locator('[data-testid="staged-proposals"] li').count()
console.log(`✓ staged — ${count} proposal(s) ready for scene 5`)
await browser.close()
