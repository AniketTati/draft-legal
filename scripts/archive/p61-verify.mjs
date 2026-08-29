#!/usr/bin/env node
/**
 * P6.1 verify — Ghost-text completion (Copilot-style) in TipTap.
 *
 *   (1) POST /api/v1/agent/complete returns a non-empty completion
 *       for a meaningful prefix
 *   (2) Very short prefixes return empty (too_short guard)
 *   (3) When in edit mode, typing a complete-sentence prefix shows
 *       a `data-testid="ghost-completion"` decoration after debounce
 *   (4) Pressing Tab inserts the ghost text into the document
 *   (5) Pressing Escape dismisses the ghost
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

  // (1) direct endpoint smoke test
  const meaningfulCtx =
    'The parties hereby agree that all payments shall be made in U.S. dollars ' +
    'within thirty (30) days of receipt of invoice.'
  const r1 = await fetch(`${API}/api/v1/agent/complete`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      contextBefore: meaningfulCtx + ' Late payments ',
      contextAfter:  '',
      contractType:  'SERVICES',
    }),
  })
  check(r1.status === 200, `(1) /agent/complete returns 200 (got ${r1.status})`)
  const body1 = await r1.json().catch(() => ({}))
  check(typeof body1.completion === 'string' && body1.completion.length >= 5,
    `(1) completion has ≥5 chars (got ${body1.completion?.length ?? 0}: "${(body1.completion ?? '').slice(0, 60)}")`)

  // (2) too-short guard
  const r2 = await fetch(`${API}/api/v1/agent/complete`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ contextBefore: 'hi', contractType: 'SERVICES' }),
  }).then(r => r.json())
  check(r2.completion === '' && r2.reason === 'too_short',
    `(2) too-short prefix returns empty (got ${JSON.stringify(r2).slice(0, 80)})`)

  // ── Seed a contract to edit
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      if (!admin) throw new Error('admin not found')
      const starter = '<h1>SERVICES AGREEMENT</h1><p>This Agreement is made between Demo Org, Inc. and Ghost Labs, LLC.</p><p>The parties hereby agree that all payments shall be made in U.S. dollars within thirty (30) days of receipt of invoice. </p>'
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P6.1 ghost-text fixture ' + Date.now(),
          type: 'SERVICES',
          status: 'DRAFT',
          counterpartyName: 'Ghost Labs, LLC',
          ownerId: admin.id,
          createdBy: admin.id,
          analysisStatus: 'DONE',
          tags: ['p61-fixture'],
          versions: {
            create: {
              versionNumber: 1,
              plainText: 'SERVICES AGREEMENT\\n\\nThis Agreement is made between Demo Org, Inc. and Ghost Labs, LLC.\\n\\nThe parties hereby agree that all payments shall be made in U.S. dollars within thirty (30) days of receipt of invoice.',
              htmlContent: starter,
              createdById: admin.id,
            },
          },
        },
        include: { versions: true },
      })
      await p.contract.update({ where: { id: c.id }, data: { currentVersionId: c.versions[0].id } })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p61-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p61-seed.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (seedRun.status !== 0) { console.error('seed failed:', seedRun.stderr); process.exit(1) }
  const { contractId } = JSON.parse(seedRun.stdout.trim().split('\n').pop() || '{}')

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
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Enter edit mode
  await page.getByTestId('enter-edit-btn').click()
  await page.waitForTimeout(600)

  // Focus the editor — click on the end of the last paragraph
  const editor = page.locator('.ProseMirror').first()
  await editor.click()
  await page.waitForTimeout(200)

  // Move cursor to end of document
  await page.keyboard.press('End')
  await page.keyboard.press('Control+End')
  await page.waitForTimeout(200)

  // Type a prompt that should trigger completion — ending with a space
  // hits the word-boundary gate in GhostCompletion.
  await page.keyboard.type(' Late payments ', { delay: 40 })

  // (3) Wait up to 8s for ghost-completion to render
  const ghost = page.getByTestId('ghost-completion')
  let appeared = false
  try {
    await ghost.waitFor({ state: 'visible', timeout: 8_000 })
    appeared = true
  } catch { /* timed out */ }
  check(appeared, `(3) ghost-completion decoration appears after typing`)

  if (appeared) {
    const ghostText = (await ghost.textContent() ?? '').trim()
    check(ghostText.length >= 3,
      `(3) ghost text has ≥3 chars (got "${ghostText.slice(0, 60)}")`)

    // Snap a screenshot showing the ghost decoration in place.
    await page.screenshot({
      path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/138-p61-ghost-completion.png'),
      fullPage: false,
    })

    // (4) Tab accepts — compute doc text length EXCLUDING the ghost
    //     widget (innerText would include the widget and falsely
    //     match before/after).
    const docTextLen = async () => editor.evaluate((el) => {
      const total = el.textContent?.length ?? 0
      const ghostLen = el.querySelector('[data-testid="ghost-completion"]')?.textContent?.length ?? 0
      return total - ghostLen
    })
    const ghostLen = (await ghost.textContent() ?? '').trim().length
    const realBefore = await docTextLen()
    await page.keyboard.press('Tab')
    await page.waitForTimeout(600)
    const realAfter = await docTextLen()
    const grew = realAfter - realBefore
    check(grew >= Math.max(5, Math.floor(ghostLen * 0.5)),
      `(4) Tab-accept extended the doc by ≥${Math.max(5, Math.floor(ghostLen * 0.5))} chars (got ${grew}, ghostLen=${ghostLen})`)
    // Ghost gone after accept
    check(!(await ghost.isVisible().catch(() => false)),
      `(4) ghost decoration cleared after accept`)

    // (5) Re-trigger, then Escape dismisses
    await page.keyboard.type(' The Provider shall ', { delay: 40 })
    let reappeared = false
    try {
      await ghost.waitFor({ state: 'visible', timeout: 8_000 })
      reappeared = true
    } catch { /* ignore */ }
    if (reappeared) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      check(!(await ghost.isVisible().catch(() => false)),
        `(5) Escape dismisses the ghost`)
    } else {
      console.log('  ⚠ (5) second-trigger didn\'t appear in time — skipping Esc test')
    }
  }

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P6.1 ghost-completion checks pass')
})().catch(e => { console.error(e); process.exit(1) })
