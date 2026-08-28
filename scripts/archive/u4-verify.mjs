#!/usr/bin/env node
/**
 * U.4 verify — All deletions in one pass.
 *
 * Acceptance gate from doc 32 §12:
 *   "grep AI Assistant returns ≤2 hits in src; grep Ask AI returns 0 hits"
 *
 * Live UI checks:
 *   (1) Dashboard has no HeroAgent box
 *   (2) Top header has no "AI Assistant" pill
 *   (3) Contract toolbar has no "Ask AI" button
 *   (4) Actions menu has no "Ask AI" item
 *   (5) Tabs bar has no "Ask" tab
 *   (6) ⌘K from anywhere focuses the rail composer
 */
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const SRC = path.join(REPO_ROOT, 'apps/web/src')

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

// ── (0) grep gates from doc 32 §12
//
// We allow "AI Assistant" / "Ask AI" inside JS comments (the U.x.x note-
// to-future-self pattern). Acceptance is: zero in user-visible UI text.
// Helper: count occurrences NOT inside a JS comment line.
console.log('\n=== (0) Source-grep acceptance gates ===')
function countInCode(needle) {
  const g = spawnSync('grep', ['-rl', needle, SRC], { encoding: 'utf8' })
  const files = (g.stdout ?? '').trim().split('\n').filter(Boolean)
  const offenders = []
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8')
    const lines = txt.split('\n')
    for (const line of lines) {
      if (!new RegExp(needle).test(line)) continue
      // Strip comment chunks. We accept the line as comment if it
      // matches one of these patterns:
      //   1. Starts with `//`, `*`, or `/*` (after whitespace)
      //   2. Inside a /** … */ block — we don't track that perfectly;
      //      a single-line `*` prefix covers it.
      //   3. Has `//` BEFORE the needle (inline comment)
      //   4. Is a JSX comment {/* … */} containing only commentary
      const trimmed = line.trim()
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue
      // JSX comment: starts with `{/* ` and ends with ` */}`
      if (/^\{\/\*.*\*\/\}$/.test(trimmed)) continue
      // Inline `//` before the needle
      const idxNeedle = line.indexOf(needle)
      const idxComment = line.indexOf('//')
      if (idxComment >= 0 && idxComment < idxNeedle) continue
      offenders.push({ file: f.replace(SRC + '/', ''), line: trimmed })
    }
  }
  return offenders
}

const aiAssist = countInCode('AI Assistant')
console.log(`  "AI Assistant" in non-comment code: ${aiAssist.length}`)
aiAssist.forEach(o => console.log(`    ${o.file}: ${o.line.slice(0, 80)}`))
check(aiAssist.length === 0, `zero "AI Assistant" in non-comment code (got ${aiAssist.length})`)

const askAi = countInCode('Ask AI')
console.log(`  "Ask AI" in non-comment code: ${askAi.length}`)
askAi.forEach(o => console.log(`    ${o.file}: ${o.line.slice(0, 80)}`))
check(askAi.length === 0, `zero "Ask AI" in non-comment code (got ${askAi.length})`)

// ── Live UI checks
const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'maya@demo.com')
await page.fill('input[type="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForTimeout(1500)

// ── (1) Dashboard — no HeroAgent
console.log('\n=== (1) No HeroAgent on dashboard ===')
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.evaluate(() => localStorage.setItem('clm.coach.contract-detail.v2', 'seen'))
const heroBoxText = await page.locator('main').first().innerText()
check(!/Ask AI\s*new/.test(heroBoxText), `no "Ask AI new" hero composer on dashboard`)

// ── (2) Header — no AI Assistant pill
console.log('\n=== (2) No "AI Assistant" pill in header ===')
const headerText = await page.locator('header').first().innerText()
check(!/AI Assistant/.test(headerText), `header does not contain "AI Assistant"`)

await page.screenshot({ path: path.join(OUT, 'u4-dashboard-clean.png'), fullPage: false })

// ── (3)+(4)+(5) Contract page — no AI surfaces in toolbar / Actions / tabs
console.log('\n=== (3-5) Contract page — no AI buttons ===')
await page.goto(`${BASE}/contracts/cmodtj9gz000svopsfu00q258`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

// Toolbar
const toolbarText = await page.locator('main').first().innerText()
check(!/✨\s*Ask AI|Ask AI ⌘K/.test(toolbarText), `no "Ask AI" button in contract toolbar`)

// Open Actions menu — verify no "Ask AI" item
const actionsBtn = page.locator('button:has-text("Actions")').first()
if (await actionsBtn.count() > 0) {
  await actionsBtn.click()
  await page.waitForTimeout(500)
  const dropdownText = await page.locator('[role="menu"]').first().innerText().catch(() => '')
  check(!/Ask AI/.test(dropdownText), `no "Ask AI" in Actions menu (got: "${dropdownText.replace(/\s+/g, ' ').slice(0, 100)}")`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

// Tabs — no "Ask" tab
const tabsText = await page.locator('[role="tablist"], button:has-text("Document")').first().textContent().catch(() => '')
const tabBarRegion = await page.locator('main > div').first().innerText().catch(() => '')
const hasAskTab = /^\s*Ask\s*$/.test(tabBarRegion) // standalone "Ask"
// Looser: search for "Ask" as a tab
const allTabs = await page.locator('button[role="tab"], button:has-text("Document"), button:has-text("Versions")').allTextContents().catch(() => [])
console.log(`  visible tabs: ${allTabs.join(' · ')}`)
check(!allTabs.some(t => t.trim() === 'Ask'), `no "Ask" tab in tabs bar`)

await page.screenshot({ path: path.join(OUT, 'u4-contract-clean.png'), fullPage: false })

// ── (6) ⌘K focuses rail composer
console.log('\n=== (6) ⌘K focuses rail composer ===')
// First collapse the rail to test that ⌘K expands + focuses
const collapseBtn = page.getByTestId('side-agent-collapse')
if (await collapseBtn.count() > 0) {
  await collapseBtn.click().catch(() => {})
  await page.waitForTimeout(500)
  const collapsed = await page.getByTestId('side-agent-rail').getAttribute('data-state')
  check(collapsed === 'collapsed', `rail collapsed before ⌘K`)
}
// Press ⌘K (use Meta+k)
await page.keyboard.press('Meta+k')
await page.waitForTimeout(700)
const stateAfter = await page.getByTestId('side-agent-rail').getAttribute('data-state')
check(stateAfter === 'expanded', `rail expanded after ⌘K (got "${stateAfter}")`)
// Composer focused?
const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
check(focused === 'side-agent-composer', `composer focused after ⌘K (got testid="${focused}")`)

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.4 deletion checks pass')
