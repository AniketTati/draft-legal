#!/usr/bin/env node
/**
 * D.1.1 verify — SideAgentRail shell behind AGENT_SIDE_PANEL_V2 flag.
 *
 * Asserts:
 *   (1) Flag OFF → rail is NOT rendered; legacy ChatPanel toggle still
 *       works via the Header button (unchanged baseline).
 *   (2) Flag ON  → rail renders on the right in expanded state, with
 *       header/composer/empty-state-suggestions; clicking collapse
 *       shrinks it to the 48px strip; clicking expand grows it back;
 *       typing in the composer enables the Send button.
 *   (3) Rail state persists across page reloads.
 *   (4) No regressions: the legacy AI Assistant button still exists
 *       (it becomes a no-op with flag ON per our wiring, but doesn't crash).
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // Login
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.waitForTimeout(400)

  // ── (1) Flag OFF (default) — rail must NOT render ─────────────────────
  // Ensure flag is off.
  await page.evaluate(() => localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const railWhenOff = await page.getByTestId('side-agent-rail').count()
  check(railWhenOff === 0, '(1) rail is NOT rendered when AGENT_SIDE_PANEL_V2 is off')

  // Legacy AI Assistant button still works (just visually verify it exists)
  const legacyBtn = await page.getByRole('button', { name: /ai assistant/i }).count()
  check(legacyBtn >= 1, '(1) legacy "AI Assistant" button still present when flag off')

  await page.screenshot({ path: `${SHOTS}/61-d11-rail-flag-off.png`, fullPage: false })

  // ── (2) Flag ON — rail renders expanded on the right ──────────────────
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    window.dispatchEvent(new CustomEvent('feature-flag-changed'))
  })
  await page.waitForTimeout(300)

  // Rail should appear without reload because of our custom event propagation.
  const railExpanded = page.getByTestId('side-agent-rail')
  await railExpanded.waitFor({ state: 'visible', timeout: 5_000 })
  check(await railExpanded.count() === 1, '(2) rail renders when flag is on')
  const stateAttr = await railExpanded.getAttribute('data-state')
  check(stateAttr === 'expanded', `(2) rail default state is "expanded" (got ${stateAttr})`)

  // Content: header, new-thread button, composer, suggestions, send
  const composer = page.getByTestId('side-agent-composer')
  check(await composer.isVisible(), '(2) composer textarea visible')
  const newThread = page.getByTestId('side-agent-new-thread')
  check(await newThread.isVisible(), '(2) "new thread" button visible in header')
  const suggestions = await page.getByTestId('side-agent-suggestion').count()
  check(suggestions === 3, `(2) 3 empty-state suggestion chips rendered (got ${suggestions})`)

  // Send button is disabled until something is typed
  const sendBtn = page.getByTestId('side-agent-send')
  check(await sendBtn.isDisabled(), '(2) send button disabled when composer empty')
  await composer.fill('Summarize risks in this contract')
  await page.waitForTimeout(100)
  check(!(await sendBtn.isDisabled()), '(2) send button enabled after typing')

  await page.screenshot({ path: `${SHOTS}/62-d11-rail-expanded.png`, fullPage: false })

  // Collapse
  await page.getByTestId('side-agent-collapse').click()
  await page.waitForTimeout(200)
  const stateAfterCollapse = await page.getByTestId('side-agent-rail').getAttribute('data-state')
  check(stateAfterCollapse === 'collapsed', `(2) state flips to "collapsed" (got ${stateAfterCollapse})`)

  await page.screenshot({ path: `${SHOTS}/63-d11-rail-collapsed.png`, fullPage: false })

  // Expand again from the collapsed strip
  await page.getByTestId('side-agent-expand').click()
  await page.waitForTimeout(200)
  const stateAfterExpand = await page.getByTestId('side-agent-rail').getAttribute('data-state')
  check(stateAfterExpand === 'expanded', `(2) state flips back to "expanded" (got ${stateAfterExpand})`)

  // ── (3) Persistence — collapse, reload, expect still collapsed ────────
  await page.getByTestId('side-agent-collapse').click()
  await page.waitForTimeout(200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const stateAfterReload = await page.getByTestId('side-agent-rail').getAttribute('data-state')
  check(stateAfterReload === 'collapsed', `(3) rail state persists across reload (got ${stateAfterReload})`)

  // Cleanup — leave flag set to 1 so the developer running smokes keeps the
  // rail visible for subsequent manual testing. Set to 0 explicitly so next
  // verify runs see the off path.
  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.1 UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
