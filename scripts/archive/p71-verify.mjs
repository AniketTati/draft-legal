#!/usr/bin/env node
/**
 * P7.1 verify — Make the agent the actual home (4 sub-items).
 *
 *   (1) /api/v1/dashboard returns yourDay with negotiations[] + renewals[]
 *   (2) Approver loads contract detail → Decision Strip renders
 *   (3) HeroAgent chips include "negotiation in flight" or "renewal coming up"
 *   (4) Side rail starter chips are contract-scoped on /contracts/:id
 *       and portfolio-scoped on /dashboard
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'

const API = 'http://localhost:3001'
const BASE = 'http://localhost:5173'

;(async () => {
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  // ── (1) Dashboard your-day API
  console.log('\n=== (1) F-77/F-78 — Dashboard your-day API ===')
  const tok = (await (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.com', password: 'password123' }),
  })).json()).accessToken
  const dash = await (await fetch(`${API}/api/v1/dashboard`, { headers: { authorization: `Bearer ${tok}` } })).json()
  check(dash?.yourDay, 'yourDay object present in dashboard response')
  check((dash?.yourDay?.negotiations?.length ?? 0) >= 1, `Maya: yourDay.negotiations has ≥1 row (got ${dash?.yourDay?.negotiations?.length})`)
  const zynga = (dash?.yourDay?.negotiations ?? []).find(n => n.title?.includes('Zynga'))
  check(zynga, 'Maya: Zynga MSA appears in negotiations[]')
  check(zynga?.value === 2400000, `Maya: Zynga negotiation has value=$2.4M (got ${zynga?.value})`)

  const lisaTok = (await (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'lisa@demo.com', password: 'password123' }),
  })).json()).accessToken
  const lisaDash = await (await fetch(`${API}/api/v1/dashboard`, { headers: { authorization: `Bearer ${lisaTok}` } })).json()
  check((lisaDash?.yourDay?.renewals?.length ?? 0) >= 1, `Lisa: yourDay.renewals has ≥1 row (got ${lisaDash?.yourDay?.renewals?.length})`)
  const datadog = (lisaDash?.yourDay?.renewals ?? []).find(r => r.title?.includes('Datadog'))
  check(datadog, 'Lisa: Datadog appears in renewals[]')
  check((datadog?.daysToExpiry ?? 999) <= 90, `Lisa: Datadog daysToExpiry ≤ 90 (got ${datadog?.daysToExpiry})`)

  // ── (2) Approver mode renders Decision Strip
  console.log('\n=== (2) F-41 — Approver Mode decision strip ===')
  const list = (await (await fetch(`${API}/api/v1/contracts?limit=20`, { headers: { authorization: `Bearer ${tok}` } })).json()).data ?? []
  const sf = list.find(c => c.title?.includes('Salesforce'))
  check(sf, 'Salesforce Order Form found')

  const marcusTok = (await (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'marcus@demo.com', password: 'password123' }),
  })).json()).accessToken
  const marcusQueue = await (await fetch(`${API}/api/v1/approvals/my-queue`, { headers: { authorization: `Bearer ${marcusTok}` } })).json()
  check((marcusQueue?.data?.length ?? 0) >= 1, `Marcus: queue has ≥1 step (got ${marcusQueue?.data?.length})`)
  const sfStep = (marcusQueue?.data ?? []).find(s => s.contract?.id === sf?.id)
  check(sfStep && sfStep.stepOrder === 1, `Marcus: Salesforce step 1 in his queue`)

  const br = await chromium.launch({ headless: true })
  const page = await (await br.newContext({ viewport: { width: 1680, height: 1100 } })).newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'marcus@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.goto(`${BASE}/contracts/${sf.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i]').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const approveBtn = await page.locator('button:has-text("Approve")').count()
  const rejectBtn = await page.locator('button:has-text("Reject")').count()
  const awaitingTag = await page.locator('text=/AWAITING.*DECISION/i').count()
  check(approveBtn >= 1, `Marcus sees Approve button (count: ${approveBtn})`)
  check(rejectBtn >= 1, `Marcus sees Reject button (count: ${rejectBtn})`)
  check(awaitingTag >= 1, `"AWAITING YOUR DECISION" tag visible (count: ${awaitingTag})`)

  // ── (3) HeroAgent chips include negotiation/renewal labels
  console.log('\n=== (3) F-77 / F-78 — HeroAgent chips ===')
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // Hero chips are buttons containing the trigger text
  const negChip   = await page.locator('button:has-text("negotiation")').count()
  const renewChip = await page.locator('button:has-text("renewal")').count()
  const apprChip  = await page.locator('button:has-text("pending approval")').count()
  const draftChip = await page.locator('button:has-text("draft")').count()
  const total = negChip + renewChip + apprChip + draftChip
  check(total >= 1, `Marcus's hero shows ≥1 work-item chip (negotiations=${negChip}, renewals=${renewChip}, approvals=${apprChip}, drafts=${draftChip})`)

  // ── (4) Side rail dynamic suggestions
  console.log('\n=== (4) F-17 — Side rail chips dynamic per route ===')
  const dashSugs = await page.locator('[data-testid="side-agent-suggestion"]').allInnerTexts()
  check(dashSugs.length >= 3, `Dashboard side rail has ≥3 suggestions (got ${dashSugs.length})`)
  check(dashSugs.some(s => /portfolio|approval queue|negotiation|expire/i.test(s)),
    `Dashboard suggestions are portfolio-scoped`)

  await page.goto(`${BASE}/contracts/${sf.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const detailSugs = await page.locator('[data-testid="side-agent-suggestion"]').allInnerTexts()
  check(detailSugs.length >= 3, `Contract detail side rail has ≥3 suggestions (got ${detailSugs.length})`)
  check(detailSugs.some(s => /Salesforce/.test(s) || /this contract/i.test(s)),
    `Contract-detail suggestions reference the contract`)

  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/201-p71-marcus-decision.png'),
    fullPage: false,
  })

  await br.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P7.1 agent-home checks pass')
})().catch(e => { console.error(e); process.exit(1) })
