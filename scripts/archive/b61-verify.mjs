#!/usr/bin/env node
// B.6.1 verify — confirm clean-demo removed all test artefacts.
// JTBD: "A new evaluator opens /templates and /clauses and sees a
// believable, tidy library — not typos, duplicates, or scratch data."
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const EMAIL = process.env.E2E_EMAIL ?? 'admin@demo.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'password123'
const OUT = path.resolve('scripts/screenshots/b6')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

async function shot(name) {
  const p = path.join(OUT, name)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

try {
  await page.goto(`${WEB}/login`)
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`${WEB}/templates`)
  await page.waitForLoadState('networkidle')
  await shot('b61-templates-after-clean.png')
  const tmplHtml = (await page.content()).toLowerCase()

  await page.goto(`${WEB}/clauses`)
  await page.waitForLoadState('networkidle')
  await shot('b61-clauses-after-clean.png')
  const clHtml = (await page.content()).toLowerCase()

  await page.goto(`${WEB}/playbook`)
  await page.waitForLoadState('networkidle')
  await shot('b61-playbook-after-clean.png')
  const pbHtml = (await page.content()).toLowerCase()

  const checks = [
    { where: 'templates', html: tmplHtml, must_not: ['aniket nda'] },
    { where: 'clauses', html: clHtml, must_not: ['my categoty', '>my cat<', 'temp<', '>my one<'] },
    { where: 'playbook', html: pbHtml, must_not: ['my categoty', '>my cat<'] },
  ]

  let fail = 0
  for (const c of checks) {
    for (const needle of c.must_not) {
      const found = c.html.includes(needle)
      if (found) {
        console.log(`FAIL ${c.where} :: still contains "${needle}"`)
        fail++
      } else {
        console.log(`PASS ${c.where} :: no "${needle}"`)
      }
    }
  }

  // Count categories in the tree — should be exactly 3 distinct (+ "All Clauses")
  await page.goto(`${WEB}/clauses`)
  await page.waitForLoadState('networkidle')
  // Category tree items live in the first column — look for the CATEGORIES heading's ancestor
  const catTreeLabels = await page
    .locator('aside ~ div button, aside ~ div [role="button"]')
    .allInnerTexts()
    .catch(() => [])
  // Simpler: count exact-text matches in the heading cells
  const exactLiability = await page.locator('text="Limitation of Liability"').count()
  const exactIp = await page.locator('text="IP Ownership"').count()
  const exactConf = await page.locator('text="Confidentiality"').count()
  console.log(`Exact-text category labels — Liability=${exactLiability}, IP=${exactIp}, Confidentiality=${exactConf}`)
  if (exactLiability === 1 && exactIp === 1 && exactConf === 1) {
    console.log('  PASS — category tree contains exactly one of each canonical category')
  } else {
    console.log('  FAIL — category count off (expected 1/1/1)')
    fail++
  }

  // Also confirm the clause list count is the de-duped 7
  const clauseCountText = await page.locator('text=/^\\d+ clauses$/').first().innerText().catch(() => '')
  console.log(`Clause count footer: "${clauseCountText}" (expect "7 clauses")`)
  if (!clauseCountText.startsWith('7 ')) {
    console.log('  FAIL — clause total changed')
    fail++
  } else {
    console.log('  PASS — 7 unique clauses')
  }

  if (fail) {
    console.log(`\n✗ ${fail} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ All B.6.1 checks pass. Screenshots in ${OUT}/`)
  }
} finally {
  await browser.close()
}
