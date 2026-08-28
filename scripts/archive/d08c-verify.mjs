#!/usr/bin/env node
/**
 * D.0.8c verify — Cost cap section
 *
 * Asserts:
 *  1. Progress band renders with $X.XXXX / $YY.YY + percentage + reset time
 *  2. Daily cap input + "Block" / "Warn" policy toggle are present
 *  3. Changing the cap enables Save; saving persists (round-trips PUT /settings)
 *  4. Switching policy toggle updates the inline description
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const SHOTS = path.join(REPO_ROOT, 'scripts/screenshots/desktop')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  // Login
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15_000 })
  await page.waitForTimeout(600)

  // Pre-clean via API so we start from a known state
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('clm-auth')
    if (!raw) return null
    try { return JSON.parse(raw).state?.accessToken ?? null } catch { return null }
  })
  await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCostCapUsd: null, capPolicy: 'block' }),
  })

  await page.goto('http://localhost:5173/admin/org', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /ai config/i }).click()
  await page.waitForTimeout(1500)

  await page.getByRole('heading', { name: /^cost cap$/i, level: 2 }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // (1) Progress band elements
  const progressBar = await page.getByTestId('cap-progress-bar').isVisible().catch(() => false)
  check(progressBar, 'progress bar visible')
  const resetCaption = await page.getByText(/resets at 00:00 utc/i).isVisible().catch(() => false)
  check(resetCaption, '"resets at 00:00 UTC" caption visible')
  // The big dollar amount + slash + cap
  const bigDollar = await page.getByText(/^\$\d/).first().isVisible().catch(() => false)
  check(bigDollar, 'big dollar figure visible')

  // (2) Cap input + policy chips
  const capInputVisible = await page.getByTestId('cost-cap-input').isVisible().catch(() => false)
  check(capInputVisible, 'cost-cap-input visible')
  const blockChip = await page.getByTestId('policy-block').isVisible().catch(() => false)
  const warnChip  = await page.getByTestId('policy-warn').isVisible().catch(() => false)
  check(blockChip && warnChip, 'both "Block" and "Warn" policy chips visible')

  // Policy defaults to "block" (aria-checked)
  const blockChecked = await page.getByTestId('policy-block').getAttribute('aria-checked')
  check(blockChecked === 'true', `Block chip is aria-checked by default (got ${blockChecked})`)

  await page.screenshot({ path: `${SHOTS}/55-d08c-cap-initial.png`, fullPage: true })

  // (3) Edit the cap → Save button enables → save round-trips
  const saveBtn = page.getByRole('button', { name: /save changes|saved/i }).last()
  const savedInitial = await saveBtn.textContent()
  check(/saved/i.test(savedInitial ?? ''), 'Save button starts as "Saved"')

  await page.getByTestId('cost-cap-input').fill('75.50')
  await page.waitForTimeout(200)
  const afterEdit = await saveBtn.textContent()
  check(/save changes/i.test(afterEdit ?? ''), 'Save button flips to "Save changes" after edit')

  await saveBtn.click()
  await page.waitForTimeout(1200)
  const afterSave = await saveBtn.textContent()
  check(/saved/i.test(afterSave ?? ''), 'Save button returns to "Saved" after mutation')

  // (4) Flip policy to warn → inline description changes
  await page.getByTestId('policy-warn').click()
  await page.waitForTimeout(200)
  const warnCopy = await page.getByText(/will keep working/i).isVisible().catch(() => false)
  check(warnCopy, 'warn policy shows "calls will keep working" copy')

  await page.getByRole('button', { name: /save changes/i }).last().click()
  await page.waitForTimeout(1000)

  // Round-trip: GET /settings should now have capPolicy=warn + dailyCostCapUsd=75.5
  const verifyResp = await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(verifyResp.dailyCostCapUsd === 75.5, `server has dailyCostCapUsd=75.5 (got ${verifyResp.dailyCostCapUsd})`)
  check(verifyResp.capPolicy === 'warn', `server has capPolicy=warn (got ${verifyResp.capPolicy})`)

  await page.screenshot({ path: `${SHOTS}/56-d08c-cap-saved.png`, fullPage: true })

  // Cleanup — restore defaults
  await fetch('http://localhost:3001/api/v1/admin/ai/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCostCapUsd: null, capPolicy: 'block' }),
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.0.8c UI checks pass')
})().catch(e => { console.error(e); process.exit(1) })
