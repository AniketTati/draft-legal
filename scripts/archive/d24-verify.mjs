#!/usr/bin/env node
/**
 * D.2.4 verify — rail header attention pulse on hero submit.
 *
 *   (1) Idle rail header has data-attention="idle"
 *   (2) Hero submit triggers data-attention="pulse" + blue background
 *   (3) After ~1.4s the attention flag clears back to idle
 */
import { chromium } from 'playwright'

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

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
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  const header = page.getByTestId('side-agent-header')

  // (1) Idle
  const idleAttr = await header.getAttribute('data-attention')
  check(idleAttr === 'idle', `(1) header starts idle (got ${idleAttr})`)

  // (2) Hero submit → pulse
  await page.getByTestId('hero-agent-composer').fill('ping')
  await page.getByTestId('hero-agent-send').click()
  // Check within first 500ms while the flash is still active
  await page.waitForTimeout(200)
  const duringAttr = await header.getAttribute('data-attention')
  check(duringAttr === 'pulse', `(2) header is "pulse" during hero submit (got ${duringAttr})`)

  // (3) After ~1.4s, flag clears
  await page.waitForTimeout(1600)
  const afterAttr = await header.getAttribute('data-attention')
  check(afterAttr === 'idle', `(3) header returns to idle after ~1.4s (got ${afterAttr})`)

  // Wait for stream to complete so we don't leave it hanging
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 60_000 }
  )

  await page.evaluate(() => {
    localStorage.removeItem('feature:AGENT_SIDE_PANEL_V2')
    localStorage.removeItem('side-agent-rail:open')
  })
  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.2.4 attention-pulse checks pass')
})().catch(e => { console.error(e); process.exit(1) })
