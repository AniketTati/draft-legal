#!/usr/bin/env node
/**
 * P6.2 verify — Background clause classifier (margin badges).
 *
 *   (1) POST /api/v1/agent/classify-clause returns a recognised
 *       (category, position, reasoning) for a real clause
 *   (2) Short text returns position=skip (guard)
 *   (3) A contract with multi-clause content renders ≥1 margin badge
 *       (.clause-classifier-badge) on the canvas
 *   (4) Badge has data-position matching one of the 4 positions
 *   (5) Badge title attr contains reasoning (tooltip verification)
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

  // (1) Direct endpoint — an aggressive liability cap
  const r1 = await fetch(`${API}/api/v1/agent/classify-clause`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      clauseText:   'Customer waives any and all claims against Provider, including for gross negligence, willful misconduct, and fraud. Provider shall have no liability whatsoever under this Agreement, regardless of cause.',
      contractType: 'SERVICES',
      sectionHint:  'Limitation of Liability',
    }),
  })
  check(r1.status === 200, `(1) /classify-clause returns 200 (got ${r1.status})`)
  const b1 = await r1.json()
  check(['market', 'aggressive', 'weak', 'off', 'skip'].includes(b1.position),
    `(1) position is one of 5 enum values (got "${b1.position}")`)
  check(typeof b1.category === 'string' && b1.category.length > 0,
    `(1) category has value (got "${b1.category}")`)
  check(typeof b1.reasoning === 'string' && b1.reasoning.length > 5,
    `(1) reasoning has ≥5 chars (got ${b1.reasoning?.length}: "${(b1.reasoning ?? '').slice(0, 60)}")`)
  // This particular clause should come back non-market.
  check(b1.position !== 'market',
    `(1) blatant no-liability clause is NOT classified as market (got "${b1.position}")`)

  // (2) short text guard
  const r2 = await fetch(`${API}/api/v1/agent/classify-clause`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ clauseText: 'hello world' }),
  }).then(r => r.json())
  check(r2.position === 'skip', `(2) short text returns position=skip (got "${r2.position}")`)

  // ── Seed a contract with multiple meaningful paragraphs
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      if (!admin) throw new Error('admin not found')
      const html = \`<h1>SERVICES AGREEMENT</h1>
<h2>Section 1. Payment Terms</h2>
<p>Customer shall pay Provider a monthly fee of USD 250,000, payable within five (5) business days of invoice receipt. Late payments shall bear interest at one and one-half percent (1.5%) per month or the maximum rate permitted by law, whichever is less.</p>
<h2>Section 2. Limitation of Liability</h2>
<p>Customer hereby waives any and all claims against Provider, including for gross negligence, willful misconduct, and fraud. Provider's aggregate liability under this Agreement shall not exceed one hundred dollars (\$100) regardless of cause.</p>
<h2>Section 3. Term and Termination</h2>
<p>This Agreement commences on the Effective Date and continues for an initial term of three (3) years. Either party may terminate for material breach after thirty (30) days written notice and the opportunity to cure such breach.</p>
<h2>Section 4. Confidentiality</h2>
<p>Each party shall keep confidential all non-public information disclosed by the other party, using the same degree of care it uses to protect its own confidential information, but in no event less than reasonable care, for a period of five (5) years following disclosure.</p>\`
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim()
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P6.2 clause-classifier fixture ' + Date.now(),
          type: 'SERVICES',
          status: 'DRAFT',
          counterpartyName: 'Badge Co., Inc.',
          ownerId: admin.id,
          createdBy: admin.id,
          analysisStatus: 'DONE',
          tags: ['p62-fixture'],
          versions: { create: { versionNumber: 1, plainText: plain, htmlContent: html, createdById: admin.id } },
        },
        include: { versions: true },
      })
      await p.contract.update({ where: { id: c.id }, data: { currentVersionId: c.versions[0].id } })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p62-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p62-seed.ts'], {
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
  await page.waitForTimeout(1500)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // (3) Wait for the classifier to scan + render badges. Budget is
  //     12 paragraphs, debounce 1500ms, 4 real clauses here → ~4 API
  //     round-trips at ~600ms each. Total ~5-8s in the worst case.
  const badge = page.locator('.clause-classifier-badge').first()
  let appeared = false
  try {
    await badge.waitFor({ state: 'attached', timeout: 25_000 })
    appeared = true
  } catch { /* timed out */ }
  check(appeared, `(3) ≥1 margin badge appears on multi-clause document`)

  if (appeared) {
    const count = await page.locator('.clause-classifier-badge').count()
    check(count >= 1, `(3) badge count ≥1 (got ${count})`)

    // (4) data-position attr
    const pos = await badge.getAttribute('data-position')
    check(['market', 'aggressive', 'weak', 'off'].includes(pos ?? ''),
      `(4) first badge data-position is recognised (got "${pos}")`)

    // (5) title contains something
    const title = await badge.getAttribute('title')
    check(title !== null && title.length > 10,
      `(5) tooltip has substantive content (got ${title?.length ?? 0} chars)`)

    await page.screenshot({
      path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/139-p62-clause-badges.png'),
      fullPage: false,
    })
  }

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P6.2 clause-classifier checks pass')
})().catch(e => { console.error(e); process.exit(1) })
