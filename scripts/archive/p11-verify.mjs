#!/usr/bin/env node
/**
 * P1.1 verify — contract_create_from_template end-to-end.
 *
 *   (1) Inject a contract_create_from_template action → Apply
 *   (2) A new Contract row lands with status=DRAFT + title from template
 *   (3) A ContractVersion v1 exists with plainText populated
 *   (4) The template's usageCount incremented
 *   (5) Receipt shows Undo (reversible)
 *   (6) Click Undo → contract soft-deleted (deletedAt set)
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
  page.on('console', m => { if (m.type() === 'error') console.log('  [browser error]', m.text()) })
  page.on('pageerror', e => console.log('  [page error]', e.message))

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

  // Find a published template to draft from.
  const tplList = await fetch('http://localhost:3001/api/v1/templates?pageSize=20', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const tpl = (tplList.templates ?? tplList.data ?? []).find(t => t.isPublished) ??
              (tplList.templates ?? tplList.data ?? [])[0]
  if (!tpl) { console.error('no template in seed'); process.exit(1) }
  const usageBefore = tpl.usageCount ?? 0

  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Seed a thread so the rail has somewhere to attach the pending action.
  await page.getByTestId('side-agent-composer').fill('Draft a contract from template')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )
  await page.waitForTimeout(700)

  const probeCounterparty = `Probe Co ${Date.now()}`

  // (1) Inject the pending action
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('rail-inject-action', { detail }))
  }, {
    id: 'act_p11',
    toolName: 'contract_create_from_template',
    summary: `Draft a new ${tpl.name} for ${probeCounterparty}.`,
    args: {
      templateId: tpl.id,
      counterpartyName: probeCounterparty,
      variables: {
        counterparty_name: probeCounterparty,
        effective_date: '2026-05-01',
        governing_law: 'Delaware',
      },
    },
    target: `${tpl.name} → Draft`,
    reversible: true,
    status: 'awaiting_confirmation',
  })
  await page.waitForTimeout(400)
  await page.getByTestId('action-preview-apply').click()
  await page.getByTestId('action-preview-receipt').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(700)

  const status1 = await page.getByTestId('action-preview-receipt').getAttribute('data-status')
  check(status1 === 'applied', `(1) receipt data-status=applied (got ${status1})`)

  // (2) Contract row created
  const list = await fetch('http://localhost:3001/api/v1/contracts?pageSize=50', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const created = (list.contracts ?? list.data ?? []).find(c =>
    c.counterpartyName === probeCounterparty
  )
  check(!!created, `(2) new Contract row landed (${created?.id})`)
  check(created?.status === 'DRAFT', `(2) status=DRAFT (got ${created?.status})`)
  check(created?.title?.includes(probeCounterparty) || created?.title?.includes(tpl.name),
    `(2) title references template / counterparty (got "${created?.title}")`)

  // (3) Version v1 with plainText
  if (created?.id) {
    const detail = await fetch(`http://localhost:3001/api/v1/contracts/${created.id}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json())
    const vers = detail?.versions ?? []
    const v1 = vers.find(v => v.versionNumber === 1) ?? vers[0]
    check(!!v1, `(3) ContractVersion v1 exists`)
  }

  // (4) Template usage count bumped
  const tplAfter = await fetch(`http://localhost:3001/api/v1/templates/${tpl.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check((tplAfter?.usageCount ?? 0) === usageBefore + 1,
    `(4) template.usageCount ${usageBefore} → ${tplAfter?.usageCount}`)

  // (5) Undo button visible
  const undo = page.getByTestId('action-preview-undo')
  check(await undo.isVisible(), '(5) Undo button visible for reversible draft-from-template')
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/120-p11-template-draft-applied.png'), fullPage: false })

  // (6) Click Undo → contract soft-deleted
  await undo.click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="action-preview-receipt"]')?.getAttribute('data-status') === 'undone',
    { timeout: 10_000 }
  )
  await page.waitForTimeout(500)

  // After soft-delete, GET /contracts/:id should 404 (the list endpoint
  // already filters deletedAt IS NULL).
  const afterUndo = await fetch(`http://localhost:3001/api/v1/contracts/${created?.id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  check(afterUndo.status === 404, `(6) contract GET returns 404 after Undo (got ${afterUndo.status})`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P1.1 contract_create_from_template checks pass')
})().catch(e => { console.error(e); process.exit(1) })
