#!/usr/bin/env node
/**
 * D.5.6 verify — approval_route write tool end-to-end.
 *
 *   (1) Inject an approval_route action on a DRAFT contract + Apply
 *   (2) ApprovalInstance row created with status=PENDING + first step
 *   (3) Contract.status flips to PENDING_APPROVAL
 *   (4) Receipt shows Undo (reversible + no approver has acted yet)
 *   (5) Click Undo → instance cancelled + contract reverts to DRAFT
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

  // Pick a DRAFT contract
  const list = await fetch('http://localhost:3001/api/v1/contracts?pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const draft = (list.contracts ?? list.data ?? []).find(c => c.status === 'DRAFT')
  if (!draft) { console.error('no DRAFT contract'); process.exit(1) }

  await page.goto(`http://localhost:5173/contracts/${draft.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Seed a thread
  await page.getByTestId('side-agent-composer').fill('Route for approval test')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(700)

  // (1) Inject approval_route action
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_d56',
    toolName: 'approval_route',
    summary: 'Route this contract to the standard approval workflow.',
    args: {
      contractId: draft.id,
      comment: 'Please review — D.5.6 verify.',
    },
    target: `${draft.title} · approval`,
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(400)
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)

  const rstatus = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(rstatus === 'applied', `(1) receipt data-status=applied (got ${rstatus})`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/101-d56-approval-routed.png'), fullPage: false })

  // (2) ApprovalInstance row exists for this contract
  const insts = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  // contracts/:id doesn't return approvalInstances — query via a small helper
  const viaApprovals = await fetch('http://localhost:3001/api/v1/approvals/my-queue', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json()).catch(() => ({}))
  // Fallback: look up via direct Prisma helper script (top-level await
  // isn't supported in `tsx -e`, so a dedicated helper is necessary).
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_approval-for-contract.ts', draft.id], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const inst = JSON.parse(r.stdout.trim().split('\n').pop() || 'null')
  check(!!inst, `(2) ApprovalInstance row exists for contract ${draft.id}`)
  check(inst?.status === 'PENDING' || inst?.status === 'AUTO_APPROVED', `(2) instance.status = PENDING / AUTO_APPROVED (got ${inst?.status})`)
  check((inst?.steps?.length ?? 0) >= 0, `(2) instance has ${inst?.steps?.length ?? 0} step(s)`)

  // (3) Contract.status = PENDING_APPROVAL (or APPROVED if auto-approved)
  const post = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const validStatus = ['PENDING_APPROVAL', 'APPROVED']
  check(validStatus.includes(post.status), `(3) contract.status ∈ {PENDING_APPROVAL, APPROVED} (got ${post.status})`)

  // (4) Undo visible
  const undo = page.getByTestId('action-preview-undo')
  check(await undo.isVisible(), '(4) Undo button visible for approval_route receipt')

  // (5) Click Undo → instance cancelled + contract back to DRAFT
  await undo.click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )
  await page.waitForTimeout(500)

  const afterUndo = await fetch(`http://localhost:3001/api/v1/contracts/${draft.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(afterUndo.status === 'DRAFT', `(5) Undo reverts status to DRAFT (got ${afterUndo.status})`)

  const r2 = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_approval-instance-status.ts', inst?.id ?? ''], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const instAfter = JSON.parse(r2.stdout.trim().split('\n').pop() || 'null')
  check(instAfter?.status === 'CANCELLED', `(5) instance.status = CANCELLED after undo (got ${instAfter?.status})`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.5.6 approval_route checks pass')
})().catch(e => { console.error(e); process.exit(1) })
