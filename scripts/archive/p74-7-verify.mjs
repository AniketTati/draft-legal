#!/usr/bin/env node
/**
 * P7.4.7 verify — Profile + breadcrumb fixes (F-12, F-16, F-54).
 *
 * F-12: Profile email field showed admin@demo.com as PLACEHOLDER (greyed)
 *       not as the actual value. Now it's bound to profile.email,
 *       readonly, with a clear "read-only" badge.
 *
 * F-16: Initials for "Ani" were "AN" (took first 2 chars). Now single-
 *       word names get just the first letter.
 *
 * F-54: Matter detail breadcrumb showed the matter ID. Now it shows
 *       the matter name (added matter lookup to Breadcrumbs.tsx).
 *
 * Checks:
 *   (1) /profile email field has actual value, not placeholder
 *   (2) /profile shows "read-only" badge on email
 *   (3) initialsFrom("Ani") = "A", initialsFrom("Maya G") = "MG"
 *   (4) /matters/:id breadcrumb shows matter name not id
 *   (5) /counterparties/:id breadcrumb shows cp name not id
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'screenshots', 'desktop')
fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const br = await chromium.launch({ headless: true })
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0, 200)))

  console.log('\n=== Login as Maya ===')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'maya@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  // ── (1) (2) Profile email + read-only badge
  console.log('\n=== (1+2) Profile email — actual value, read-only badge ===')
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const emailField = page.getByTestId('profile-email')
  const emailValue = await emailField.inputValue()
  console.log(`  email value: "${emailValue}"`)
  check(emailValue === 'maya@demo.com', `email field has actual value (got "${emailValue}")`)

  // The read-only badge text should be present
  const readonlyBadge = await page.locator('text=READ-ONLY').count()
  check(readonlyBadge >= 1, `read-only badge visible (got ${readonlyBadge})`)

  await page.screenshot({ path: path.join(OUT, '217-p74-7-profile-email.png'), fullPage: false })

  // ── (3) Initials function — verify in-page
  console.log('\n=== (3) Initials function correct for single-word names ===')
  // Locate the avatar initials element on /profile
  const initialsTxt = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="avatar-initials"]')
    return el ? (el.textContent ?? '').trim() : null
  })
  console.log(`  rendered initials for "Maya Goldberg": "${initialsTxt}"`)
  // Maya Goldberg → "MG"
  check(initialsTxt === 'MG', `Maya Goldberg → "MG" (got "${initialsTxt}")`)

  // Now change the name field to "Ani" and verify initials become "A"
  const nameField = page.locator('input#profile-name')
  await nameField.fill('Ani')
  await page.waitForTimeout(300)
  const initialsAni = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="avatar-initials"]')
    return el ? (el.textContent ?? '').trim() : null
  })
  console.log(`  rendered initials for "Ani": "${initialsAni}"`)
  check(initialsAni === 'A', `Ani → "A" (got "${initialsAni}")`)

  // Restore the original name (don't save, just reset visually)
  await nameField.fill('Maya Goldberg')
  await page.waitForTimeout(200)

  // ── (4) Matter breadcrumb shows name not id
  console.log('\n=== (4) Matter detail breadcrumb shows name ===')
  // Maya's org may or may not have matters; find one via API first
  const tokenRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })
  const { accessToken } = await tokenRes.json()
  const mattersRes = await fetch('http://localhost:3001/api/v1/matters', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const mattersJson = await mattersRes.json()
  const matters = mattersJson.matters ?? mattersJson.data ?? mattersJson
  if (Array.isArray(matters) && matters.length > 0) {
    const m = matters[0]
    await page.goto(`${BASE}/matters/${m.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    const crumbs = await page.getByTestId('breadcrumbs').innerText().catch(() => '')
    const cleaned = crumbs.replace(/\s+/g, ' ').trim()
    console.log(`  crumbs on /matters/${m.id}: "${cleaned}"`)
    check(cleaned.toLowerCase().includes(m.name.toLowerCase()),
          `crumbs include matter name "${m.name}" (got "${cleaned}")`)
    check(!cleaned.includes(m.id),
          `crumbs do NOT show raw matter id (got "${cleaned}")`)
  } else {
    console.log('  (no matters available — skipping)')
  }

  // ── (5) Counterparty breadcrumb (already added in P7.4.5 — re-verify)
  console.log('\n=== (5) Counterparty detail breadcrumb shows name ===')
  const cpsRes = await fetch('http://localhost:3001/api/v1/counterparties', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const cps = (await cpsRes.json()).data
  const zynga = cps.find(c => /zynga/i.test(c.name))
  if (zynga) {
    await page.goto(`${BASE}/counterparties/${zynga.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    const crumbs = await page.getByTestId('breadcrumbs').innerText().catch(() => '')
    const cleaned = crumbs.replace(/\s+/g, ' ').trim()
    console.log(`  crumbs: "${cleaned}"`)
    check(cleaned.toLowerCase().includes(zynga.name.toLowerCase()),
          `crumbs include CP name (got "${cleaned}")`)
    check(!cleaned.includes(zynga.id), `crumbs do NOT show raw CP id`)
  }

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.4.7 profile + breadcrumb checks pass')
})().catch(e => { console.error(e); process.exit(1) })
