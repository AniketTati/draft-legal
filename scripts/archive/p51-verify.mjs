#!/usr/bin/env node
/**
 * P5.1 verify — obligation extractor.
 *
 *   (1) POST /contracts/:id/extract-obligations calls the Python pass
 *       and persists metadata.obligations on the row
 *   (2) Response carries obligations[] + summary text
 *   (3) Each obligation has {type, description, owner, recurrence,
 *       quote, severity}
 *   (4) obligations_list tool returns the extracted obligations
 *   (5) UI rail section renders the obligations after extract
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

  // Seed a dedicated fixture contract with rich, obligation-rich
  // plaintext so the extractor reliably finds multiple obligations.
  // Avoids coupling this verify to whichever contract happens to be
  // in the seed.
  const fixtureScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      if (!admin) throw new Error('admin not found')
      const rich = \`SERVICES AGREEMENT

This Agreement is entered between Demo Org, Inc. and Acme Corporation.

Section 1. Fees and Payment.
Customer shall pay Provider $100,000 per month, payable on the 5th business day of each month, beginning January 1, 2026.

Section 2. Service Levels.
Provider shall maintain 99.9% uptime measured monthly. Provider shall respond to P1 incidents within 1 hour.

Section 3. Audit Rights.
Customer may audit Provider's compliance with this Agreement once per year upon 30 days prior written notice.

Section 4. Reporting.
Provider shall deliver a monthly operations report to Customer within 10 business days of each month-end.

Section 5. Term and Renewal.
This Agreement renews automatically for successive one-year terms unless either party provides 60 days prior written notice of non-renewal.

Section 6. Termination.
Either party may terminate for material breach after 30 days written notice and failure to cure.

IN WITNESS WHEREOF, the parties have executed this Agreement.\`
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P5.1 obligations fixture ' + Date.now(),
          type: 'SERVICES',
          status: 'EXECUTED',
          counterpartyName: 'Acme Corporation',
          ownerId: admin.id,
          createdBy: admin.id,
          analysisStatus: 'DONE',
          tags: ['p51-fixture'],
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
        data: { currentVersionId: c.versions[0].id },
      })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p51-seed.ts', fixtureScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p51-seed.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seedRun.status !== 0) { console.error('seed failed:', seedRun.stderr); process.exit(1) }
  const seedLine = seedRun.stdout.trim().split('\n').pop() || '{}'
  const fixtureId = JSON.parse(seedLine).contractId
  const msa = { id: fixtureId, orgId: null }

  let body = null
  const extractR = await fetch(`${API}/api/v1/contracts/${msa.id}/extract-obligations`, {
    method: 'POST', headers: H, body: '{}',
  })
  const extractStatus = extractR.status
  body = await extractR.json().catch(() => ({}))
  check(extractStatus === 200, `(1) /extract-obligations returns 2xx (got ${extractStatus})`)
  // Fetch orgId for the tool call later
  const contractForOrg = await fetch(`${API}/api/v1/contracts/${msa.id}`, { headers: H }).then(r => r.json())
  msa.orgId = contractForOrg.orgId
  check(body.ok === true || Array.isArray(body.obligations),
    `(1) body carries obligations[] (error: ${body.error ?? 'none'})`)

  // (2/3) Shape + field check
  const obligations = body.obligations ?? []
  check(obligations.length >= 1,
    `(2) ≥1 obligation extracted (got ${obligations.length}) — summary: "${body.summary?.slice(0, 80)}"`)
  if (obligations.length > 0) {
    const o = obligations[0]
    check(typeof o.type === 'string', `(3) first obligation has type (${o.type})`)
    check(typeof o.description === 'string' && o.description.length > 10,
      `(3) first obligation has description (${o.description?.length ?? 0} chars)`)
    check(typeof o.owner === 'string', `(3) first obligation has owner (${o.owner})`)
    check(typeof o.severity === 'string', `(3) first obligation has severity (${o.severity})`)
    check(typeof o.quote === 'string', `(3) first obligation has quote`)
  }

  // Confirm the contract row now carries them
  const c2 = await fetch(`${API}/api/v1/contracts/${msa.id}`, { headers: H }).then(r => r.json())
  const metaOb = c2?.metadata?.obligations ?? []
  check(metaOb.length >= 1, `(1) contract.metadata.obligations persisted (got ${metaOb.length})`)

  // (4) obligations_list tool
  const toolRes = callTool('obligations_list', { orgId: msa.orgId, contractId: msa.id })
  check(toolRes.status === 200, `(4) obligations_list returns 200 (got ${toolRes.status})`)
  check(Array.isArray(toolRes.body?.items) && toolRes.body.items.length >= 1,
    `(4) tool returns ≥1 item for the contract (got ${toolRes.body?.items?.length ?? 0})`)

  // (5) UI — visit the contract detail page, see the obligations list
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  await page.goto(`http://localhost:5173/contracts/${msa.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  const olist = page.getByTestId('obligations-list')
  check(await olist.isVisible(), `(5) Obligations rail section renders the list`)
  const rows = await page.locator('[data-testid^="obligation-"]').count()
  check(rows >= 1, `(5) ≥1 obligation row visible (got ${rows})`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/135-p51-obligations.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P5.1 obligations checks pass')
})().catch(e => { console.error(e); process.exit(1) })
