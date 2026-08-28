#!/usr/bin/env node
/**
 * P5.2 verify — obligation reminder + escalation agent.
 *
 *   (1) POST /api/v1/cron/obligations scans obligations, fires
 *       Notifications for items due within the window
 *   (2) The Notification row gets persisted (type=OBLIGATION_DUE)
 *   (3) The obligation is stamped with notifiedAt → idempotency
 *   (4) Re-running the scan without --force skips (cooldown)
 *   (5) NotificationBell renders our OBLIGATION_DUE item
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
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // ── Seed a contract with obligations whose dueDates straddle the
  //    notification window (one due in 3 days, one due tomorrow,
  //    one 5 days overdue). No LLM call — write straight to metadata.
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      if (!admin) throw new Error('admin not found')
      const in3  = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
      const in1  = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10)
      const late = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
      const far  = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
      const obligations = [
        { id: 'o_payment', type: 'payment', description: 'Monthly fee of $100,000 due',
          owner: 'customer', dueDate: in3,  recurrence: 'monthly', trigger: null,
          quote: 'Customer shall pay Provider $100,000 per month.', severity: 'high',
          sectionRef: '1' },
        { id: 'o_report',  type: 'report',  description: 'Deliver monthly ops report',
          owner: 'provider', dueDate: in1,  recurrence: 'monthly', trigger: null,
          quote: 'Provider shall deliver a monthly operations report.', severity: 'medium',
          sectionRef: '4' },
        { id: 'o_overdue', type: 'report',  description: 'Past-due compliance certificate',
          owner: 'provider', dueDate: late, recurrence: 'annually', trigger: null,
          quote: 'Compliance certificate shall be delivered annually.', severity: 'high',
          sectionRef: '5' },
        { id: 'o_faroff',  type: 'audit',   description: 'Audit window 60 days out — should NOT notify',
          owner: 'customer', dueDate: far,  recurrence: 'annually', trigger: null,
          quote: 'Customer may audit once per year on 30 days notice.', severity: 'low',
          sectionRef: '3' },
      ]
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P5.2 obligation-reminder fixture ' + Date.now(),
          type: 'SERVICES',
          status: 'EXECUTED',
          counterpartyName: 'Reminder Co.',
          ownerId: admin.id,
          createdBy: admin.id,
          analysisStatus: 'DONE',
          tags: ['p52-fixture'],
          metadata: { obligations, obligationsSummary: 'seeded for P5.2 verify', obligationsExtractedAt: new Date().toISOString() },
        },
      })
      console.log(JSON.stringify({ contractId: c.id, orgId: admin.orgId, ownerId: admin.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p52-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p52-seed.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seedRun.status !== 0) { console.error('seed failed:', seedRun.stderr); process.exit(1) }
  const seedLine = seedRun.stdout.trim().split('\n').pop() || '{}'
  const { contractId, ownerId } = JSON.parse(seedLine)

  // Also clear any existing OBLIGATION_DUE rows for this user so we can
  // count this run's output cleanly.
  const clearScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      await p.notification.deleteMany({ where: { userId: '${ownerId}', type: 'OBLIGATION_DUE' } })
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p52-clear.ts', clearScript)
  spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p52-clear.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })

  // (1) run the scanner with leadDays=7
  const scan1 = await fetch(`${API}/api/v1/cron/obligations`, {
    method: 'POST', headers: H, body: JSON.stringify({ leadDays: 7, force: true }),
  }).then(r => r.json())
  check(scan1.ok === true, `(1) /cron/obligations returns ok=true`)
  check((scan1.result?.notified ?? 0) >= 3,
    `(1) ≥3 notifications emitted (got ${scan1.result?.notified}) — skipped: cd=${scan1.result?.skippedCooldown}, noOwner=${scan1.result?.skippedNoOwner}, acked=${scan1.result?.skippedAcked}`)
  check((scan1.result?.obligationsSeen ?? 0) >= 4,
    `(1) obligationsSeen ≥4 across fixture + other seeded contracts (got ${scan1.result?.obligationsSeen})`)

  // (2) Wait for the BullMQ notify worker to flush the queue.
  let rows = []
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    const res = await fetch(`${API}/api/v1/approvals/notifications?limit=50`, { headers: H }).then(r => r.json())
    rows = (res.data ?? []).filter(n => n.type === 'OBLIGATION_DUE' && n.resourceId === contractId)
    if (rows.length >= 3) break
  }
  check(rows.length >= 3,
    `(2) ≥3 OBLIGATION_DUE notification rows for fixture contract (got ${rows.length})`)
  const first = rows[0]
  check(first && typeof first.title === 'string' && first.title.length > 0,
    `(2) notification has title (${first?.title?.slice(0, 60)})`)
  check(first && typeof first.body === 'string' && first.body.includes('·'),
    `(2) notification body has severity · type · desc format`)
  check(first?.resourceType === 'contract',
    `(2) notification resourceType is 'contract'`)

  // (3) obligations gained notifiedAt on the row
  const c2 = await fetch(`${API}/api/v1/contracts/${contractId}`, { headers: H }).then(r => r.json())
  const stamped = (c2?.metadata?.obligations ?? []).filter(o => o.notifiedAt)
  check(stamped.length >= 3,
    `(3) ≥3 obligations stamped with notifiedAt (got ${stamped.length})`)
  const faroff = (c2?.metadata?.obligations ?? []).find(o => o.id === 'o_faroff')
  check(!faroff?.notifiedAt,
    `(3) 60-day-out obligation was NOT notified (notifiedAt=${faroff?.notifiedAt ?? 'null'})`)

  // (4) Second scan without force → cooldown kicks in, 0 new notifications
  const scan2 = await fetch(`${API}/api/v1/cron/obligations`, {
    method: 'POST', headers: H, body: JSON.stringify({ leadDays: 7 }),
  }).then(r => r.json())
  check((scan2.result?.notified ?? 0) === 0,
    `(4) idempotent re-run notifies 0 (got ${scan2.result?.notified})`)
  check((scan2.result?.skippedCooldown ?? 0) >= 3,
    `(4) cooldown skip ≥3 (got ${scan2.result?.skippedCooldown})`)

  // (5) UI — bell shows the notifications
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const bell = page.getByTestId('notification-bell')
  check(await bell.isVisible(), `(5) NotificationBell visible in header`)
  await bell.click()
  await page.waitForTimeout(500)
  const oblItems = await page.getByTestId('notification-OBLIGATION_DUE').count()
  check(oblItems >= 1,
    `(5) bell dropdown shows ≥1 OBLIGATION_DUE item (got ${oblItems})`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/136-p52-obligation-reminders.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P5.2 obligation-reminder checks pass')
})().catch(e => { console.error(e); process.exit(1) })
