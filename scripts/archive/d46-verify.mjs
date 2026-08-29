#!/usr/bin/env node
/**
 * D.4.6 verify — Skill picker chip UI on scope-matched pages.
 *
 *   (1) Dashboard hero surfaces dashboard/portfolio-scoped skill chips
 *       (@draft-from-template, @draft-from-scratch, @compliance-sweep)
 *       — NOT current_contract-scoped ones.
 *   (2) Rail on a contract page surfaces current_contract-scoped chips
 *       (@review-contract, @prep-for-approval, etc.)
 *       — NOT dashboard-only chips.
 *   (3) Clicking a hero skill chip pushes `@slug ` into the rail
 *       composer (doesn't auto-send — user appends specifics first).
 *   (4) Clicking a rail skill chip populates the composer with the slug.
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-skills.ts'], {
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

  // ─── Dashboard ─────────────────────────────────────────────────────────
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  await page.waitForTimeout(600)

  const heroChipRow = page.getByTestId('hero-agent-skill-chips')
  check(await heroChipRow.isVisible(), '(1) hero-agent-skill-chips strip rendered on dashboard')

  // Expected visibility
  const heroDraftTpl = await page.getByTestId('hero-agent-skill-chip-draft-from-template').isVisible().catch(() => false)
  const heroDraftScr = await page.getByTestId('hero-agent-skill-chip-draft-from-scratch').isVisible().catch(() => false)
  const heroComp     = await page.getByTestId('hero-agent-skill-chip-compliance-sweep').isVisible().catch(() => false)
  const heroReview   = await page.getByTestId('hero-agent-skill-chip-review-contract').isVisible().catch(() => false)
  check(heroDraftTpl, '(1) @draft-from-template chip present on dashboard')
  check(heroDraftScr, '(1) @draft-from-scratch chip present on dashboard')
  check(heroComp,     '(1) @compliance-sweep chip present on dashboard (portfolio scope)')
  check(!heroReview,  '(1) @review-contract chip absent (current_contract scope)')

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/95-d46-hero-skill-chips.png'), fullPage: false })

  // (3) Click a hero skill chip → rail composer gets the slug
  await page.getByTestId('hero-agent-skill-chip-draft-from-template').click()
  await page.waitForTimeout(400)
  const railValue = await page.getByTestId('side-agent-composer').inputValue()
  check(railValue.startsWith('@draft-from-template'), `(3) hero chip click drops "@slug " into the composer (got "${railValue}")`)

  // Clear state
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="side-agent-composer"]')
    if (ta) (ta).value = ''
  })

  // ─── Contract page ─────────────────────────────────────────────────────
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?pageSize=1', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contract = (list.contracts ?? list.data ?? [])[0]

  await page.goto(`http://localhost:5173/contracts/${contract.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_200)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  await page.waitForTimeout(600)

  const railChipRow = page.getByTestId('side-agent-skill-chips')
  check(await railChipRow.isVisible(), '(2) rail skill-chip strip rendered on contract page')

  const ctrReview  = await page.getByTestId('side-agent-skill-chip-review-contract').isVisible().catch(() => false)
  const ctrPrep    = await page.getByTestId('side-agent-skill-chip-prep-for-approval').isVisible().catch(() => false)
  const ctrDraftTpl = await page.getByTestId('side-agent-skill-chip-draft-from-template').isVisible().catch(() => false)
  check(ctrReview,     '(2) @review-contract chip visible on contract page')
  check(ctrPrep,       '(2) @prep-for-approval chip visible on contract page')
  check(!ctrDraftTpl,  '(2) @draft-from-template chip absent (dashboard scope)')

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/96-d46-rail-skill-chips.png'), fullPage: false })

  // (4) Click rail chip → composer gets the slug
  await page.getByTestId('side-agent-skill-chip-review-contract').click()
  await page.waitForTimeout(300)
  const composerValue = await page.getByTestId('side-agent-composer').inputValue()
  check(composerValue.startsWith('@review-contract'), `(4) rail chip click sets composer to "@review-contract " (got "${composerValue}")`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.4.6 skill-chip checks pass')
})().catch(e => { console.error(e); process.exit(1) })
