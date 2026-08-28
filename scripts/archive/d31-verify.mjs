#!/usr/bin/env node
/**
 * D.3.1 verify — ActionPreview UI.
 *
 * Inject a mock PendingAction via the rail-inject-action dev hook and
 * exercise the card's states without a real write tool:
 *
 *   (1) Card renders with summary + target + diff + 3 buttons
 *   (2) Click Edit → Arguments textarea appears
 *   (3) Click Review → textarea hides
 *   (4) Click Apply → card transitions to "running" spinner → "applied"
 *       receipt
 *   (5) Second injection + Cancel → "cancelled" receipt
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
  await page.waitForTimeout(600)

  // Inject a mock action into the rail
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail: {
      id: 'act_1',
      toolName: 'comment_add',
      summary: "Add a comment to §9.2 asking whether the carve-outs apply to wilful misconduct breaches.",
      args: { contractId: 'cmocp-demo', section: '9.2', body: 'Should this carve-out also apply to wilful misconduct breaches?' },
      target: 'Acme Corporation — MSA · §9.2 Cap on damages',
      reversible: true,
      status: 'awaiting_confirmation',
    } }))
  })
  await page.waitForTimeout(400)

  // (1) Card renders with expected pieces
  const card = page.getByTestId('action-preview')
  check(await card.isVisible(), '(1) ActionPreview card visible')
  const tool = await card.getAttribute('data-tool')
  check(tool === 'comment_add', `(1) data-tool=comment_add (got ${tool})`)
  check(await page.getByText('About to run').first().isVisible(), '(1) "About to run" header visible')
  check(await page.getByText(/§9\.2/).first().isVisible(), '(1) target reference visible')
  check(await page.getByText('Undoable').first().isVisible(), '(1) "Undoable" badge visible for reversible action')
  check(await page.getByTestId('action-preview-apply').isVisible(), '(1) Apply button visible')
  check(await page.getByTestId('action-preview-cancel').isVisible(), '(1) Cancel button visible')
  check(await page.getByTestId('action-preview-edit').isVisible(), '(1) Edit button visible')

  await page.screenshot({ path: `${SHOTS}/84-d31-action-preview-awaiting.png`, fullPage: false })

  // (2) Click Edit → textarea
  await page.getByTestId('action-preview-edit').click()
  await page.waitForTimeout(200)
  const args = page.getByTestId('action-preview-args')
  check(await args.isVisible(), '(2) Arguments textarea appears on Edit')
  const argsText = await args.inputValue()
  check(/contractId/.test(argsText) && /section/.test(argsText), '(2) Arguments JSON is the full args object')

  await page.screenshot({ path: `${SHOTS}/85-d31-action-preview-editing.png`, fullPage: false })

  // (3) Click Review (same button, toggled) → textarea hides
  await page.getByTestId('action-preview-edit').click()
  await page.waitForTimeout(200)
  const argsAfter = await page.getByTestId('action-preview-args').count()
  check(argsAfter === 0, '(3) Arguments textarea hides when toggled back to Review')

  // (4) Click Apply → running → applied receipt
  await page.getByTestId('action-preview-apply').click()
  await page.waitForTimeout(1000)  // give the stub 600ms + buffer
  const receipt = page.getByTestId('action-preview-receipt')
  check(await receipt.isVisible(), '(4) Compact receipt replaces the card after Apply')
  const receiptStatus = await receipt.getAttribute('data-status')
  check(receiptStatus === 'applied', `(4) receipt data-status=applied (got ${receiptStatus})`)

  // (5) Inject a second action, hit Cancel
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail: {
      id: 'act_2',
      toolName: 'request_create',
      summary: 'Create a review request assigned to Legal-Tier-2.',
      args: { assigneeTeam: 'Legal-Tier-2', title: 'Review Pied Piper Vendor Agreement' },
      reversible: false,
      status: 'awaiting_confirmation',
    } }))
  })
  await page.waitForTimeout(400)
  await page.getByTestId('action-preview-cancel').click()
  await page.waitForTimeout(400)
  const cancelledReceipts = page.getByTestId('action-preview-receipt')
  const count = await cancelledReceipts.count()
  check(count >= 2, `(5) two receipts present after cancel (got ${count})`)

  await page.screenshot({ path: `${SHOTS}/86-d31-action-receipts.png`, fullPage: false })

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.3.1 ActionPreview checks pass')
})().catch(e => { console.error(e); process.exit(1) })
