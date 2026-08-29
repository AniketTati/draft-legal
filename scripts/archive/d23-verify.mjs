#!/usr/bin/env node
/**
 * D.2.3 verify — shared agent store.
 *
 * Flow:
 *   (1) Dashboard with NO active thread → no "Continue" affordance
 *   (2) Send a message via rail → thread created → rail has activeThread
 *   (3) Navigate back to /dashboard → "Continue: <title>" pill visible
 *       in hero (proves store persisted across page change)
 *   (4) Click Continue → rail opens (no send)
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  // (1) No active thread yet → no Continue pill
  const continueBefore = await page.getByTestId('hero-agent-continue').count()
  check(continueBefore === 0, '(1) no "Continue" pill before any thread is active')

  // (2) Kick a thread via the rail composer
  await page.getByTestId('side-agent-composer').fill('Hello')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(800)

  // Active thread should now be set in the store. The rail header reflects it.
  const railHeader = await page.getByTestId('side-agent-thread-picker').textContent()
  check(!/ai assistant/i.test((railHeader ?? '').split('Recent')[0]),
        `(2) rail header updated to thread title (got "${(railHeader ?? '').slice(0, 60)}")`)

  // (3) Back to /dashboard — Continue pill should be visible
  await page.goto('http://localhost:5173/contracts', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  const continueAfter = page.getByTestId('hero-agent-continue')
  const continueVisible = await continueAfter.isVisible().catch(() => false)
  check(continueVisible, '(3) "Continue" pill visible after cross-page navigation (store persisted)')

  const continueText = (await continueAfter.textContent()) ?? ''
  check(/continue:/i.test(continueText),
        `(3) pill label is "Continue: <title>" (got "${continueText.slice(0, 80)}")`)

  await page.screenshot({ path: `${SHOTS}/83-d23-hero-continue.png`, fullPage: false })

  // (4) Clicking Continue opens the rail without firing a new message
  // Collapse rail first so we can assert it opens.
  const railCollapse = page.getByTestId('side-agent-collapse').first()
  if (await railCollapse.isVisible().catch(() => false)) {
    await railCollapse.click().catch(() => {})
    await page.waitForTimeout(200)
  }
  const msgsBefore = await page.getByTestId('side-agent-msg-user').count()
  await continueAfter.click()
  await page.waitForTimeout(400)
  const rail = page.getByTestId('side-agent-rail')
  const railState = await rail.getAttribute('data-state')
  check(railState === 'expanded', `(4) rail expands on Continue (got ${railState})`)
  const msgsAfter = await page.getByTestId('side-agent-msg-user').count()
  check(msgsAfter === msgsBefore, `(4) Continue did NOT auto-send (user msgs ${msgsBefore} → ${msgsAfter})`)

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.2.3 shared-store checks pass')
})().catch(e => { console.error(e); process.exit(1) })
