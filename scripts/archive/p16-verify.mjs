#!/usr/bin/env node
/**
 * P1.6 verify — <RedlinePreview /> UI inline in the rail.
 *
 *   (1) A redline_propose tool_call_result injected into the rail
 *       renders the RedlinePreview component (not the JSON chip)
 *   (2) All three aggression tabs are visible; 'moderate' is default
 *   (3) Switching tabs changes the rendered rationale / changes
 *   (4) Clicking "Apply Moderate" spawns an Intent Preview scoped to
 *       redline_apply
 *   (5) Confirming the Intent Preview lands a new redline_apply version
 *       (changeNote contains "redline_apply")
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

function findMsa() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_find-msa-with-liability.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const line = r.stdout.trim().split('\n').pop() || 'null'
  return line === 'null' ? null : JSON.parse(line)
}

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
}

;(async () => {
  const msa = findMsa()
  if (!msa) { console.error('MSA not found'); process.exit(1) }

  // Generate a real redline proposal up front so we don't have to wait
  // for the agent's routing non-determinism.
  const proposalRes = callTool('redline_propose', {
    orgId: msa.orgId, contractId: msa.id, clauseType: 'limitation_of_liability',
    instructions: 'Mutual 12-month cap with consequential-damages carve-out.',
  })
  if (proposalRes.status !== 200 || !proposalRes.body?.variants?.length) {
    console.error('upstream redline_propose failed:', JSON.stringify(proposalRes).slice(0, 300))
    process.exit(1)
  }

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

  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  await page.waitForTimeout(400)

  // Seed a thread so the rail has an assistant bubble to attach the
  // injected tool result to.
  await page.getByTestId('side-agent-composer').fill('Show me the redline options')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 120_000 }
  )
  await page.waitForTimeout(600)

  // Inject a synthetic redline_propose tool_call_result that matches
  // what the agent would emit.
  await page.evaluate((proposal) => {
    window.dispatchEvent(new CustomEvent('rail-inject-tool-result', {
      detail: {
        id: 'tc_synth_redline',
        name: 'redline_propose',
        args: { contractId: proposal.contract.id, clauseId: proposal.clause.id },
        status: 'ok',
        resultPreview: JSON.stringify(proposal),
        redlineProposal: proposal,
      },
    }))
  }, proposalRes.body)
  await page.waitForTimeout(500)

  // (1) RedlinePreview renders
  const rp = page.getByTestId('redline-preview').first()
  check(await rp.isVisible(), '(1) redline-preview component rendered inline')
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/122-p16-redline-preview.png'), fullPage: false })

  // (2) Three tabs; moderate active
  for (const aggression of ['least', 'moderate', 'aggressive']) {
    const tab = page.getByTestId(`redline-preview-tab-${aggression}`)
    check(await tab.isVisible(), `(2) tab "${aggression}" visible`)
  }
  const modSelected = await page.getByTestId('redline-preview-tab-moderate').getAttribute('aria-selected')
  check(modSelected === 'true', `(2) moderate tab is default-active (aria-selected=${modSelected})`)

  // (3) Switching tabs changes content
  const contentBefore = await rp.innerText()
  await page.getByTestId('redline-preview-tab-aggressive').click()
  await page.waitForTimeout(250)
  const contentAfter = await rp.innerText()
  check(contentBefore !== contentAfter, '(3) content changes on tab switch')

  // (4) Click "Apply moderate" → Intent Preview scoped to redline_apply
  await page.getByTestId('redline-preview-tab-moderate').click()
  await page.waitForTimeout(200)
  await page.getByTestId('redline-preview-apply-moderate').click()
  await page.waitForTimeout(400)

  const applyPreview = page.getByTestId('action-preview').first()
  check(await applyPreview.isVisible(), '(4) Intent Preview surface appears')
  const tool = await applyPreview.getAttribute('data-tool')
  check(tool === 'redline_apply', `(4) Intent Preview scope = redline_apply (got ${tool})`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/123-p16-intent-preview.png'), fullPage: false })

  // (5) Apply → new redline_apply ContractVersion lands
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1200)
  const receiptStatus = await page.getByTestId('action-preview-receipt').first().getAttribute('data-status')
  check(receiptStatus === 'applied', `(5) action-preview-receipt data-status=applied (got ${receiptStatus})`)

  const dumpR = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_dump-contract-versions.ts', msa.id], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const jsonStart = dumpR.stdout.indexOf('{')
  const jsonEnd   = dumpR.stdout.lastIndexOf('}')
  const dump = jsonStart >= 0 ? JSON.parse(dumpR.stdout.slice(jsonStart, jsonEnd + 1)) : {}
  const redlineVersions = (dump.versions ?? []).filter(v =>
    (v.changeNote ?? '').includes('redline_apply')
  )
  check(redlineVersions.length >= 1,
    `(5) new ContractVersion(s) with redline_apply changeNote exist (got ${redlineVersions.length})`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P1.6 <RedlinePreview /> checks pass')
})().catch(e => { console.error(e); process.exit(1) })
