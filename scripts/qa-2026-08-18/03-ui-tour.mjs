#!/usr/bin/env node
/**
 * 03 — Full UI tour.
 *
 * Walks every route registered in apps/web/src/App.tsx, at desktop and mobile
 * viewports. Per route it records: HTTP-level failures, console errors, unhandled
 * rejections, whether the page rendered anything, and whether an error boundary
 * or empty state is showing. Screenshots land in out/shots/.
 *
 * Usage: node scripts/qa-2026-08-18/03-ui-tour.mjs [--mobile] [--headed]
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, sqlOne } from './lib/harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WEB_BASE ?? 'http://localhost:5173'
const MOBILE = process.argv.includes('--mobile')
const HEADED = process.argv.includes('--headed')
const LABEL = MOBILE ? 'mobile' : 'desktop'
const OUT = path.join(__dirname, 'out', 'shots', LABEL)
fs.mkdirSync(OUT, { recursive: true })

const ORG = 'cmpsae8pm00007olj83jzzess'

async function main() {
  // Real IDs so detail routes render real data, not 404 shells.
  const fx = {
    contractId: sqlOne(`SELECT id FROM contracts WHERE "orgId"='${ORG}' AND status='EXECUTED' AND "deletedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`),
    counterpartyId: sqlOne(`SELECT id FROM counterparties WHERE "orgId"='${ORG}' LIMIT 1`),
    matterId: sqlOne(`SELECT id FROM matters WHERE "orgId"='${ORG}' LIMIT 1`),
    diligenceId: sqlOne(`SELECT id FROM diligence_rooms WHERE "orgId"='${ORG}' LIMIT 1`),
  }

  const auth = await login('admin@demo.com')

  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext({
    viewport: MOBILE ? { width: 375, height: 812 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
  })

  // Seed auth into localStorage so protected routes render immediately.
  // The app uses zustand/persist under the key `clm-auth` ({state, version});
  // lib/collab.ts additionally reads a bare `accessToken` key.
  await ctx.addInitScript(
    ([tok, refresh, user]) => {
      localStorage.setItem(
        'clm-auth',
        JSON.stringify({
          state: { accessToken: tok, refreshToken: refresh, user, isAuthenticated: true },
          version: 0,
        }),
      )
      localStorage.setItem('accessToken', tok)
    },
    [auth.accessToken, auth.refreshToken, auth.user],
  )

  const page = await ctx.newPage()

  // ── Per-route diagnostic collectors ────────────────────────────────────
  let bucket = { console: [], pageerror: [], netfail: [], http4xx5xx: [] }
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.console.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => bucket.pageerror.push(String(e.message).slice(0, 300)))
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? ''
    if (f.includes('ERR_ABORTED')) return // navigation cancels are noise
    bucket.netfail.push(`${r.method()} ${r.url().replace(BASE, '')} — ${f}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) bucket.http4xx5xx.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`)
  })

  const routes = [
    // ── public ──
    ['login', '/login', { anon: true }],
    ['register', '/register', { anon: true }],
    ['privacy', '/privacy', { anon: true }],
    ['terms', '/terms', { anon: true }],
    ['status', '/status', { anon: true }],
    ['404', '/this-route-does-not-exist'],
    // ── app ──
    ['dashboard', '/dashboard'],
    ['agent', '/agent'],
    ['contracts', '/contracts'],
    ['contracts-search', '/contracts?q=services'],
    ['contracts-draft', '/contracts?status=DRAFT'],
    ['contracts-executed', '/contracts?status=EXECUTED'],
    ['contract-detail', `/contracts/${fx.contractId}`],
    ['requests', '/requests'],
    ['counterparties', '/counterparties'],
    ['counterparty-detail', `/counterparties/${fx.counterpartyId}`],
    ['templates', '/templates'],
    ['clauses', '/clauses'],
    ['playbook', '/playbook'],
    ['approvals', '/approvals'],
    ['signatures', '/signatures'],
    ['obligations', '/obligations'],
    ['renewals', '/renewals'],
    ['invoices', '/invoices'],
    ['diligence', '/diligence'],
    ['diligence-detail', `/diligence/${fx.diligenceId}`],
    ['analytics', '/analytics'],
    ['review-queue', '/review-queue'],
    ['matters', '/matters'],
    ['matter-detail', `/matters/${fx.matterId}`],
    ['team', '/team'],
    ['profile', '/profile'],
    ['settings', '/settings'],
    ['admin-users', '/admin/users'],
    ['admin-roles', '/admin/roles'],
    ['admin-org', '/admin/org'],
    ['admin-integrations', '/admin/integrations'],
    ['admin-skills', '/admin/skills'],
    ['settings-skills', '/settings/skills'],
  ]

  const report = []
  for (const [name, url, opts = {}] of routes) {
    if (url.includes('undefined') || url.includes('null')) {
      report.push({ name, url, verdict: 'SKIP', note: 'no fixture id' })
      console.log(`[SKIP] ${name} — no fixture`)
      continue
    }
    bucket = { console: [], pageerror: [], netfail: [], http4xx5xx: [] }
    let navErr = null
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 })
    } catch (e) {
      navErr = String(e.message).split('\n')[0].slice(0, 160)
    }
    await page.waitForTimeout(900)

    // What actually rendered?
    const probe = await page.evaluate(() => {
      const t = document.body?.innerText ?? ''
      const seen = (re) => re.test(t)
      return {
        chars: t.replace(/\s+/g, ' ').trim().length,
        head: t.replace(/\s+/g, ' ').trim().slice(0, 160),
        errorBoundary: seen(/something went wrong|unexpected error|error boundary|失败/i),
        notFound: seen(/404|page not found|not found/i),
        emptyState: seen(/no .{0,24}(yet|found)|nothing here|get started by/i),
        spinnerStuck: !!document.querySelector('[role="status"],.animate-spin'),
        h1: document.querySelector('h1')?.textContent?.trim() ?? null,
      }
    }).catch(() => ({ chars: 0, head: '(evaluate failed)', errorBoundary: false, notFound: false, emptyState: false, spinnerStuck: false, h1: null }))

    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !MOBILE }).catch(() => {})

    // Verdict
    let verdict = 'PASS'
    const problems = []
    if (navErr) { verdict = 'FAIL'; problems.push(`nav: ${navErr}`) }
    if (probe.errorBoundary) { verdict = 'FAIL'; problems.push('error boundary rendered') }
    if (probe.chars < 40 && name !== '404') { verdict = 'FAIL'; problems.push(`near-blank page (${probe.chars} chars)`) }
    if (probe.notFound && name !== '404') { verdict = 'FAIL'; problems.push('shows 404 copy') }
    if (bucket.pageerror.length) { verdict = 'FAIL'; problems.push(`${bucket.pageerror.length} uncaught: ${bucket.pageerror[0]}`) }
    const serverErrs = bucket.http4xx5xx.filter((s) => s.startsWith('5'))
    if (serverErrs.length) { verdict = 'FAIL'; problems.push(`5xx: ${serverErrs.join('; ')}`) }
    const clientErrs = bucket.http4xx5xx.filter((s) => /^4/.test(s) && !/401|403/.test(s))
    if (clientErrs.length && verdict === 'PASS') { verdict = 'WARN'; problems.push(`4xx: ${clientErrs.slice(0, 4).join('; ')}`) }
    if (bucket.console.length && verdict === 'PASS') { verdict = 'WARN'; problems.push(`console: ${bucket.console[0]}`) }
    if (probe.spinnerStuck && verdict === 'PASS') { verdict = 'WARN'; problems.push('spinner still visible after settle') }

    report.push({
      name, url, verdict, h1: probe.h1, chars: probe.chars, head: probe.head,
      problems, console: bucket.console, pageerror: bucket.pageerror,
      netfail: bucket.netfail, http: bucket.http4xx5xx,
    })
    console.log(`[${verdict}] ${name.padEnd(22)} ${url}`)
    if (probe.h1) console.log(`        h1: ${probe.h1}`)
    for (const p of problems) console.log(`        ! ${p}`)
  }

  await browser.close()

  fs.writeFileSync(path.join(__dirname, 'out', `03-ui-tour-${LABEL}.json`), JSON.stringify(report, null, 2))
  const fails = report.filter((r) => r.verdict === 'FAIL')
  const warns = report.filter((r) => r.verdict === 'WARN')
  console.log(`\n──────── ${LABEL}: ${report.length} routes · ${fails.length} FAIL · ${warns.length} WARN ────────`)
  for (const f of fails) console.log(`  FAIL ${f.name} — ${f.problems.join(' | ')}`)
  for (const w of warns) console.log(`  WARN ${w.name} — ${w.problems.join(' | ')}`)
}

main().catch((e) => { console.error('TOUR ERROR', e); process.exit(1) })
