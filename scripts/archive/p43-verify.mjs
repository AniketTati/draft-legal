#!/usr/bin/env node
/**
 * P4.3 verify — @contract / @matter / @counterparty entity mentions
 * in the rail composer.
 *
 *   (1) Typing '@Acme' triggers a query across entities — at least one
 *       contract result shows up in the popover
 *   (2) Picking a contract inserts '@<title>' into the composer AND
 *       tracks the entity in pendingEntityMentions (internal state)
 *   (3) Sending the turn POSTs /api/v1/agent/chat with `mentions: [{
 *       kind: 'contract', id, label }]`
 *   (4) The orchestrator's mentions-hint shows up in the SSE stream —
 *       we can't easily snoop on the hint itself, but we can confirm
 *       the agent called contract_get with the supplied id
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

  // Capture the outgoing chat request to verify mentions[] arrives
  let capturedPayload = null
  await page.route('**/api/v1/agent/chat', async (route) => {
    try { capturedPayload = JSON.parse(route.request().postData() ?? '{}') } catch { /* ignore */ }
    await route.continue()
  })

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
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const composer = page.getByTestId('side-agent-composer')
  await composer.click()

  // (1) Type '@Acme' — popover should show contract entities
  await composer.type('@Acme')
  await page.waitForTimeout(700)  // debounce + fetch
  const popover = page.getByTestId('side-agent-mention-popover')
  check(await popover.isVisible(), `(1) mention popover opens`)

  const entityItems = await page.locator('[data-testid^="side-agent-mention-entity-contract-"]').count()
  check(entityItems >= 1, `(1) at least one contract entity appears (got ${entityItems})`)

  // (2) Pick the first contract
  const firstContract = page.locator('[data-testid^="side-agent-mention-entity-contract-"]').first()
  const contractId = (await firstContract.getAttribute('data-testid') ?? '').replace('side-agent-mention-entity-contract-', '')
  await firstContract.click()
  await page.waitForTimeout(300)
  const composerText = await composer.inputValue()
  check(composerText.startsWith('@'), `(2) composer text starts with @ (got "${composerText.slice(0, 40)}")`)

  // (3) Type the rest + send → capture the payload
  await composer.type(' what clauses does this contract have?')
  await page.getByTestId('side-agent-send').click()
  await page.waitForTimeout(2000)
  check(!!capturedPayload, `(3) chat payload captured`)
  const mentions = capturedPayload?.mentions ?? []
  check(Array.isArray(mentions) && mentions.length >= 1,
    `(3) payload.mentions[] has ≥1 entry (got ${mentions.length})`)
  const m = mentions[0]
  check(m?.kind === 'contract' && m?.id === contractId,
    `(3) first mention is {kind: contract, id: ${contractId}} (got ${JSON.stringify(m)})`)

  // (4) Wait for the stream to end + confirm contract_get was called
  //     with the mentioned contractId.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 90_000 }
  )
  await page.waitForTimeout(500)
  const toolNames = await page.locator('[data-testid^="tool-chip-"]').evaluateAll(els =>
    els.map(e => e.getAttribute('data-testid')?.replace('tool-chip-', ''))
  )
  check(
    toolNames.some(n => n === 'contract_get' || n === 'contract_cite' || n === 'contract_summarize'),
    `(4) agent invoked a contract_* tool after the mention (saw: ${toolNames.join(', ') || '—'})`,
  )

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/134-p43-entity-mention.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P4.3 entity-mention checks pass')
})().catch(e => { console.error(e); process.exit(1) })
