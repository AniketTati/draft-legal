#!/usr/bin/env node
/**
 * P3.1 verify — contract_cite + citation pills + section highlight.
 *
 *   (1) Upload a multi-page PDF → wait for structure to persist
 *   (2) Direct /tools/contract_cite for "liability" returns citations
 *       with {quote, page, bbox, sectionRef, sectionTitle}
 *   (3) Exact-substring query gets an `exact: true` hit
 *   (4) UI — inject a contract_cite tool result into the rail →
 *       CitationPills renders with clickable links to
 *       /contracts/:id?section=9.2
 *   (5) Navigating to that URL with ?section=9.2 → the TOC entry
 *       for §9.2 flashes + the editor scrolls to it (we verify by
 *       checking the TOC entry carries the ring/bg-blue classes
 *       for at least 1s after arrival)
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const API = 'http://localhost:3001'
const FIXTURE = '/tmp/p24-fixture/multipage-msa.pdf'   // reuse P2.4 fixture

function readEnv(key) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', '-e', `process.stdout.write(process.env['${key}'] ?? '')`], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return r.stdout.trim()
}

function callTool(name, body) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_call-tool.ts', name, JSON.stringify(body)], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
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
  // Ensure the P2.4 fixture exists (it's the multipage MSA with §9.2)
  if (!existsSync(FIXTURE)) {
    const r = spawnSync('bash', ['-c',
      'cd ' + REPO_ROOT + ' && node scripts/p24-verify.mjs',
    ], { stdio: 'inherit' })
    if (r.status !== 0) { console.error('p24 fixture generate failed'); process.exit(1) }
  }

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const token = await login()
  const buf = readFileSync(FIXTURE)

  // (1) Upload
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'application/pdf' }), 'msa.pdf')
  form.append('title', `P3.1 multipage MSA ${Date.now()}`)
  form.append('type', 'MSA')
  const upRes = await fetch(`${API}/api/v1/contracts/upload`, {
    method: 'POST', body: form, headers: { authorization: `Bearer ${token}` },
  })
  check(upRes.ok, `(1) upload returns 2xx (got ${upRes.status})`)
  const upJson = await upRes.json()
  const contractId = upJson.contractId ?? upJson.id ?? upJson.contract?.id

  const ready = await waitFor(async () => {
    const c = await fetch(`${API}/api/v1/contracts/${contractId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null)
    return Array.isArray(c?.versions?.[0]?.metadata?.structure?.nav) &&
      c.versions[0].metadata.structure.nav.length >= 3
  })
  check(ready, `(1) structure persisted within 90s`)

  const demoOrgId = (await fetch(`${API}/api/v1/contracts/${contractId}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())).orgId

  // (2) Direct /tools/contract_cite
  const r = callTool('contract_cite', {
    orgId: demoOrgId, contractId, query: 'liability', limit: 5,
  })
  check(r.status === 200, `(2) contract_cite returns 200 (got ${r.status})`)
  const citations = r.body?.citations ?? []
  check(citations.length >= 1,
    `(2) ≥1 citation returned (got ${citations.length})`)
  const liability = citations.find(c => /liability/i.test(c.sectionTitle ?? ''))
  check(!!liability, `(2) at least one citation is the Liability section`)
  check(typeof liability?.page === 'number',
    `(2) citation carries page number (got ${liability?.page})`)
  check(Array.isArray(liability?.bbox) && liability.bbox.length === 4,
    `(2) citation carries bbox[4] (got ${JSON.stringify(liability?.bbox)})`)
  check(typeof liability?.sectionRef === 'string',
    `(2) citation carries sectionRef "${liability?.sectionRef}"`)

  // (3) Exact substring hit
  const rExact = callTool('contract_cite', {
    orgId: demoOrgId, contractId, query: 'Limitation of Liability', limit: 3,
  })
  const anyExact = (rExact.body?.citations ?? []).some(c => c.exact === true)
  check(anyExact, `(3) query "Limitation of Liability" yields an exact-substring hit`)

  // (4/5) UI — inject a citation result + verify pills + navigation
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
  await page.evaluate(() => {
    localStorage.setItem('feature:AGENT_SIDE_PANEL_V2', '1')
    localStorage.setItem('side-agent-rail:open', '1')
  })

  await page.goto(`http://localhost:5173/contracts/${contractId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  // Seed an assistant turn, then inject the citation tool result
  await page.getByTestId('side-agent-composer').fill('Show me where liability is defined')
  await page.getByTestId('side-agent-send').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="side-agent-composer"]')?.hasAttribute('disabled'),
    { timeout: 90_000 }
  )
  await page.waitForTimeout(700)

  await page.evaluate((bundle) => {
    window.dispatchEvent(new CustomEvent('rail-inject-tool-result', {
      detail: {
        id: 'tc_synth_cite',
        name: 'contract_cite',
        args: { contractId: bundle.contractId, query: 'liability' },
        status: 'ok',
        resultPreview: JSON.stringify(bundle),
        citationBundle: bundle,
      },
    }))
  }, r.body)
  await page.waitForTimeout(600)

  const pills = page.getByTestId('citation-pills')
  check(await pills.isVisible(), `(4) citation pills render inline in the rail`)
  const pillCount = await page.locator('[data-testid^="citation-link-"]').count()
  check(pillCount >= 1, `(4) ≥1 citation link rendered (got ${pillCount})`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/130-p31-citation-pills.png'),
    fullPage: false,
  })

  // (5) Navigate to ?section=9.2 → TOC entry for §9.2 should gain the
  //     flash classes briefly. Wait for the TOC to mount (the rail
  //     section is defaultOpen but React-mounted lazily).
  await page.goto(`http://localhost:5173/contracts/${contractId}?section=9.2`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2_000)
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
  // Some page layouts collapse the rail on narrow viewports; force-scroll
  // into view so the TOC mounts.
  await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (aside) aside.scrollIntoView()
  })
  // TOC must render (P2.2 integration) — stored structure has to be
  // there, otherwise the TOC block renders nothing.
  const tocExists = await page.getByTestId('contract-toc').count()
  if (tocExists === 0) {
    // Debug breadcrumb: dump what the page thinks about structure.
    const storedNavLen = await page.evaluate(async () => {
      try {
        const token = JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken
        const m = window.location.pathname.match(/\/contracts\/([^?]+)/)
        if (!token || !m) return 'no-auth'
        const c = await fetch(`/api/v1/contracts/${m[1]}`, {
          headers: { authorization: `Bearer ${token}` },
        }).then(r => r.json())
        return c?.versions?.[0]?.metadata?.structure?.nav?.length ?? -1
      } catch (e) { return String(e).slice(0, 80) }
    })
    console.log('  [debug] stored nav length from browser side:', storedNavLen)
  }
  await page.getByTestId('contract-toc').waitFor({ state: 'visible', timeout: 20_000 })
  const refSet = await page.$$eval(
    '[data-testid^="toc-item-"]',
    els => els.map(e => e.getAttribute('data-ref')).filter(Boolean),
  )
  check(refSet.includes('9.2'),
    `(5) TOC renders an entry with data-ref="9.2" (refs: ${refSet.join(', ')})`)
  // The highlight class is applied by the useEffect's inner
  // setTimeout(350ms); it's cleared 2200ms after that. Poll for a
  // 1.5-second window starting immediately, so we catch the flash.
  const flashed = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid^="toc-item-"][data-ref="9.2"]')
    if (!el) return false
    const deadline = Date.now() + 1800
    while (Date.now() < deadline) {
      if (el.classList.contains('bg-blue-100') || el.classList.contains('ring-2')) return true
      await new Promise(r => setTimeout(r, 60))
    }
    return false
  })
  check(flashed, `(5) ?section=9.2 causes the matching TOC row to flash`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/131-p31-section-highlight.png'),
    fullPage: false,
  })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P3.1 contract_cite + citation-pill checks pass')
})().catch(e => { console.error(e); process.exit(1) })
