#!/usr/bin/env node
// B.6.4 verify — activity feed reads as complete sentences with
// avatar, actor name, verb, linked entity, and relative time.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const EMAIL = process.env.E2E_EMAIL ?? 'admin@demo.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'password123'
const OUT = path.resolve('scripts/screenshots/b6')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

async function shot(name) {
  const p = path.join(OUT, name)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

let fail = 0
function assert(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg)
  if (!cond) fail++
}

try {
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  await shot('b64-activity-feed.png')

  // 1. Feed is not dominated by generic noise
  const html = (await page.content()).toLowerCase()
  const noiseCount = (html.match(/contract updated · system/g) ?? []).length
  assert(noiseCount === 0, 'feed does not contain "Contract updated · System" noise')

  // 2. Feed contains real contract titles
  const hasTitle = /acme innovations|wpt enterprises|ipass|iPass|globex/i.test(await page.content())
  assert(hasTitle, 'feed mentions at least one real contract title')

  // 3. Feed contains verbs we expect
  const text = await page.locator('section, div').filter({ hasText: /uploaded|shared|edited|drafted/i }).count()
  assert(text > 0, 'feed contains a humanised verb (uploaded / shared / edited / drafted)')

  // 4. Feed entries are clickable buttons with actor initials
  const feedItems = await page.locator('ul li button').count()
  assert(feedItems >= 3, `feed shows at least 3 clickable rows (got ${feedItems})`)

  // 5. Relative time format
  const timeEls = await page.locator('time').count()
  assert(timeEls >= 3, `each row has a <time> element (got ${timeEls})`)

  // 6. Clicking an entry navigates to a contract
  await page.locator('ul li button').first().click()
  await page.waitForLoadState('networkidle')
  const navigatedUrl = page.url()
  assert(/\/contracts\/[^\/]+/.test(navigatedUrl) || navigatedUrl.endsWith('/requests') || navigatedUrl.endsWith('/approvals'), `click navigates to an entity page (url=${navigatedUrl})`)
  await shot('b64-after-click.png')

  // 7. "System" entries must NOT appear
  const systemMentions = (html.match(/>\s*system\s*</g) ?? []).length
  assert(systemMentions === 0, 'no bare "System" actor text in the feed')

  console.log()
  if (fail) {
    console.log(`✗ ${fail} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log(`✓ All B.6.4 checks pass.`)
  }
} catch (e) {
  console.log('FATAL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
