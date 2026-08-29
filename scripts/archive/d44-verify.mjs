#!/usr/bin/env node
/**
 * D.4.4 verify — @skill mention autocomplete in the rail composer.
 *
 *   (1) Typing '@' opens the mention popover with filtered skills
 *   (2) Typing 'rev' narrows to @review-* skills
 *   (3) Enter inserts the highlighted slug + closes popover
 *   (4) Send fires → user bubble shows the skill chip with that slug
 *   (5) The underlying agent run resolves to a SkillInvocation row
 *       (same proof as D.4.1 but now driven from the UI, not curl)
 *   (6) On the dashboard, current_contract-scoped skills are hidden;
 *       on a contract page, portfolio-only skills are hidden.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr); process.exit(1) }
}

async function login(page) {
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
}

;(async () => {
  reseed()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await login(page)
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Wait for the skills catalog to load (fetch fires on rail mount).
  await page.waitForTimeout(1_000)

  const composer = page.getByTestId('side-agent-composer')
  await composer.click()

  // (1) Typing '@' opens the popover
  await composer.type('@')
  await page.waitForTimeout(200)
  const popover = page.getByTestId('side-agent-mention-popover')
  check(await popover.isVisible(), '(1) mention popover opens on "@"')
  const itemsOpen = await page.locator('[data-testid^="side-agent-mention-item-"]').count()
  check(itemsOpen >= 3, `(1) popover shows multiple skills (got ${itemsOpen})`)

  // (6a) On dashboard, current_contract-scoped skills should NOT be in the
  //      list (they only make sense on a contract page). @review-contract
  //      is current_contract-scoped → absent. @draft-from-template is
  //      dashboard-scoped → present.
  const reviewOnDash = await page.getByTestId('side-agent-mention-item-review-contract').isVisible().catch(() => false)
  const draftOnDash  = await page.getByTestId('side-agent-mention-item-draft-from-template').isVisible().catch(() => false)
  check(!reviewOnDash, '(6a) @review-contract hidden on dashboard (current_contract scope)')
  check(draftOnDash,   '(6a) @draft-from-template visible on dashboard')

  // (2) Narrow by typing 'dra' — should show only draft-* skills
  await composer.type('dra')
  await page.waitForTimeout(200)
  const afterFilter = await page.locator('[data-testid^="side-agent-mention-item-"]').count()
  check(afterFilter >= 2 && afterFilter <= 4, `(2) typing 'dra' narrows to draft-* skills (got ${afterFilter})`)

  // Clear and retry on a contract page for (6b)
  await composer.fill('')
  await page.waitForTimeout(150)

  // Navigate to a contract detail
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?pageSize=1', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contract = (list.contracts ?? list.data ?? [])[0]
  if (!contract?.id) { console.error('no contract to nav to'); process.exit(1) }

  await page.goto(`http://localhost:5173/contracts/${contract.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  await page.waitForTimeout(500)

  await page.getByTestId('side-agent-composer').click()
  await page.getByTestId('side-agent-composer').type('@')
  await page.waitForTimeout(200)
  const reviewOnCtr = await page.getByTestId('side-agent-mention-item-review-contract').isVisible().catch(() => false)
  const draftOnCtr  = await page.getByTestId('side-agent-mention-item-draft-from-template').isVisible().catch(() => false)
  check(reviewOnCtr,  '(6b) @review-contract visible on contract page')
  check(!draftOnCtr,  '(6b) @draft-from-template hidden on contract page (dashboard scope)')

  // (3) Arrow-nav + Enter inserts the slug
  //   Type 'rev' so the top match is @review-contract (first alpha among rev*)
  await page.getByTestId('side-agent-composer').type('rev')
  await page.waitForTimeout(200)
  await page.getByTestId('side-agent-composer').press('Enter')
  await page.waitForTimeout(200)
  const value = await page.getByTestId('side-agent-composer').inputValue()
  check(value.startsWith('@review-'), `(3) Enter inserts a @review-* slug (got "${value}")`)
  const popoverGone = await page.getByTestId('side-agent-mention-popover').isVisible().catch(() => false)
  check(!popoverGone, '(3) popover closes after insert')

  // Screenshot the happy path
  await page.getByTestId('side-agent-composer').type(' this for me')
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/93-d44-mention-composed.png'), fullPage: false })

  // (4) Send → user bubble shows skill chip
  await page.getByTestId('side-agent-send').click()
  // Skill chip appears immediately on the user bubble.
  await page.getByTestId('side-agent-skill-chip').first().waitFor({ state: 'visible', timeout: 5_000 })
  const slugOnChip = await page.getByTestId('side-agent-skill-chip').first().getAttribute('data-slug')
  check(slugOnChip?.startsWith('@review-'), `(4) skill chip rendered with slug ${slugOnChip}`)

  // Wait for the turn to complete
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 90_000 }
  )
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/94-d44-skill-answer.png'), fullPage: false })

  // (5) A SkillInvocation row was written for the active thread. Pull the
  //     thread id from the shared agent store and query via the helper.
  const threadId = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-agent') ?? '{}').state?.activeThread?.id ?? null }
    catch { return null }
  })
  check(!!threadId, `(5) rail has an active thread id (${threadId})`)
  if (threadId) {
    const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_find-invocation.ts', threadId], {
      cwd: path.join(REPO_ROOT, 'apps/api'),
      stdio: 'pipe', encoding: 'utf-8',
    })
    const row = JSON.parse(r.stdout.trim().split('\n').pop() || 'null')
    check(!!row, `(5) SkillInvocation row written for thread ${threadId}`)
    check(row?.skill?.slug?.startsWith('@review-'), `(5) row.skill.slug = ${row?.skill?.slug}`)
  }

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.4.4 @mention checks pass')
})().catch(e => { console.error(e); process.exit(1) })
