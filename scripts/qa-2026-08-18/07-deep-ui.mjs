#!/usr/bin/env node
/**
 * 07 — Deep UI interaction pass.
 *
 * The route tour only saw each page in its landing state. This drives the
 * interactive surface the tour missed: every contract-detail tab, the agent
 * chat round trip, the create dialogs, search/filter, and the signer portal.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, sqlOne } from './lib/harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WEB_BASE ?? 'http://localhost:5173'
const OUT = path.join(__dirname, 'out', 'shots', 'deep')
fs.mkdirSync(OUT, { recursive: true })
const ORG = 'cmpsae8pm00007olj83jzzess'

const results = []
function rec(id, status, evidence, severity = 'medium') {
  results.push({ id, status, evidence, severity })
  const m = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL'
  console.log(`[${m}] ${id} — ${evidence}`)
}

async function main() {
  // A contract with real substance: versions + clauses, so tabs have content.
  // Pick the richest contract available: most versions that actually carry an
  // uploaded file, so the Document / Versions / Negotiate tabs have something
  // to render. A sparse eval fixture hides those tabs entirely.
  const contractId =
    sqlOne(`SELECT c.id FROM contracts c
            JOIN contract_versions v ON v."contractId"=c.id
            WHERE c."orgId"='${ORG}' AND c."deletedAt" IS NULL
            GROUP BY c.id
            ORDER BY count(v."s3Key") DESC, count(v.id) DESC LIMIT 1`)
    ?? sqlOne(`SELECT id FROM contracts WHERE "orgId"='${ORG}' AND "deletedAt" IS NULL LIMIT 1`)
  const title = sqlOne(`SELECT title FROM contracts WHERE id='${contractId}'`)
  console.log(`deep-testing contract ${contractId} — "${title}"\n`)

  const auth = await login('legal@demo.com')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(([tok, rt, u]) => {
    localStorage.setItem('clm-auth', JSON.stringify({ state: { accessToken: tok, refreshToken: rt, user: u, isAuthenticated: true }, version: 0 }))
    localStorage.setItem('accessToken', tok)
  }, [auth.accessToken, auth.refreshToken, auth.user])

  const page = await ctx.newPage()
  let errs = { console: [], pageerror: [], http: [] }
  page.on('console', (m) => m.type() === 'error' && errs.console.push(m.text().slice(0, 200)))
  page.on('pageerror', (e) => errs.pageerror.push(String(e.message).slice(0, 200)))
  page.on('response', (r) => r.status() >= 500 && errs.http.push(`${r.status()} ${r.url().replace(BASE, '')}`))
  const reset = () => { errs = { console: [], pageerror: [], http: [] } }

  // ── D1..D7 · every contract-detail tab ────────────────────────────────
  const TABS = ['overview', 'document', 'clauses', 'versions', 'activity', 'negotiate', 'comments']
  await page.goto(`${BASE}/contracts/${contractId}`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(1200)

  for (const tab of TABS) {
    reset()
    // Tabs are rendered as buttons carrying the tab label.
    const clicked = await page
      .getByRole('button', { name: new RegExp(`^${tab}$`, 'i') })
      .first().click({ timeout: 4000 }).then(() => true).catch(() => false)
    if (!clicked) {
      // fall back to any element whose text matches the tab name
      const alt = await page.locator(`button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first()
        .click({ timeout: 3000 }).then(() => true).catch(() => false)
      if (!alt) { rec(`D-tab-${tab}`, 'skip', 'tab control not found on this contract', 'low'); continue }
    }
    await page.waitForTimeout(1400)
    const probe = await page.evaluate(() => {
      const t = document.body.innerText
      return {
        chars: t.replace(/\s+/g, ' ').trim().length,
        errorBoundary: /something went wrong|unexpected error/i.test(t),
        head: t.replace(/\s+/g, ' ').trim().slice(0, 130),
      }
    })
    await page.screenshot({ path: path.join(OUT, `contract-${tab}.png`), fullPage: true }).catch(() => {})
    const bad = errs.pageerror.length || errs.http.length || probe.errorBoundary
    rec(`D-tab-${tab}`, bad ? 'fail' : 'pass',
      bad
        ? `errorBoundary=${probe.errorBoundary} uncaught=[${errs.pageerror.join('|')}] 5xx=[${errs.http.join('|')}]`
        : `rendered ${probe.chars} chars${errs.console.length ? `, ${errs.console.length} console errors` : ''}`,
      'high')
  }

  // ── D8 · agent chat round trip in the real UI ─────────────────────────
  {
    reset()
    await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const box = page.locator('textarea, [contenteditable="true"], input[type="text"]').last()
    const typed = await box.fill('How many contracts do I have?').then(() => true).catch(() => false)
    if (!typed) {
      rec('D8-agent-chat-ui', 'fail', 'could not find the chat composer', 'high')
    } else {
      await box.press('Enter').catch(() => {})
      // Wait for a numeric answer to stream in.
      let answered = false
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(1500)
        const t = await page.evaluate(() => document.body.innerText)
        if (/\b(375|420)\b/.test(t)) { answered = true; break }
      }
      await page.screenshot({ path: path.join(OUT, 'agent-chat.png'), fullPage: true }).catch(() => {})
      rec('D8-agent-chat-ui', answered ? 'pass' : 'fail',
        answered ? 'composer accepted input and a grounded count streamed back into the UI'
                 : `no answer rendered within 60s; uncaught=[${errs.pageerror.join('|')}]`,
        'high')
    }
  }

  // ── D9 · contracts list search + filter interaction ───────────────────
  {
    reset()
    await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const before = await page.evaluate(() => document.querySelectorAll('table tbody tr, [role="row"]').length)
    const search = page.locator('input[placeholder*="Search by title" i]').first()
    const ok = await search.fill('Acme').then(() => true).catch(() => false)
    await page.waitForTimeout(2200)
    const after = await page.evaluate(() => document.querySelectorAll('table tbody tr, [role="row"]').length)
    await page.screenshot({ path: path.join(OUT, 'contracts-filtered.png'), fullPage: true }).catch(() => {})
    rec('D9-list-search', ok && after > 0 && after !== before ? 'pass' : ok ? 'warn' : 'fail',
      `rows ${before} → ${after} after typing "Acme"${errs.pageerror.length ? ` uncaught=[${errs.pageerror}]` : ''}`,
      'medium')
  }

  // ── D10 · "Draft new" dialog opens ────────────────────────────────────
  {
    reset()
    await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
    await page.waitForTimeout(900)
    const opened = await page.getByRole('button', { name: /draft new/i }).first()
      .click({ timeout: 4000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(1200)
    const modal = await page.evaluate(() =>
      !!document.querySelector('[role="dialog"], .fixed.inset-0'))
    await page.screenshot({ path: path.join(OUT, 'draft-new-dialog.png') }).catch(() => {})
    rec('D10-create-dialog', opened && modal ? 'pass' : 'fail',
      `clicked=${opened} dialogVisible=${modal}${errs.pageerror.length ? ` uncaught=[${errs.pageerror}]` : ''}`, 'high')
    await page.keyboard.press('Escape').catch(() => {})
  }

  // ── D11 · public signer portal renders for an ACTIVE request ──────────
  {
    reset()
    // Must be genuinely live: pending signer, pending request, not yet expired.
    // An expired link renders a "Link unavailable" page, which is a different
    // (and much weaker) assertion than the real signing surface.
    const tok = sqlOne(`SELECT s.token FROM signers s
                        JOIN signature_requests r ON r.id = s."signatureRequestId"
                        WHERE s.token IS NOT NULL AND r.status = 'PENDING'
                          AND s.status = 'PENDING' AND r."expiresAt" > NOW()
                        ORDER BY r."expiresAt" DESC LIMIT 1`)
    if (!tok) {
      rec('D11-signer-portal', 'skip', 'no live (unexpired, pending) signer token in the seed', 'medium')
    } else {
      const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const p2 = await anon.newPage()
      const perr = []
      p2.on('pageerror', (e) => perr.push(String(e.message).slice(0, 160)))
      await p2.goto(`${BASE}/sign/${tok}`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
      await p2.waitForTimeout(1500)
      const probe = await p2.evaluate(() => {
        const t = document.body.innerText
        return {
          chars: t.replace(/\s+/g, ' ').trim().length,
          head: t.replace(/\s+/g, ' ').trim().slice(0, 130),
          // The real signing surface must offer a way to sign; an expired or
          // broken link shows the unavailable page instead.
          canSign: /sign|agree|accept/i.test(t) && !!document.querySelector('input,button,[contenteditable]'),
          unavailable: /link unavailable|expired|no longer active/i.test(t),
        }
      })
      await p2.screenshot({ path: path.join(OUT, 'signer-portal.png'), fullPage: true }).catch(() => {})
      const good = probe.canSign && !probe.unavailable && !perr.length
      rec('D11-signer-portal', good ? 'pass' : 'fail',
        `anonymous render ${probe.chars} chars, canSign=${probe.canSign} unavailable=${probe.unavailable} — "${probe.head}"${perr.length ? ` uncaught=[${perr}]` : ''}`,
        'high')
      await anon.close()
    }
  }

  // ── D12 · keyboard nav / focus visibility on the list ─────────────────
  {
    reset()
    await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(800)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      return { tag: el.tagName, outline: s.outlineStyle !== 'none' && s.outlineWidth !== '0px', ring: s.boxShadow !== 'none' }
    })
    rec('D12-keyboard-focus', focus && (focus.outline || focus.ring) ? 'pass' : 'warn',
      focus ? `focus on <${focus.tag}> outline=${focus.outline} ring=${focus.ring}` : 'focus never left <body> after 6 Tabs',
      'low')
  }

  await browser.close()
  fs.writeFileSync(path.join(__dirname, 'out', '07-deep-ui.json'), JSON.stringify({ contractId, title, results }, null, 2))
  const f = results.filter((r) => r.status === 'fail')
  const w = results.filter((r) => r.status === 'warn')
  console.log(`\n──────── ${results.length} deep checks · ${f.length} FAIL · ${w.length} WARN ────────`)
  for (const x of f) console.log(`  FAIL ${x.id} — ${x.evidence}`)
  for (const x of w) console.log(`  WARN ${x.id} — ${x.evidence}`)
}

main().catch((e) => { console.error('DEEP UI ERROR', e); process.exit(1) })
