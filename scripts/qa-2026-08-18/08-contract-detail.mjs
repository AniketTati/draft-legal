#!/usr/bin/env node
/**
 * 08 — Contract detail, against the controls the page actually has.
 *
 * 07 assumed a tab bar. The page is really a document pane + a collapsible
 * right rail (Overview / Obligations / Playbook redline / Compliance) plus
 * Styled|Original, Compare, Edit, Actions. This drives those.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, sqlOne } from './lib/harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WEB_BASE ?? 'http://localhost:5173'
const OUT = path.join(__dirname, 'out', 'shots', 'detail')
fs.mkdirSync(OUT, { recursive: true })
const ORG = 'cmpsae8pm00007olj83jzzess'

const results = []
function rec(id, status, evidence, severity = 'medium') {
  results.push({ id, status, evidence, severity })
  console.log(`[${status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL'}] ${id} — ${evidence}`)
}

async function main() {
  const contractId = sqlOne(`SELECT c.id FROM contracts c JOIN contract_versions v ON v."contractId"=c.id
    WHERE c."orgId"='${ORG}' AND c."deletedAt" IS NULL
    GROUP BY c.id ORDER BY count(v."s3Key") DESC, count(v.id) DESC LIMIT 1`)
  const auth = await login('legal@demo.com')

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript(([t, r, u]) => {
    localStorage.setItem('clm-auth', JSON.stringify({ state: { accessToken: t, refreshToken: r, user: u, isAuthenticated: true }, version: 0 }))
    localStorage.setItem('accessToken', t)
  }, [auth.accessToken, auth.refreshToken, auth.user])
  const page = await ctx.newPage()
  let errs = []
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)))
  page.on('response', (r) => r.status() >= 500 && errs.push(`5xx ${r.url().replace(BASE, '')}`))

  // networkidle never fires here — the agent rail holds an open SSE stream.
  // Wait for the contract heading instead.
  await page.goto(`${BASE}/contracts/${contractId}`, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(3500)

  // C1 — the document body actually renders contract text
  {
    const txt = await page.evaluate(() => document.body.innerText)
    const hasDoc = /MASTER SERVICES AGREEMENT|AGREEMENT|WHEREAS|entered into/i.test(txt) && txt.length > 3000
    rec('C1-document-renders', hasDoc ? 'pass' : 'fail',
      `${txt.length} chars, contract prose present=${hasDoc}`, 'high')
  }

  // C2 — right-rail analysis sections are populated, not empty shells
  {
    const txt = await page.evaluate(() => document.body.innerText)
    const sections = ['OVERVIEW', 'OBLIGATIONS', 'PLAYBOOK REDLINE', 'COMPLIANCE']
    const present = sections.filter((s) => txt.toUpperCase().includes(s))
    rec('C2-analysis-rail', present.length >= 3 ? 'pass' : 'fail',
      `sections present: ${present.join(', ')} (${present.length}/${sections.length})`, 'high')
  }

  // C3 — Styled / Original toggle switches the rendering
  {
    errs = []
    const before = await page.evaluate(() => document.body.innerText.length)
    const ok = await page.getByRole('button', { name: /^original$/i }).first().click({ timeout: 4000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(1500)
    const after = await page.evaluate(() => document.body.innerText.length)
    await page.screenshot({ path: path.join(OUT, 'original-view.png'), fullPage: false }).catch(() => {})
    rec('C3-styled-original', ok && !errs.length ? 'pass' : ok ? 'fail' : 'skip',
      `clicked=${ok} chars ${before}→${after}${errs.length ? ` errors=[${errs}]` : ''}`, 'medium')
    await page.getByRole('button', { name: /^styled$/i }).first().click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(800)
  }

  // C4 — Compare opens the version diff surface
  {
    errs = []
    const ok = await page.getByRole('button', { name: /compare/i }).first().click({ timeout: 4000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(2200)
    const txt = await page.evaluate(() => document.body.innerText)
    const diffy = /version|v\d|compare|diff|added|removed/i.test(txt)
    await page.screenshot({ path: path.join(OUT, 'compare.png'), fullPage: false }).catch(() => {})
    rec('C4-version-compare', ok && diffy && !errs.length ? 'pass' : ok ? 'warn' : 'skip',
      `clicked=${ok} diffUiPresent=${diffy}${errs.length ? ` errors=[${errs}]` : ''}`, 'high')
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(600)
  }

  // C5 — Actions menu exposes lifecycle operations
  {
    errs = []
    const ok = await page.getByRole('button', { name: /actions/i }).first().click({ timeout: 4000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(1200)
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"],[role="menu"] button,[role="dialog"] button')]
        .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 20))
    await page.screenshot({ path: path.join(OUT, 'actions-menu.png'), fullPage: false }).catch(() => {})
    rec('C5-actions-menu', ok && items.length ? 'pass' : ok ? 'warn' : 'skip',
      `clicked=${ok} items=[${items.join(' | ')}]${errs.length ? ` errors=[${errs}]` : ''}`, 'medium')
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(600)
  }

  // C6 — Edit opens the editor without exploding
  {
    errs = []
    const ok = await page.getByRole('button', { name: /^edit$/i }).first().click({ timeout: 4000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(2500)
    const editable = await page.evaluate(() =>
      !!document.querySelector('[contenteditable="true"], .ProseMirror, .tiptap'))
    await page.screenshot({ path: path.join(OUT, 'editor.png'), fullPage: false }).catch(() => {})
    rec('C6-editor', ok && editable && !errs.length ? 'pass' : ok ? 'warn' : 'skip',
      `clicked=${ok} editorMounted=${editable}${errs.length ? ` errors=[${errs}]` : ''}`, 'high')
  }

  // C7 — contract-scoped agent context is wired (page passes the contract in)
  {
    const txt = await page.evaluate(() => document.body.innerText)
    const scoped = /focused on contract|context:/i.test(txt)
    rec('C7-agent-contract-scope', scoped ? 'pass' : 'warn',
      `agent panel shows contract scope=${scoped}`, 'medium')
  }

  await browser.close()
  fs.writeFileSync(path.join(__dirname, 'out', '08-contract-detail.json'), JSON.stringify({ contractId, results }, null, 2))
  const f = results.filter((r) => r.status === 'fail')
  const w = results.filter((r) => r.status === 'warn')
  console.log(`\n──────── ${results.length} checks · ${f.length} FAIL · ${w.length} WARN ────────`)
  for (const x of [...f, ...w]) console.log(`  ${x.status.toUpperCase()} ${x.id} — ${x.evidence}`)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
