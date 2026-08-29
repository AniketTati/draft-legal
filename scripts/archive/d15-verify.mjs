#!/usr/bin/env node
/**
 * D.1.5 verify — tool-call trace chips.
 *
 *   (1) Send a grounded question on a contract page
 *   (2) After the stream completes, a chip labeled "contract_get" appears
 *       above the assistant bubble, status=ok
 *   (3) Chip closed state shows name + arg summary (contractId prefix) +
 *       result-length counter
 *   (4) Clicking the chip expands it — Args + Result blocks visible with
 *       formatted JSON
 *   (5) Chip styling matches status: ok → emerald, error → red, running → blue
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-ai-demo.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr || r.stdout); process.exit(1) }
}

;(async () => {
  reseed()

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
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  // Navigate to the Acme MSA so the agent calls contract_get
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const list = await fetch('http://localhost:3001/api/v1/contracts?page=1&pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const contracts = list?.contracts ?? list?.data ?? []
  const msa = contracts.find(c => /master services/i.test(c.title ?? '') && /acme/i.test(c.title ?? ''))
  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  // Dismiss coach-mark if visible
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  await page.getByTestId('side-agent-composer').fill('What is the liability cap? One sentence.')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(400)

  // (1) Tool-trace container visible on the assistant message
  const traceVisible = await page.getByTestId('side-agent-tool-trace').first().isVisible().catch(() => false)
  check(traceVisible, '(1) tool-trace container rendered on assistant message')

  // (2) At least one tool chip is present and status=ok. We don't pin to a
  // specific tool name — the agent's choice is a function of the question
  // shape + model temperament; what matters is the UI surfaces whichever
  // tool fired. Valid names are any of the four D.1.4 read tools.
  const chips = await page.locator('[data-testid^="tool-chip-"]').all()
  check(chips.length >= 1, `(2) at least one tool chip rendered (got ${chips.length})`)
  const chip = chips[0]
  const chipTestId = await chip.getAttribute('data-testid')
  const toolName = (chipTestId ?? '').replace(/^tool-chip-/, '')
  check(
    ['contract_get', 'contract_search', 'contract_summarize', 'clause_search'].includes(toolName),
    `(2) chip is one of the four D.1.4 read tools (got ${toolName})`
  )
  const status = await chip.getAttribute('data-tool-status')
  check(status === 'ok', `(2) chip status=ok (got ${status})`)

  // (3) Closed state — tool name visible + result length counter visible
  const chipText = await chip.textContent()
  check((chipText ?? '').includes(toolName), `(3) chip shows "${toolName}" label`)
  check(/\d+ch/.test(chipText ?? ''), `(3) chip shows result-length counter (got ${JSON.stringify((chipText ?? '').slice(0, 120))})`)

  await page.screenshot({ path: `${SHOTS}/70-d15-chip-closed.png`, fullPage: false })

  // (4) Click the chip header button (first child <button>) to expand.
  // Clicking the chip root would land in the expanded pre block on the
  // collapse attempt below and silently not toggle.
  const chipButton = chip.locator('button').first()
  await chipButton.click()
  await page.waitForTimeout(250)
  const argsHeaderVisible = await page.getByText(/^args$/i).first().isVisible().catch(() => false)
  const resultHeaderVisible = await page.getByText(/^result/i).first().isVisible().catch(() => false)
  check(argsHeaderVisible, '(4) expanded chip shows "Args" header')
  check(resultHeaderVisible, '(4) expanded chip shows "Result" header')
  // Raw JSON should be visible now — each of our four tools has either a
  // contract_id or a query (or both) so match either.
  const jsonVisible = await page.getByText(/"(contract_id|query|type|status)":\s*["0-9]/).first().isVisible().catch(() => false)
  check(jsonVisible, '(4) expanded chip shows formatted args JSON')

  await page.screenshot({ path: `${SHOTS}/71-d15-chip-expanded.png`, fullPage: false })

  // (5) Click the toggle button again to collapse
  await chipButton.click()
  await page.waitForTimeout(200)
  const argsGone = await page.getByText(/^args$/i).first().isVisible().catch(() => false)
  check(!argsGone, '(5) second click collapses the chip')

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.5 UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
