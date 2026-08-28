#!/usr/bin/env node
/**
 * D.1.4b end-to-end verify — agent picks the right tool for the question.
 *
 * D.1.4b's heavy lifting (tool shape + correctness) is in the Python smoke
 * (apps/agents/scripts/smoke_d14b.py) which runs deterministically.
 *
 * This script does ONE additional job: prove that when the user lands on
 * the dashboard (no page context) and asks a list question, the agent
 * selects contract_search — not contract_get. That tests the LLM's tool
 * selection logic + the new event envelopes flowing through Fastify + the
 * Python orchestrator loop.
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

  let lastStreamText = ''
  page.on('response', async resp => {
    if (resp.request().method() === 'POST' && resp.url().endsWith('/api/v1/agent/chat')) {
      try { lastStreamText = await resp.text() } catch {}
    }
  })

  // Land on dashboard so there's no contract page-context (forces the agent
  // to use contract_search to find the MSA rather than jumping to contract_get).
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  const composer = page.getByTestId('side-agent-composer')
  await composer.fill('List every MSA in the account. Answer with just the counterparty names separated by commas.')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(400)

  const hasSearch = /"name":\s*"contract_search"/.test(lastStreamText)
  check(hasSearch, 'agent called contract_search for a list question (no page context)')
  const usedSlaFilter = /"type":\s*"MSA"/.test(lastStreamText)
  check(usedSlaFilter, 'agent passed type=MSA as a filter')

  const assistantText = (await page.getByTestId('side-agent-msg-assistant').first().textContent().catch(() => '')) ?? ''
  check(/acme/i.test(assistantText),
        `reply names Acme as an MSA counterparty (got ${JSON.stringify(assistantText.slice(0, 160))})`)

  await page.screenshot({ path: `${SHOTS}/69-d14b-search-grounded.png`, fullPage: false })

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.1.4b UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
