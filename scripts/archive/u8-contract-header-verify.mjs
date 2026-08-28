#!/usr/bin/env node
/**
 * U.8 — contract header layout invariants.
 *
 * The wireframe redo (single meta row + flex-1 title) must hold at both
 * rail states. This script verifies:
 *
 *  (A) Rail collapsed (≈1408px main):
 *      - Title is NOT truncated (full text fits on one line)
 *      - Action buttons cluster flush right (≤30px trailing pad)
 *      - Owner + Edited chips are visible (xl breakpoint active)
 *      - Old middle-column "contract-meta-strip" is GONE
 *
 *  (B) Rail expanded (≈1020px main):
 *      - Buttons still flush right
 *      - Title may truncate (less width) — that's fine, just no overflow
 *      - Layout doesn't break; no horizontal scrollbar on the page
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

const br = await chromium.launch({ headless: true })

async function open(page, contractId) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
}

async function setRail(page, state) {
  const cur = await page.locator('[data-testid="side-agent-rail"]').getAttribute('data-state')
  if (state === 'collapsed' && cur === 'expanded') {
    await page.locator('[data-testid="side-agent-rail"] button:has(svg.lucide-chevron-right)').first().click()
    await page.waitForTimeout(400)
  } else if (state === 'expanded' && cur === 'collapsed') {
    await page.locator('[data-testid="side-agent-rail"]').click()
    await page.waitForTimeout(400)
  }
}

// Pick a contract with a long title to exercise truncation
const tokenRes = await fetch('http://localhost:3001/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
})
const { accessToken } = await tokenRes.json()
const cs = await fetch('http://localhost:3001/api/v1/contracts?limit=20', {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
const contracts = cs.contracts ?? cs.data ?? []
const ct = contracts.find(c => /amendment.*zynga/i.test(c.title)) ?? contracts.find(c => c.title.length > 40) ?? contracts[0]
console.log(`\nContract: "${ct.title}" (${ct.title.length} chars)`)

// ── (A) Rail collapsed
{
  console.log('\n=== A · Rail collapsed (wide main) ===')
  const ctx = await br.newContext({ viewport: { width: 1680, height: 900 } })
  const page = await ctx.newPage()
  await open(page, ct.id)
  await setRail(page, 'collapsed')

  const layout = await page.evaluate(() => {
    const header = document.querySelector('main .bg-white.border-b')
    if (!header) return null
    const headerRect = header.getBoundingClientRect()
    const titleEl = header.querySelector('h1')
    const titleRect = titleEl?.getBoundingClientRect()
    const titleScrollWidth = titleEl?.scrollWidth ?? 0
    const titleClientWidth = titleEl?.clientWidth ?? 0
    const buttonsRow = header.querySelector('.flex.items-center.gap-2.flex-shrink-0')
    const btnRect = buttonsRow?.getBoundingClientRect()
    const oldStrip = header.querySelector('[data-testid="contract-meta-strip"]')
    const ownerChip = header.querySelector('[data-testid="contract-owner-chip"]')
    return {
      headerWidth: headerRect.width,
      titleClientWidth,
      titleScrollWidth,
      titleEllipsised: titleScrollWidth > titleClientWidth + 1,
      buttonsRight: btnRect?.right,
      headerRight: headerRect.right,
      rightTrailing: headerRect.right - (btnRect?.right ?? headerRect.right),
      hasOldMetaStrip: !!oldStrip,
      hasOwnerChip: !!ownerChip,
      ownerChipVisible: ownerChip ? getComputedStyle(ownerChip).display !== 'none' : false,
    }
  })
  console.log('  ', JSON.stringify(layout))

  check(!layout.hasOldMetaStrip, `old middle-column strip removed`)
  check(!layout.titleEllipsised, `title NOT clipped at wide main (room available)`)
  check(layout.rightTrailing <= 30, `buttons flush right (≤30px trailing, got ${layout.rightTrailing}px)`)
  check(layout.ownerChipVisible, `owner chip visible at xl viewport`)

  await page.screenshot({ path: path.join(OUT, 'u8-header-collapsed.png'), fullPage: false, clip: { x: 0, y: 0, width: 1680, height: 240 } })
  await ctx.close()
}

// ── (B) Rail expanded
{
  console.log('\n=== B · Rail expanded (narrow main) ===')
  const ctx = await br.newContext({ viewport: { width: 1680, height: 900 } })
  const page = await ctx.newPage()
  await open(page, ct.id)
  await setRail(page, 'expanded')

  const layout = await page.evaluate(() => {
    const header = document.querySelector('main .bg-white.border-b')
    if (!header) return null
    const headerRect = header.getBoundingClientRect()
    const buttonsRow = header.querySelector('.flex.items-center.gap-2.flex-shrink-0')
    const btnRect = buttonsRow?.getBoundingClientRect()
    const docHasHScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth
    return {
      headerWidth: headerRect.width,
      rightTrailing: headerRect.right - (btnRect?.right ?? headerRect.right),
      docHasHScroll,
    }
  })
  console.log('  ', JSON.stringify(layout))

  check(layout.headerWidth < 1100, `header is narrower (rail eating space): ${layout.headerWidth}px`)
  check(layout.rightTrailing <= 30, `buttons still flush right (got ${layout.rightTrailing}px)`)
  check(!layout.docHasHScroll, `no horizontal scrollbar on the page`)

  await page.screenshot({ path: path.join(OUT, 'u8-header-expanded.png'), fullPage: false, clip: { x: 0, y: 0, width: 1680, height: 240 } })
  await ctx.close()
}

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ U.8 contract-header layout invariants pass')
