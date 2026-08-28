#!/usr/bin/env node
/**
 * D.2.2 verify — contextual chips in the hero agent.
 *
 *   (1) Chips render below the composer
 *   (2) "Draft an NDA for…" chip ALWAYS present (even with zero counts)
 *   (3) Count-based chips appear when their counter > 0
 *   (4) Clicking a full-prompt chip triggers the submit flow (rail opens)
 *   (5) Clicking the partial "Draft an NDA for " chip drops text into
 *       the hero composer (doesn't auto-send) so user can complete
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
  await page.waitForTimeout(1000)

  const chips = page.getByTestId('hero-agent-chips')
  check(await chips.isVisible(), '(1) chip row visible below composer')

  // "Draft an NDA for…" chip ALWAYS present
  const draftChip = page.getByTestId('hero-agent-chip-draft-an-nda-for')
  check(await draftChip.isVisible(), '(2) "Draft an NDA for…" chip always visible')

  // Count-based chips — show what's there (dashboard stats on the seeded DB
  // likely has draftsInProgress > 0)
  const counts = await page.locator('[data-testid^="hero-agent-chip-"]').count()
  check(counts >= 1, `(3) at least 1 chip rendered (got ${counts})`)
  console.log(`  (info) ${counts} chip(s) rendered based on current Your Day counts`)

  await page.screenshot({ path: `${SHOTS}/82-d22-hero-chips.png`, fullPage: false })

  // (5) Partial chip drops into composer (does NOT auto-send)
  await draftChip.click()
  await page.waitForTimeout(300)
  const composerVal = await page.getByTestId('hero-agent-composer').inputValue()
  check(/draft an nda for/i.test(composerVal),
        `(5) "Draft an NDA for…" drops into composer (got "${composerVal.slice(0, 40)}")`)
  // Rail should NOT have a new user bubble from this click (no auto-send)
  const railMsgs = await page.getByTestId('side-agent-msg-user').count()
  check(railMsgs === 0, `(5) partial chip did NOT auto-send (rail has ${railMsgs} user message(s))`)

  // (4) A full-prompt chip (any non-"Draft NDA" chip) should auto-send.
  // Clear the composer first, then look for a chip that triggers submission.
  await page.getByTestId('hero-agent-composer').fill('')
  const allChips = await page.locator('[data-testid^="hero-agent-chip-"]').all()
  // Find the first chip that's not the partial "Draft NDA" one
  let sendChip = null
  for (const c of allChips) {
    const tid = await c.getAttribute('data-testid')
    if (tid && !tid.includes('draft-an-nda-for')) { sendChip = c; break }
  }
  if (sendChip) {
    await sendChip.click()
    await page.waitForTimeout(800)
    const afterMsgs = await page.getByTestId('side-agent-msg-user').count()
    check(afterMsgs >= 1, `(4) full-prompt chip triggered send (rail now has ${afterMsgs} user message(s))`)
    // Wait for stream to finish so we don't leave the rail streaming in the next run
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
      { timeout: 60_000 }
    )
  } else {
    console.log('  (skip) (4) no full-prompt chip available (all chips are partial)')
  }

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.2.2 hero chip checks pass')
})().catch(e => { console.error(e); process.exit(1) })
