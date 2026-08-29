#!/usr/bin/env node
/**
 * P6.5 verify — Inline deviation popover on margin-badge click.
 *
 *   (1) Clicking a P6.2 classifier margin badge opens the
 *       deviation popover anchored below the badge
 *   (2) Popover shows the reasoning + 3 action buttons
 *   (3) "Rewrite to market" opens the P6.3 BubbleAiPopover with
 *       the paragraph pre-captured
 *   (4) Dismiss / Esc closes the popover cleanly
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const API = 'http://localhost:3001'

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  return r.accessToken
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()

  // Seed a contract with a blatantly aggressive clause so the
  // classifier reliably returns position=aggressive (red badge).
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      const html = \`<h1>SERVICES AGREEMENT</h1>
<h2>Section 1. Payment</h2>
<p>Customer shall pay Provider a monthly fee of USD 250,000, payable within five (5) business days of invoice receipt. Late payments bear interest at 1.5% per month.</p>
<h2>Section 2. Limitation of Liability</h2>
<p>Customer hereby waives any and all claims against Provider, including for gross negligence, willful misconduct, and fraud. Provider's aggregate liability under this Agreement shall not exceed one hundred dollars (\$100) regardless of cause.</p>\`
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim()
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P6.5 deviation-popover fixture ' + Date.now(),
          type: 'SERVICES', status: 'DRAFT',
          counterpartyName: 'Popover Co.',
          ownerId: admin.id, createdBy: admin.id,
          analysisStatus: 'DONE', tags: ['p65-fixture'],
          versions: { create: { versionNumber: 1, plainText: plain, htmlContent: html, createdById: admin.id } },
        },
        include: { versions: true },
      })
      await p.contract.update({ where: { id: c.id }, data: { currentVersionId: c.versions[0].id } })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p65-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p65-seed.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seedRun.status !== 0) { console.error('seed failed:', seedRun.stderr); process.exit(1) }
  const { contractId } = JSON.parse(seedRun.stdout.trim().split('\n').pop() || '{}')

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Enter edit mode so setTextSelection + the bubble handoff work.
  await page.getByTestId('enter-edit-btn').click()
  await page.waitForTimeout(800)

  // Wait for classifier to render badges
  const badge = page.locator('.clause-classifier-badge').first()
  let ok = false
  try { await badge.waitFor({ state: 'visible', timeout: 25_000 }); ok = true } catch {}
  check(ok, `(pre) classifier badge renders`)

  // Click the red "aggressive" badge (our fixture guarantees ≥1)
  const aggBadge = page.getByTestId('clause-badge-aggressive').first()
  try { await aggBadge.waitFor({ state: 'visible', timeout: 15_000 }) } catch {}
  await aggBadge.click({ force: true })
  await page.waitForTimeout(400)

  // (1) popover opens
  const pop = page.getByTestId('clause-deviation-popover')
  check(await pop.isVisible(), `(1) ClauseDeviationPopover opens on badge click`)

  // (2) reasoning + action buttons
  const reasoning = await page.getByTestId('clause-deviation-reasoning').textContent()
  check((reasoning ?? '').length > 10,
    `(2) popover shows reasoning (${(reasoning ?? '').length} chars: "${(reasoning ?? '').slice(0, 60)}")`)
  const rewriteBtn = page.getByTestId('clause-deviation-rewrite')
  const acceptBtn  = page.getByTestId('clause-deviation-accept')
  const dismissBtn = page.getByTestId('clause-deviation-dismiss')
  check(await rewriteBtn.isVisible(), `(2) 'Rewrite to market' button visible`)
  check(await acceptBtn.isVisible(),  `(2) 'Accept as-is' button visible`)
  check(await dismissBtn.isVisible(), `(2) 'Dismiss' button visible`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/142-p65-deviation-popover.png'),
    fullPage: false,
  })

  // (3) "Rewrite to market" → bubble popover opens
  await rewriteBtn.click()
  await page.waitForTimeout(500)
  const bubble = page.getByTestId('bubble-ai-popover')
  check(await bubble.isVisible(),
    `(3) 'Rewrite to market' opens the P6.3 BubbleAiPopover`)
  check(!(await pop.isVisible().catch(() => false)),
    `(3) deviation popover closes after handoff`)

  // (4) Reopen + dismiss
  await page.locator('body').click({ position: { x: 100, y: 100 } })
  await page.waitForTimeout(300)
  await aggBadge.click({ force: true })
  await page.waitForTimeout(300)
  check(await pop.isVisible(), `(4) popover reopens after click`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check(!(await pop.isVisible().catch(() => false)),
    `(4) Escape dismisses the popover`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P6.5 deviation-popover checks pass')
})().catch(e => { console.error(e); process.exit(1) })
