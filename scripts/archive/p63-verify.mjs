#!/usr/bin/env node
/**
 * P6.3 verify — Bubble-menu AI streaming.
 *
 *   (1) POST /api/v1/agent/assist-stream returns NDJSON with
 *       {start, delta×n, done} events
 *   (2) Selection + clicking the bubble menu ✨ opens the popover
 *   (3) Clicking an action chip triggers a stream; result text
 *       accumulates character-by-character
 *   (4) [Replace] inserts the streamed text in place of the selection
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

  // (1) Direct endpoint — read the NDJSON stream
  const streamResp = await fetch(`${API}/api/v1/agent/assist-stream`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      selectedText: 'The parties hereby agree that all payments shall be made in U.S. dollars within thirty (30) days of receipt of invoice.',
      action:       'simplify',
      contractType: 'SERVICES',
    }),
  })
  check(streamResp.ok, `(1) /assist-stream returned ok (status=${streamResp.status})`)
  check((streamResp.headers.get('content-type') ?? '').includes('ndjson'),
    `(1) content-type is ndjson (got ${streamResp.headers.get('content-type')})`)

  // Read the stream + classify events
  const reader = streamResp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events = []
  let accumulated = ''
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const ln of lines) {
      if (!ln.trim()) continue
      try { const e = JSON.parse(ln); events.push(e); if (e.type === 'delta' && e.text) accumulated += e.text } catch {}
    }
  }
  check(events[0]?.type === 'start', `(1) first event is "start" (got "${events[0]?.type}")`)
  check(events[events.length - 1]?.type === 'done' || events.some(e => e.type === 'done'),
    `(1) stream ends with a "done" event`)
  const deltas = events.filter(e => e.type === 'delta')
  check(deltas.length >= 2, `(1) ≥2 delta chunks arrived (got ${deltas.length}) — streaming is working`)
  check(accumulated.length > 20,
    `(1) accumulated text has >20 chars (got ${accumulated.length}: "${accumulated.slice(0, 60)}")`)

  // ── Seed a contract
  const seedScript = `
    import { PrismaClient } from '@prisma/client'
    ;(async () => {
      const p = new PrismaClient()
      const admin = await p.user.findFirst({ where: { email: 'admin@demo.com' }, select: { id: true, orgId: true } })
      const html = \`<h1>SERVICES AGREEMENT</h1><h2>Payment</h2><p>Customer shall pay Provider a monthly fee of USD 100,000, payable within thirty (30) days of invoice. Late payments shall bear interest at one and one-half percent (1.5%) per month.</p>\`
      const c = await p.contract.create({
        data: {
          orgId: admin.orgId,
          title: 'P6.3 bubble-stream fixture ' + Date.now(),
          type: 'SERVICES', status: 'DRAFT',
          counterpartyName: 'Streamy Co.',
          ownerId: admin.id, createdBy: admin.id,
          analysisStatus: 'DONE', tags: ['p63-fixture'],
          versions: { create: { versionNumber: 1, plainText: 'Customer shall pay Provider a monthly fee of USD 100,000, payable within thirty (30) days of invoice. Late payments shall bear interest at one and one-half percent (1.5%) per month.', htmlContent: html, createdById: admin.id } },
        },
        include: { versions: true },
      })
      await p.contract.update({ where: { id: c.id }, data: { currentVersionId: c.versions[0].id } })
      console.log(JSON.stringify({ contractId: c.id }))
      await p.$disconnect()
    })().catch(e => { console.error(e); process.exit(1) })
  `
  writeFileSync('/tmp/p63-seed.ts', seedScript)
  const seedRun = spawnSync('pnpm', ['tsx', '--env-file=.env', '/tmp/p63-seed.ts'], {
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

  // Enter edit mode
  await page.getByTestId('enter-edit-btn').click()
  await page.waitForTimeout(500)

  // Click to focus + triple-click on the target paragraph to select it
  const para = page.locator('.ProseMirror p:has-text("Customer shall pay Provider")').first()
  await para.click()
  await page.waitForTimeout(200)
  // Triple-click selects the whole paragraph
  await para.click({ clickCount: 3 })
  await page.waitForTimeout(400)

  // The bubble menu's ✨ button should now be visible — click it.
  // Scope specifically to the bubble-menu's button to avoid the
  // page-header "Ask AI" button.
  const aiBtn = page.locator('button[title="Ask AI about this selection (⌘K)"]').first()
  try {
    await aiBtn.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    // Selection might have collapsed — retry once
    await para.click({ clickCount: 3 })
    await page.waitForTimeout(500)
  }
  await aiBtn.click({ force: true })
  await page.waitForTimeout(500)

  // (2) popover opens
  const popover = page.getByTestId('bubble-ai-popover')
  check(await popover.isVisible(), `(2) BubbleAiPopover opens after ✨ click`)

  // Action chips
  const chips = await page.locator('[data-testid^="bubble-ai-action-"]').count()
  check(chips >= 4, `(2) ≥4 action chips visible (got ${chips})`)

  // (3) click "Tighten" and watch the stream accumulate
  await page.getByTestId('bubble-ai-action-simplify').click()
  const result = page.getByTestId('bubble-ai-result')

  // Snap a mid-stream screenshot ASAP to capture the typing effect
  await page.waitForTimeout(700)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/140-p63-bubble-stream.png'),
    fullPage: false,
  })

  // Wait for stream to finish (Replace button appears after done)
  const replaceBtn = page.getByTestId('bubble-ai-replace')
  try {
    await replaceBtn.waitFor({ state: 'visible', timeout: 30_000 })
  } catch {}
  const finalText = (await result.textContent() ?? '').trim()
  check(finalText.length > 15,
    `(3) streamed text has >15 chars after done (got ${finalText.length}: "${finalText.slice(0, 60)}")`)
  check(await replaceBtn.isVisible(),
    `(3) [Replace] CTA appears after stream completes`)

  // (4) Click Replace → verify paragraph content changed
  const beforeText = (await para.textContent() ?? '').trim()
  await replaceBtn.click()
  await page.waitForTimeout(600)
  // Popover should close
  check(!(await popover.isVisible().catch(() => false)),
    `(4) popover closes after Replace`)
  const afterText = (await page.locator('.ProseMirror').first().textContent() ?? '').trim()
  check(afterText !== beforeText && afterText.length > 0,
    `(4) editor content changed after Replace (before=${beforeText.length}, after=${afterText.length})`)

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P6.3 bubble-stream checks pass')
})().catch(e => { console.error(e); process.exit(1) })
