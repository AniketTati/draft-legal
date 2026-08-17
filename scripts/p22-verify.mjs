#!/usr/bin/env node
/**
 * P2.2 verify — Structural HTML extractor (PDF → semantic tree).
 *
 *   (1) /extract on a digital PDF with "Section 9. / Section 9.1. /
 *       Section 9.2." returns a nested section tree
 *   (2) "Section 9" is h2, "Section 9.1" and "Section 9.2" are h3
 *       children of it (dot-count → heading level)
 *   (3) Refs are parsed cleanly + titles stripped ("Limitation of
 *       Liability" not "Section 9. Limitation of Liability")
 *   (4) Upload through POST /contracts/upload → version.metadata.structure
 *       carries the tree + flat nav
 *   (5) UI shows a Table of Contents rail section with at least 3 entries
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const API = 'http://localhost:3001'
const FIXTURE = '/tmp/p22-digital-msa.pdf'

function readEnv(key) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', '-e', `process.stdout.write(process.env['${key}'] ?? '')`], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return r.stdout.trim()
}

function ensureFixture() {
  if (existsSync(FIXTURE)) return
  const r = spawnSync('bash', ['-c', `
    cd ${path.join(REPO_ROOT, 'apps/agents')} &&
    source .venv/bin/activate &&
    python - <<'PY'
import fitz
doc = fitz.open()
page = doc.new_page(width=612, height=792)
y = 72
page.insert_text((72, y), 'MASTER SERVICES AGREEMENT', fontsize=18, fontname='Times-Roman'); y += 50
page.insert_text((72, y), 'This Agreement is entered between Demo Org and Acme.', fontsize=10, fontname='Times-Roman'); y += 40
page.insert_text((72, y), 'Section 1. Scope of Services', fontsize=11, fontname='Times-Bold'); y += 20
page.insert_text((72, y), 'Provider shall deliver services per SOW.', fontsize=10, fontname='Times-Roman'); y += 40
page.insert_text((72, y), 'Section 9. Limitation of Liability', fontsize=11, fontname='Times-Bold'); y += 20
page.insert_text((72, y), 'Section 9.1. Cap', fontsize=10, fontname='Times-Bold'); y += 18
page.insert_text((72, y), 'Liability capped at 12 months of fees.', fontsize=10, fontname='Times-Roman'); y += 30
page.insert_text((72, y), 'Section 9.2. Carve-outs', fontsize=10, fontname='Times-Bold'); y += 18
page.insert_text((72, y), 'Caps do not apply to gross negligence.', fontsize=10, fontname='Times-Roman'); y += 40
page.insert_text((72, y), 'Section 12. Governing Law', fontsize=11, fontname='Times-Bold'); y += 20
page.insert_text((72, y), 'Governed by Delaware law.', fontsize=10, fontname='Times-Roman')
doc.save('${FIXTURE}')
doc.close()
print('wrote ${FIXTURE}')
PY
  `], { stdio: 'pipe', encoding: 'utf-8' })
  if (r.status !== 0 || !existsSync(FIXTURE)) {
    console.error('fixture build failed:', r.stderr)
    process.exit(1)
  }
}

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  }).then(x => x.json())
  return r.accessToken
}

async function waitFor(predicate, { timeout = 90_000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}

;(async () => {
  ensureFixture()
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const secret = readEnv('INTERNAL_SERVICE_SECRET')
  const buf = readFileSync(FIXTURE)

  // (1) Direct /extract → nav has ≥4 entries
  const f1 = new FormData()
  f1.append('file', new Blob([buf], { type: 'application/pdf' }), 'msa.pdf')
  const extRes = await fetch('http://localhost:8002/extract', {
    method: 'POST', body: f1,
    headers: { 'x-internal-secret': secret },
  })
  const ext = await extRes.json()
  check(extRes.status === 200, `(1) /extract returns 200 (got ${extRes.status})`)
  const nav = ext?.structure?.nav ?? []
  check(nav.length >= 5, `(1) nav has ≥5 entries (title + 4 sections; got ${nav.length})`)

  // (2) Nesting: "9" is h2, "9.1"/"9.2" are h3 directly under it
  const nine  = nav.find(n => n.ref === '9')
  const nine1 = nav.find(n => n.ref === '9.1')
  const nine2 = nav.find(n => n.ref === '9.2')
  check(nine?.level === 2, `(2) Section 9 is h2 (got h${nine?.level})`)
  check(nine1?.level === 3, `(2) Section 9.1 is h3 (got h${nine1?.level})`)
  check(nine2?.level === 3, `(2) Section 9.2 is h3 (got h${nine2?.level})`)
  check(nine1?.depth === nine?.depth + 1,
    `(2) Section 9.1 nested depth = 9's depth + 1 (got ${nine1?.depth} vs ${nine?.depth})`)
  check(nine2?.depth === nine?.depth + 1,
    `(2) Section 9.2 nested depth = 9's depth + 1 (got ${nine2?.depth} vs ${nine?.depth})`)

  // (3) Titles stripped of ref prefix
  check(nine?.title === 'Limitation of Liability',
    `(3) Section 9 title = "Limitation of Liability" (got "${nine?.title}")`)
  check(nine1?.title === 'Cap',
    `(3) Section 9.1 title = "Cap" (got "${nine1?.title}")`)
  check(nine2?.title === 'Carve-outs',
    `(3) Section 9.2 title = "Carve-outs" (got "${nine2?.title}")`)

  // (4) Upload + DB persistence
  const token = await login()
  const f2 = new FormData()
  f2.append('file', new Blob([buf], { type: 'application/pdf' }), 'msa.pdf')
  f2.append('title', `P2.2 digital MSA ${Date.now()}`)
  f2.append('type', 'MSA')
  const upRes = await fetch(`${API}/api/v1/contracts/upload`, {
    method: 'POST', body: f2, headers: { authorization: `Bearer ${token}` },
  })
  check(upRes.ok, `(4) upload returns 2xx (got ${upRes.status})`)
  const upJson = await upRes.json()
  const contractId = upJson.contractId ?? upJson.id ?? upJson.contract?.id
  check(!!contractId, `(4) contractId returned (${contractId})`)

  const got = await waitFor(async () => {
    const c = await fetch(`${API}/api/v1/contracts/${contractId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null)
    const v = c?.versions?.[0]
    const s = v?.metadata?.structure
    return Array.isArray(s?.nav) && s.nav.length >= 3
  })
  check(got, `(4) worker persisted metadata.structure.nav within 90s`)

  const contract = await fetch(`${API}/api/v1/contracts/${contractId}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const storedNav = contract?.versions?.[0]?.metadata?.structure?.nav ?? []
  check(storedNav.length >= 5,
    `(4) stored nav length ≥5 (got ${storedNav.length})`)
  const stored91 = storedNav.find(n => n.ref === '9.1')
  check(stored91?.title === 'Cap',
    `(4) stored Section 9.1 title = "Cap" (got "${stored91?.title}")`)

  // (5) UI renders the TOC rail section with clickable entries
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const toc = page.getByTestId('contract-toc')
  check(await toc.isVisible(), `(5) Table-of-Contents rail section renders`)
  const items = await page.locator('[data-testid^="toc-item-"]').count()
  check(items >= 5, `(5) TOC has ≥5 items (got ${items})`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/125-p22-toc.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P2.2 structural-extractor checks pass')
})().catch(e => { console.error(e); process.exit(1) })
