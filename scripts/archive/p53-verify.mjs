#!/usr/bin/env node
/**
 * P5.3 verify — Renewal advisor.
 *
 *   (1) POST /api/v1/cron/renewals flags contracts expiring ≤90d and
 *       fires RENEWAL_DUE notifications
 *   (2) POST /contracts/:id/renewal-advice calls the Python advisor
 *       and persists Contract.metadata.renewalAdvice
 *   (3) renewal_advice agent tool returns the cached advice + counts
 *   (4) POST /contracts/:id/renewal-decision stops future reminders
 *   (5) UI rail renders the recommendation + points + decision buttons
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

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
}

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // ── Seed an EXECUTED contract with expiryDate 45 days out + rich
  //    text so the renewal advisor has something real to reason about.
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      if (!admin) throw new Error('admin not found')
      const rich = \`MASTER SERVICES AGREEMENT

This Agreement is entered between Demo Org, Inc. and Zephyr Labs, LLC.

Section 1. Term.
This Agreement commences on January 1, 2025 and expires on June 30, 2026 (the "Initial Term"). It shall renew automatically for successive one-year terms unless either party provides 60 days written notice of non-renewal.

Section 2. Fees.
Customer shall pay Provider USD 150,000 per month, billed quarterly in advance.

Section 3. Service Levels.
Provider shall maintain 99.95% uptime measured monthly. Credits of 10% of monthly fee apply for each 0.1% below target.

Section 4. Limitation of Liability.
Provider's aggregate liability shall not exceed twelve (12) months of fees paid in the preceding period, except for breaches of confidentiality or indemnification obligations.

Section 5. Price Adjustment.
Fees may increase by CPI plus 3% annually on renewal.

Section 6. Termination for Convenience.
Neither party may terminate for convenience during the Initial Term.

IN WITNESS WHEREOF, the parties have executed this Agreement.\`
      const expiry = new Date(Date.now() + 45 * 86_400_000)
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P5.3 renewal-advisor fixture ' + Date.now(),
          type: 'MSA',
          status: 'EXECUTED',
          counterpartyName: 'Zephyr Labs, LLC',
          ownerId: admin.id,
          createdBy: admin.id,
          analysisStatus: 'DONE',
          tags: ['p53-fixture'],
          value: 1_800_000,
          currency: 'USD',
          expiryDate: expiry,
          effectiveDate: new Date('2025-01-01'),
          versions: {
            create: {
              versionNumber: 1,
              plainText: rich,
              htmlContent: '<p>' + rich.replace(/\\n\\n/g, '</p><p>').replace(/\\n/g, ' ') + '</p>',
              createdById: admin.id,
            },
          },
        },
        include: { versions: true },
      })
      await p.contract.update({
        where: { id: c.id },
        data:  { currentVersionId: c.versions[0].id },
      })
      // also clear any prior RENEWAL_DUE rows on this user so we can
      // count this run's output cleanly.
      await p.notification.deleteMany({ where: { userId: admin.id, type: 'RENEWAL_DUE' } })
      console.log(JSON.stringify({ contractId: c.id, orgId: admin.orgId, ownerId: admin.id, expiry: expiry.toISOString().slice(0,10) }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p53-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p53-seed.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seedRun.status !== 0) { console.error('seed failed:', seedRun.stderr); process.exit(1) }
  const seedLine = seedRun.stdout.trim().split('\n').pop() || '{}'
  const { contractId, orgId, expiry } = JSON.parse(seedLine)

  // (1) Cron scanner
  const scan = await fetch(`${API}/api/v1/cron/renewals`, {
    method: 'POST', headers: H, body: JSON.stringify({ leadDays: 90, force: true }),
  }).then(r => r.json())
  check(scan.ok === true, `(1) /cron/renewals returns ok=true`)
  check((scan.result?.notified ?? 0) >= 1,
    `(1) ≥1 RENEWAL_DUE emitted (got ${scan.result?.notified})`)
  check((scan.result?.candidates ?? 0) >= 1,
    `(1) ≥1 candidate in 90d window (got ${scan.result?.candidates})`)

  // Give the BullMQ notify worker a beat.
  let renewalRows = []
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 400))
    const res = await fetch(`${API}/api/v1/approvals/notifications?limit=50`, { headers: H }).then(r => r.json())
    renewalRows = (res.data ?? []).filter(n => n.type === 'RENEWAL_DUE' && n.resourceId === contractId)
    if (renewalRows.length >= 1) break
  }
  check(renewalRows.length >= 1,
    `(1) Notification row persisted (got ${renewalRows.length})`)
  check(renewalRows[0]?.title?.startsWith('Expires in'),
    `(1) title has "Expires in Xd" prefix (${renewalRows[0]?.title?.slice(0, 60)})`)

  // (2) LLM-backed advisor
  const adviceR = await fetch(`${API}/api/v1/contracts/${contractId}/renewal-advice`, {
    method: 'POST', headers: H, body: '{}',
  })
  const adviceStatus = adviceR.status
  const adviceBody = await adviceR.json().catch(() => ({}))
  check(adviceStatus === 200, `(2) /renewal-advice returns 200 (got ${adviceStatus})`)
  const advice = adviceBody.advice ?? {}
  check(
    ['renew', 'renegotiate', 'let_expire', 'pause'].includes(advice.recommendation),
    `(2) recommendation is one of the 4 enums (got "${advice.recommendation}")`,
  )
  check(typeof advice.rationale === 'string' && advice.rationale.length > 20,
    `(2) rationale has ≥20 chars (got ${advice.rationale?.length ?? 0})`)
  check(Array.isArray(advice.negotiationPoints) && advice.negotiationPoints.length >= 1,
    `(2) ≥1 negotiation point (got ${advice.negotiationPoints?.length ?? 0})`)
  const point = advice.negotiationPoints?.[0]
  check(point && typeof point.topic === 'string' && typeof point.ourPosition === 'string',
    `(2) first point has topic + ourPosition`)

  // Confirm persistence
  const c2 = await fetch(`${API}/api/v1/contracts/${contractId}`, { headers: H }).then(r => r.json())
  const persisted = c2?.metadata?.renewalAdvice ?? null
  check(persisted && persisted.recommendation === advice.recommendation,
    `(2) Contract.metadata.renewalAdvice persisted`)

  // (3) Agent tool — portfolio view
  const portfolio = callTool('renewal_advice', { orgId, leadDays: 90 })
  check(portfolio.status === 200, `(3) renewal_advice tool returns 200 (got ${portfolio.status})`)
  check(Array.isArray(portfolio.body?.items) && portfolio.body.items.length >= 1,
    `(3) portfolio view returns ≥1 item (got ${portfolio.body?.items?.length ?? 0})`)
  check(portfolio.body?.counts && typeof portfolio.body.counts === 'object',
    `(3) tool returns counts object (got ${JSON.stringify(portfolio.body?.counts ?? {}).slice(0, 80)})`)
  const byContract = callTool('renewal_advice', { orgId, contractId })
  check(byContract.body?.items?.[0]?.renewalAdvice?.recommendation === advice.recommendation,
    `(3) by-contract lookup returns the persisted advice`)

  // (4) renewal-decision
  const decR = await fetch(`${API}/api/v1/contracts/${contractId}/renewal-decision`, {
    method: 'POST', headers: H, body: JSON.stringify({ decision: 'renew' }),
  }).then(r => r.json())
  check(decR.ok === true && decR.decision === 'renew',
    `(4) /renewal-decision persists decision (got ${JSON.stringify(decR)})`)

  const scan2 = await fetch(`${API}/api/v1/cron/renewals`, {
    method: 'POST', headers: H, body: JSON.stringify({ leadDays: 90 }),
  }).then(r => r.json())
  check((scan2.result?.notified ?? 0) === 0,
    `(4) re-scan after decision notifies 0 new (got ${scan2.result?.notified})`)

  // (5) UI
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const section = page.getByTestId('renewal-advice-section')
  check(await section.isVisible(), `(5) Renewal rail section renders`)

  const rec = page.getByTestId('renewal-recommendation')
  check(await rec.isVisible(), `(5) recommendation pill visible`)
  const recValue = await rec.getAttribute('data-recommendation')
  check(['renew', 'renegotiate', 'let_expire', 'pause'].includes(recValue ?? ''),
    `(5) pill has data-recommendation attr (${recValue})`)

  const pointCount = await page.locator('[data-testid^="renewal-point-"]').count()
  check(pointCount >= 1, `(5) ≥1 negotiation point row visible (got ${pointCount})`)

  const renewBtn = page.getByTestId('renewal-decision-renew')
  check(await renewBtn.isVisible(), `(5) 'Renew' decision button visible`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/137-p53-renewal-advisor.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P5.3 renewal-advisor checks pass')
})().catch(e => { console.error(e); process.exit(1) })
