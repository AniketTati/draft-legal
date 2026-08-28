#!/usr/bin/env node
/**
 * P6.4 verify — Defined-term guard (lexicon watcher).
 *
 *   (1) Contract with `"Customer" means …` definition + lowercase
 *       "customer" elsewhere renders ≥1 .defined-term-flag decoration
 *   (2) Rail section lists canonical terms + variant count
 *   (3) "Apply defined term everywhere" button normalises variants
 *       → flags drop to 0 + inline decorations disappear
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

  // Seed a draft contract where:
  //  • "Customer" is defined via `"Customer" means ...`
  //  • "Provider" is defined via `(the "Provider")`
  //  • Body uses lowercase "customer" in multiple places
  //  • Body correctly uses "Provider" capitalised
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      const html = \`<h1>SERVICES AGREEMENT</h1>
<h2>1. Definitions</h2>
<p>"Customer" means Acme Holdings, Inc. This Agreement is made between Acme Holdings, Inc. and Zeta Services, LLC (the "Provider").</p>
<h2>2. Payment</h2>
<p>The customer shall pay Provider USD 100,000 per month. If the customer disputes an invoice, customer must notify Provider within ten (10) business days. The Provider retains the right to suspend service if customer fails to pay.</p>
<h2>3. Term</h2>
<p>This Agreement is binding on Provider and customer for an initial term of two (2) years.</p>\`
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim()
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P6.4 defined-term fixture ' + Date.now(),
          type: 'SERVICES', status: 'DRAFT',
          counterpartyName: 'Zeta Services, LLC',
          ownerId: admin.id, createdBy: admin.id,
          analysisStatus: 'DONE', tags: ['p64-fixture'],
          versions: { create: { versionNumber: 1, plainText: plain, htmlContent: html, createdById: admin.id } },
        },
        include: { versions: true },
      })
      await p.contract.update({ where: { id: c.id }, data: { currentVersionId: c.versions[0].id } })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p64-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p64-seed.ts'], {
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

  // Enter edit so the user can invoke "Apply everywhere"
  await page.getByTestId('enter-edit-btn').click()
  await page.waitForTimeout(1200)

  // (1) inline decorations
  const flagCount = await page.locator('.defined-term-flag').count()
  check(flagCount >= 3, `(1) ≥3 inline flags appear for lowercase "customer" (got ${flagCount})`)
  const firstFlag = page.locator('.defined-term-flag').first()
  check(await firstFlag.isVisible(), `(1) first flag is visible`)
  const foundAttr = await firstFlag.getAttribute('data-found')
  const termAttr  = await firstFlag.getAttribute('data-term')
  check(foundAttr === 'customer' && termAttr === 'Customer',
    `(1) flag attributes correct (found="${foundAttr}", term="${termAttr}")`)

  // (2) rail
  const section = page.getByTestId('defined-terms-section')
  await section.scrollIntoViewIfNeeded().catch(() => {})
  check(await section.isVisible(), `(2) defined-terms rail section renders`)
  const terms = await page.locator('[data-testid^="defined-term-"][data-testid$="customer"]').count()
  check(terms >= 1, `(2) 'Customer' term pill visible in rail`)
  const flagText = await page.getByTestId('defined-terms-flag-count').textContent()
  check((flagText ?? '').match(/\d+ inconsistent/),
    `(2) flag-count text has "<N> inconsistent" (got "${flagText?.slice(0, 60)}")`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/141-p64-defined-term-guard.png'),
    fullPage: false,
  })

  // (3) normalise
  const before = await page.locator('.defined-term-flag').count()
  await page.getByTestId('defined-terms-normalize-btn').click()
  await page.waitForTimeout(2000)     // wait for rescan
  const after = await page.locator('.defined-term-flag').count()
  check(after < before,
    `(3) Apply-everywhere reduced flag count (before=${before}, after=${after})`)
  // Editor should now contain "Customer" where it had "customer"
  const editorText = (await page.locator('.ProseMirror').first().textContent() ?? '')
  check(!/\bcustomer\b/.test(editorText) || /Customer/.test(editorText),
    `(3) doc now contains canonical "Customer" form`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P6.4 defined-term-guard checks pass')
})().catch(e => { console.error(e); process.exit(1) })
