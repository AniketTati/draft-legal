#!/usr/bin/env node
/**
 * D.5.5 verify — contract_update write tool end-to-end.
 *
 *   (1) Inject a set_status action (DRAFT → PENDING_REVIEW) + Apply
 *   (2) Contract row reflects the new status
 *   (3) Receipt shows Undo button (reversible + within 15-min window)
 *   (4) Click Undo → status reverts to DRAFT
 *   (5) Inject a second action of a *different* kind (add_tag) + Apply +
 *       verify the tag lands on contract.tags
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
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })

  // Pick a DRAFT contract. The seed starts a few in DRAFT.
  const list = await fetch('http://localhost:3001/api/v1/contracts?pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const draft = (list.contracts ?? list.data ?? []).find(c => c.status === 'DRAFT')
  if (!draft) { console.error('no DRAFT contract in seed'); process.exit(1) }

  await page.goto(`http://localhost:5173/contracts/${draft.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Seed a thread
  await page.getByTestId('side-agent-composer').fill('Status change test')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(700)

  // (1) Inject contract_update(set_status) action
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d55_1',
    toolName: 'contract_update',
    summary: 'Move this contract from DRAFT to PENDING_REVIEW so Legal can review it.',
    args: {
      contractId: draft.id,
      action: 'set_status',
      payload: { status: 'PENDING_REVIEW' },
    },
    target: `${draft.title} · status`,
    reversible: true,
    status: 'awaiting_confirmation',
    diff: [{ field: 'status', before: 'DRAFT', after: 'PENDING_REVIEW' }],
  })
  await page.waitForTimeout(400)
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)

  const status1 = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(status1 === 'applied', `(1) receipt data-status=applied (got ${status1})`)

  // (2) Contract row reflects new status
  const after = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(after.status === 'PENDING_REVIEW', `(2) contract.status = PENDING_REVIEW (got ${after.status})`)

  // (3) Undo button visible
  const undo = page.getByTestId('action-preview-undo')
  check(await undo.isVisible(), '(3) Undo button visible for reversible set_status')
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/100-d55-status-change-applied.png'), fullPage: false })

  // (4) Click undo → status reverts
  await undo.click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )
  const reverted = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(reverted.status === 'DRAFT', `(4) Undo reverts status to DRAFT (got ${reverted.status})`)

  // (5) Add a tag action
  const probeTag = `d55-tag-${Date.now()}`
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d55_2',
    toolName: 'contract_update',
    summary: `Add the "${probeTag}" tag to this contract.`,
    args: {
      contractId: draft.id,
      action: 'add_tag',
      payload: { tag: probeTag },
    },
    target: `${draft.title} · tags`,
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(300)
  await page.getByTestId('action-preview-apply').click()
  // Wait for at least one applied receipt. Both actions share the testid, so
  // pick the last one.
  await page.waitForTimeout(1200)

  const afterTag = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(Array.isArray(afterTag.tags) && afterTag.tags.includes(probeTag), `(5) add_tag landed ${probeTag} in contract.tags (got ${JSON.stringify(afterTag.tags)})`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.5.5 contract_update checks pass')
})().catch(e => { console.error(e); process.exit(1) })
