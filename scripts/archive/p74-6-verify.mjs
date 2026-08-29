#!/usr/bin/env node
/**
 * P7.4.6 verify — Counterparty list "Last activity" tied to real signals (F-50).
 *
 * Before: lastActivity = MAX(contract.updatedAt) — every row read
 * "today" because the seed touches every contract on the same date.
 *
 * After: lastActivity = MAX(contract.updatedAt, comment.createdAt,
 * shareLink.createdAt). The UI also shows a small "comment" / "share
 * link" / "contract" tag below the timestamp so the user knows what
 * KIND of activity drove the value.
 *
 * Checks:
 *   (1) /counterparties API returns lastActivityKind for each row
 *   (2) UI renders the kind tag in the Last activity column
 *   (3) Adding a comment to a contract bumps lastActivity to "comment"
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'
const API  = 'http://localhost:3001/api/v1'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // ── (1) Hit the API directly + assert lastActivityKind shape
  console.log('\n=== (1) API returns lastActivityKind ===')
  const tokenRes = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()
  const cpsRes = await fetch(`${API}/counterparties`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const cps = (await cpsRes.json()).data
  check(Array.isArray(cps) && cps.length > 0, `≥1 counterparty (got ${cps.length})`)
  const sample = cps.find(c => (c.contractCount ?? 0) > 0)
  check(sample && 'lastActivityKind' in sample, `row has lastActivityKind field`)
  console.log(`  sample: ${sample.name} → kind=${sample.lastActivityKind}`)

  // ── (2) UI shows the kind tag
  console.log('\n=== (2) UI renders the kind tag ===')
  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  await page.goto(`${BASE}/counterparties`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // Look for the small kind tag inside any counterparty row
  const tagsRendered = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="counterparty-row-"]'))
    let withTag = 0
    for (const r of rows) {
      // Look for "comment" / "share link" / "contract" small caps text
      const txt = r.textContent || ''
      if (/contract|comment|share link/i.test(txt) && r.querySelector('.uppercase')) withTag++
    }
    return { total: rows.length, withTag }
  })
  console.log(`  rows: ${tagsRendered.total}, with kind tag: ${tagsRendered.withTag}`)
  check(tagsRendered.withTag >= 1, `≥1 row shows a kind tag`)

  await page.screenshot({ path: path.join(OUT, '216-p74-6-cp-list-activity.png'), fullPage: false })

  // ── (3) Add a comment → lastActivityKind becomes "comment"
  console.log('\n=== (3) Adding a comment changes the kind to "comment" ===')
  // Find Zynga's contract id
  const zynga = cps.find(c => /zynga/i.test(c.name))
  if (!zynga) {
    console.log('  (no Zynga counterparty — skipping)')
  } else {
    // Find a contract for Zynga
    const contractsRes = await fetch(`${API}/contracts?counterpartyId=${zynga.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const contractsJson = await contractsRes.json()
    const contracts = contractsJson.contracts ?? contractsJson.data ?? contractsJson
    const contract = Array.isArray(contracts) ? contracts[0] : null
    if (!contract) {
      console.log('  (no contract found for Zynga — skipping)')
    } else {
      console.log(`  posting comment to contract ${contract.id.slice(-8)}…`)
      const postRes = await fetch(`${API}/contracts/${contract.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ body: 'P7.4.6 verify — testing real activity signal' }),
      })
      const postOk = postRes.ok
      console.log(`  comment posted: ${postOk ? 'OK' : `FAIL ${postRes.status}`}`)

      // Now re-fetch counterparties — Zynga should be "comment"
      const cps2Res = await fetch(`${API}/counterparties`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const cps2 = (await cps2Res.json()).data
      const zyngaAfter = cps2.find(c => c.id === zynga.id)
      console.log(`  zynga after: kind=${zyngaAfter?.lastActivityKind} ts=${zyngaAfter?.lastContractAt}`)
      check(zyngaAfter?.lastActivityKind === 'comment', `Zynga's lastActivityKind is now "comment"`)
    }
  }

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.6 last-activity-kind checks pass')
})().catch(e => { console.error(e); process.exit(1) })
