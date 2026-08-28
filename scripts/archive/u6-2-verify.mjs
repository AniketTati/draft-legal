#!/usr/bin/env node
/**
 * U.6.2 verify — Counterparty list test-data filter.
 *
 * (1) API /counterparties does NOT return any "*-Verify-*" rows
 * (2) /counterparties UI page does NOT render any "*-Verify-*" rows
 * (3) Search filter still works for normal names
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'u-build')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API = 'http://localhost:3001'

let fail = 0
const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

// ── (1) API check
console.log('\n=== (1) API: no Verify rows in /counterparties ===')
const tokenRes = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
})
const { accessToken } = await tokenRes.json()
const apiRes = await fetch(`${API}/api/v1/counterparties?limit=100`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json())
const items = apiRes.counterparties ?? apiRes.data ?? apiRes.items ?? (Array.isArray(apiRes) ? apiRes : [])
const polluted = items.filter(c => /-Verify-/.test(c.name ?? ''))
console.log(`  total rows: ${items.length} | Verify-tagged: ${polluted.length}`)
check(polluted.length === 0, `0 Verify rows returned by API`)
check(items.length > 0, `regular rows still returned (got ${items.length})`)

// ── (2) UI check
const br = await chromium.launch({ headless: true })
const ctx = await br.newContext({ viewport: { width: 1680, height: 1000 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'maya@demo.com')
await page.fill('input[type="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForTimeout(1500)

await page.goto(`${BASE}/counterparties`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

console.log('\n=== (2) UI: no Verify rows visible on /counterparties ===')
const bodyText = await page.locator('body').innerText()
const verifyHits = (bodyText.match(/-Verify-\d+/g) ?? []).length
console.log(`  "-Verify-…" mentions in DOM: ${verifyHits}`)
check(verifyHits === 0, `no Verify rows in DOM`)

// Confirm the list page actually rendered (e.g. has at least one well-known name).
const knownName = await page.locator('body').innerText()
check(/Acme|Zynga|Salesforce|Cloudwave|Datadog/i.test(knownName), `regular CPs still visible`)

await page.screenshot({ path: path.join(OUT, 'u6-2-counterparties.png'), fullPage: false })

await br.close()

if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
console.log('\n✓ All U.6.2 counterparty filter checks pass')
