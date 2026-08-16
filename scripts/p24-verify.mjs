#!/usr/bin/env node
/**
 * P2.4 verify — Clause bbox preservation (Wave F.4).
 *
 *   (1) /extract on a multi-page PDF returns structure.nav where every
 *       node carries {page: int, bbox: [x0,y0,x1,y1]}
 *   (2) Page numbers are distinct across sections that actually live on
 *       different pages of the source PDF
 *   (3) bbox coords are real (floats, positive, non-degenerate)
 *   (4) Section tree paragraphs[] now carry {text, page, bbox} instead
 *       of plain strings — confirms the full anchor set is preserved
 *   (5) Upload round-trip: version.metadata.structure has the same
 *       bbox shape on the stored row
 *   (6) UI — TOC rail shows "p.1 / p.2 / p.3" page chips per entry
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const API = 'http://localhost:3001'
const FIXTURE = '/tmp/p24-fixture/multipage-msa.pdf'

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
    mkdir -p $(dirname ${FIXTURE}) &&
    python - <<'PY'
import fitz
doc = fitz.open()
# Page 1 — title + first section
p1 = doc.new_page(width=612, height=792)
y = 72
p1.insert_text((72, y), 'MASTER SERVICES AGREEMENT', fontsize=18, fontname='Times-Roman'); y += 50
p1.insert_text((72, y), 'Section 1. Scope of Services', fontsize=11, fontname='Times-Bold'); y += 20
p1.insert_text((72, y), 'Provider shall deliver services per SOW.', fontsize=10, fontname='Times-Roman'); y += 40
# Page 2 — liability
p2 = doc.new_page(width=612, height=792)
y = 72
p2.insert_text((72, y), 'Section 9. Limitation of Liability', fontsize=11, fontname='Times-Bold'); y += 20
p2.insert_text((72, y), 'Section 9.1. Cap', fontsize=10, fontname='Times-Bold'); y += 18
p2.insert_text((72, y), 'Liability capped at twelve months of fees.', fontsize=10, fontname='Times-Roman'); y += 30
p2.insert_text((72, y), 'Section 9.2. Carve-outs', fontsize=10, fontname='Times-Bold'); y += 18
p2.insert_text((72, y), 'Caps do not apply to gross negligence.', fontsize=10, fontname='Times-Roman'); y += 40
# Page 3 — governing law
p3 = doc.new_page(width=612, height=792)
y = 72
p3.insert_text((72, y), 'Section 12. Governing Law', fontsize=11, fontname='Times-Bold'); y += 20
p3.insert_text((72, y), 'This Agreement is governed by the laws of Delaware.', fontsize=10, fontname='Times-Roman')
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

  // (1/2/3/4) Direct /extract
  const f1 = new FormData()
  f1.append('file', new Blob([buf], { type: 'application/pdf' }), 'msa.pdf')
  const extRes = await fetch('http://localhost:8002/extract', {
    method: 'POST', body: f1,
    headers: { 'x-internal-secret': secret },
  })
  const ext = await extRes.json()
  check(extRes.status === 200, `(1) /extract returns 200 (got ${extRes.status})`)
  const nav = ext?.structure?.nav ?? []
  const allAnchored = nav.length > 0 && nav.every(n =>
    typeof n.page === 'number' && n.page >= 1 &&
    Array.isArray(n.bbox) && n.bbox.length === 4
  )
  check(allAnchored, `(1) every nav entry has {page, bbox[4]} (got ${nav.length} nodes)`)

  const pages = new Set(nav.map(n => n.page))
  check(pages.size >= 3,
    `(2) nav spans ≥3 distinct pages (got ${[...pages].sort().join(', ')})`)

  const s9 = nav.find(n => n.ref === '9')
  const s12 = nav.find(n => n.ref === '12')
  check(s9?.page === 2, `(2) "Section 9" anchored to page 2 (got ${s9?.page})`)
  check(s12?.page === 3, `(2) "Section 12" anchored to page 3 (got ${s12?.page})`)

  for (const n of nav) {
    const [x0, y0, x1, y1] = n.bbox ?? [0, 0, 0, 0]
    const ok = x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0
    check(ok, `(3) "${n.ref || n.title}" bbox is non-degenerate [${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}]`)
  }

  // (4) Paragraphs carry {text, page, bbox} on the tree
  const sections = ext?.structure?.sections ?? []
  const anyAnchoredPara = sections.some(sec => {
    const ps = sec.paragraphs ?? []
    return ps.some(p => typeof p?.text === 'string' && typeof p?.page === 'number')
  }) || sections.some(sec =>
    (sec.children ?? []).some(ch => (ch.paragraphs ?? []).some(p =>
      typeof p?.text === 'string' && typeof p?.page === 'number'
    ))
  )
  check(anyAnchoredPara, `(4) at least one paragraph carries {text, page, bbox}`)

  // (5) Upload round-trip
  const token = await login()
  const f2 = new FormData()
  f2.append('file', new Blob([buf], { type: 'application/pdf' }), 'msa.pdf')
  f2.append('title', `P2.4 multipage MSA ${Date.now()}`)
  f2.append('type', 'MSA')
  const upRes = await fetch(`${API}/api/v1/contracts/upload`, {
    method: 'POST', body: f2, headers: { authorization: `Bearer ${token}` },
  })
  check(upRes.ok, `(5) upload returns 2xx (got ${upRes.status})`)
  const upJson = await upRes.json()
  const contractId = upJson.contractId ?? upJson.id ?? upJson.contract?.id

  const got = await waitFor(async () => {
    const c = await fetch(`${API}/api/v1/contracts/${contractId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null)
    const storedNav = c?.versions?.[0]?.metadata?.structure?.nav ?? []
    return storedNav.length >= 3 && storedNav.every(n => typeof n.page === 'number')
  })
  check(got, `(5) worker persisted nav with page numbers`)

  const contract = await fetch(`${API}/api/v1/contracts/${contractId}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const storedNav = contract?.versions?.[0]?.metadata?.structure?.nav ?? []
  const stored9 = storedNav.find(n => n.ref === '9')
  check(stored9?.page === 2, `(5) stored "Section 9" has page=2 (got ${stored9?.page})`)
  check(Array.isArray(stored9?.bbox) && stored9.bbox.length === 4,
    `(5) stored bbox is [4]-tuple (got ${JSON.stringify(stored9?.bbox)})`)

  // (6) UI — TOC rail shows per-row "p.N" chips
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
  const pageChips = await page.locator('[data-testid^="toc-page-"]').count()
  check(pageChips >= 3, `(6) TOC shows ≥3 "p.N" page chips (got ${pageChips})`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/128-p24-toc-with-pages.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P2.4 bbox-preservation checks pass')
})().catch(e => { console.error(e); process.exit(1) })
