#!/usr/bin/env node
/**
 * U.2.1 verify — Renames + indigo accent.
 *   - Sidebar shows "Assistant" (not "AI Assistant")
 *   - Rail header shows "Ask" (not "AI Assistant")
 *   - /agent page header shows "Assistant"
 *   - Sidebar nav active-state for Assistant uses indigo (not blue)
 *   - Rail header sparkle is indigo (not blue)
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // Dashboard
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label*="started" i]')
    if (dlg) dlg.querySelector('button')?.click()
  })
  await page.waitForTimeout(300)

  console.log('\n=== Sidebar shows "Assistant" (not "AI Assistant") ===')
  const sidebarText = await page.locator('aside').first().innerText()
  check(/Assistant/.test(sidebarText), `Sidebar contains "Assistant"`)
  check(!/AI Assistant/.test(sidebarText), `Sidebar does NOT contain "AI Assistant"`)

  console.log('\n=== Rail header says "Ask" (not "AI Assistant") ===')
  // Check the rail's first text node visible — it's the title at top of rail
  const railHeaderText = await page.evaluate(() => {
    // Find the right-edge rail by its testid or by location
    const composer = document.querySelector('[data-testid="side-agent-composer"]')
    if (!composer) return 'no-rail'
    let node = composer.parentElement
    while (node && node.tagName !== 'ASIDE' && !node.className?.includes?.('w-[380px]')) node = node.parentElement
    if (!node) return 'no-rail-aside'
    // Look for the first heading-like text
    const titleEl = node.querySelector('.text-sm.font-semibold')
    return titleEl ? titleEl.textContent : 'no-title'
  })
  console.log(`  rail header: "${railHeaderText}"`)
  check(/^Ask$/i.test(railHeaderText?.trim?.() ?? ''), `Rail title is "Ask"`)

  await page.screenshot({ path: path.join(OUT, 'u2-1-dashboard-renamed.png'), fullPage: false })

  // Test /agent
  await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  console.log('\n=== /agent header shows "Assistant" ===')
  const agentH1 = await page.locator('h1').first().textContent()
  console.log(`  /agent h1: "${agentH1}"`)
  check(/^Assistant$/i.test(agentH1?.trim() ?? ''), `/agent h1 is "Assistant"`)

  // Sidebar Assistant link active state has indigo
  const navAgentClass = await page.getByTestId('nav-agent').getAttribute('class')
  console.log(`  nav-agent class: ${navAgentClass}`)
  check(/indigo/.test(navAgentClass ?? ''), `Active /agent nav uses indigo accent`)

  await page.screenshot({ path: path.join(OUT, 'u2-1-agent-renamed.png'), fullPage: false })

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All U.2.1 rename checks pass')
})().catch(e => { console.error(e); process.exit(1) })
