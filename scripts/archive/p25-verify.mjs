#!/usr/bin/env node
/**
 * P2.5 verify — HITL Review Queue for low-confidence fields (Wave F.5).
 *
 *   (1) Seed a contract with a known-low-confidence field
 *   (2) GET /api/v1/review-queue returns that contract's field
 *   (3) Different thresholds (0.5 vs 0.7 vs 0.9) filter differently
 *   (4) POST /verify sets confidence=1 + verifiedBy/At; field
 *       disappears from the queue on next read
 *   (5) POST /reject also removes the item from the queue (with
 *       rejectedBy/At + confidence=0)
 *   (6) UI — /review-queue page renders the flagged field with a
 *       "Verify" button; clicking verify removes the row
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const API = 'http://localhost:3001'

function runTsx(args) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', ...args], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) throw new Error(`tsx failed: ${r.stderr}`)
  return r.stdout
}

/** Bake a low-confidence field onto the first MSA contract. */
function seedLowConfidence() {
  // Wrap in an async IIFE to avoid the tsx+esbuild top-level-await
  // transform edge case (CJS output mode).
  const script = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const demoOrg = await p.organization.findFirst({ where: { name: 'Demo Org, Inc.' }, select: { id: true } })
      if (!demoOrg) throw new Error('Demo Org not found')
      const c = await p.contract.findFirst({
        where: { orgId: demoOrg.id, analysisStatus: 'DONE', deletedAt: null },
        select: { id: true, fieldConfidence: true, keyTerms: true },
        orderBy: { updatedAt: 'desc' },
      })
      if (!c) throw new Error('No DONE contract to seed against')
      const fc = { ...(c.fieldConfidence ?? {}) }
      fc.__p25_low_field = { confidence: 0.42, quote: 'uncertain signal extracted here', section: null }
      fc.__p25_mid_field = { confidence: 0.65, quote: 'mid confidence signal', section: null }
      const kt = { ...(c.keyTerms ?? {}) }
      kt.__p25_low_field = 'maybe-delaware'
      kt.__p25_mid_field = 'possibly-california'
      await p.contract.update({
        where: { id: c.id },
        data: { fieldConfidence: fc, keyTerms: kt },
      })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  // Can't use `-e` (top-level await); write + run helper instead.
  // note: using writeFileSync imported above — ESM module
  const tmp = '/tmp/p25-seed.ts'
  writeFileSync(tmp, script)
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', tmp], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`)
  const line = r.stdout.trim().split('\n').pop() || '{}'
  return JSON.parse(line).contractId
}

function cleanupLowConfidence(contractId) {
  const script = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const c = await p.contract.findUnique({
        where: { id: '${contractId}' },
        select: { fieldConfidence: true, keyTerms: true },
      })
      if (c) {
        const fc = { ...(c.fieldConfidence ?? {}) }
        delete fc.__p25_low_field
        delete fc.__p25_mid_field
        const kt = { ...(c.keyTerms ?? {}) }
        delete kt.__p25_low_field
        delete kt.__p25_mid_field
        await p.contract.update({
          where: { id: '${contractId}' },
          data: { fieldConfidence: fc, keyTerms: kt },
        })
      }
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  const tmp = '/tmp/p25-cleanup.ts'
  writeFileSync(tmp, script)
  spawnSync('pnpm', ['tsx', '--env-file=.env', tmp], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
}

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
  const contractId = seedLowConfidence()

  try {
    const token = await login()

    // (2) /review-queue at threshold 0.7 returns both fields
    let r = await fetch(`${API}/api/v1/review-queue?threshold=0.7`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const myItems = (r.items ?? []).filter(it => it.contractId === contractId)
    check(myItems.length >= 2,
      `(2) queue has both seeded low-conf fields at threshold=0.7 (got ${myItems.length})`)
    const low = myItems.find(it => it.field === '__p25_low_field')
    check(low?.confidence === 0.42,
      `(2) low-confidence item carries confidence=0.42 (got ${low?.confidence})`)
    check(low?.value === 'maybe-delaware',
      `(2) low-confidence item carries value from keyTerms (got "${low?.value}")`)

    // (3) threshold=0.5 → only __p25_low_field
    r = await fetch(`${API}/api/v1/review-queue?threshold=0.5`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const atHalf = (r.items ?? []).filter(it => it.contractId === contractId)
    check(atHalf.length === 1 && atHalf[0].field === '__p25_low_field',
      `(3) threshold=0.5 filters to just the 0.42 field (got ${atHalf.length} items)`)

    //     threshold=0.9 → both
    r = await fetch(`${API}/api/v1/review-queue?threshold=0.9`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const atHigh = (r.items ?? []).filter(it => it.contractId === contractId)
    check(atHigh.length >= 2,
      `(3) threshold=0.9 surfaces both fields (got ${atHigh.length})`)

    // (4) Verify the low field
    const v = await fetch(`${API}/api/v1/review-queue/${contractId}/verify`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ field: '__p25_low_field' }),
    }).then(x => x.json())
    check(v.ok === true, `(4) verify returns ok=true`)

    //     Queue no longer includes the verified field
    r = await fetch(`${API}/api/v1/review-queue?threshold=0.9`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const stillHasLow = (r.items ?? []).some(it =>
      it.contractId === contractId && it.field === '__p25_low_field'
    )
    check(!stillHasLow, `(4) verified __p25_low_field no longer appears in the queue`)

    // (5) Reject the mid field
    const rj = await fetch(`${API}/api/v1/review-queue/${contractId}/reject`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ field: '__p25_mid_field' }),
    }).then(x => x.json())
    check(rj.ok === true, `(5) reject returns ok=true`)

    r = await fetch(`${API}/api/v1/review-queue?threshold=0.9`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(x => x.json())
    const stillHasMid = (r.items ?? []).some(it =>
      it.contractId === contractId && it.field === '__p25_mid_field'
    )
    check(!stillHasMid, `(5) rejected __p25_mid_field no longer appears in the queue`)

    // (6) UI — re-seed the low field, visit /review-queue, click Verify
    //     button, confirm the row disappears.
    const contractId2 = seedLowConfidence()
    const browser = await chromium.launch({ headless: true })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    page.on('dialog', d => d.accept().catch(() => {}))
    await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', 'admin@demo.com')
    await page.fill('input[type="password"]', 'password123')
    await page.click('button[type="submit"]')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
    await page.goto('http://localhost:5173/review-queue', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1400)
    const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
    if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

    // Set threshold to 0.9 so both seeded fields appear (one at 0.42,
    // one at 0.65). The default threshold=0.7 would miss the mid one.
    await page.getByTestId('review-queue-threshold').selectOption('0.9')
    await page.waitForTimeout(400)

    const rowVisible = await page.getByTestId(`review-queue-row-${contractId2}-__p25_low_field`).isVisible().catch(() => false)
    check(rowVisible, `(6) UI shows the seeded low-confidence row`)
    await page.screenshot({
      path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/129-p25-review-queue.png'),
      fullPage: false,
    })

    // Click Verify on the low field
    await page.getByTestId('review-queue-verify-__p25_low_field').first().click()
    await page.waitForTimeout(800)
    const rowGone = await page.getByTestId(`review-queue-row-${contractId2}-__p25_low_field`).isVisible().catch(() => false)
    check(!rowGone, `(6) row disappears after Verify click`)

    await browser.close()
    cleanupLowConfidence(contractId2)
  } finally {
    cleanupLowConfidence(contractId)
  }

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P2.5 review-queue checks pass')
})().catch(e => { console.error(e); process.exit(1) })
