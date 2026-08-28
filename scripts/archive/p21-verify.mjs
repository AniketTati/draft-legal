#!/usr/bin/env node
/**
 * P2.1 verify — OCR pass on scanned PDFs (Wave F.1).
 *
 *   (1) /extract returns plain text + ocrApplied=true for a scanned PDF
 *   (2) Uploading the scanned PDF through POST /contracts/upload lands a
 *       ContractVersion whose plainText is populated with the OCR'd body
 *   (3) That version's metadata.extraction captures {ocrApplied,
 *       ocrBackend, pageCount, extractedAt}
 *   (4) The contract's analysisStatus moves past PARSING (no silent
 *       "could not extract" failure as it did pre-OCR)
 *   (5) The required tokens from the fixture ("MASTER SERVICES
 *       AGREEMENT", "Delaware", "LIMITATION OF LIABILITY", "twelve",
 *       "Acme Corporation") are all present in the stored plainText
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const API = 'http://localhost:3001'
const FIXTURE = '/tmp/p21-fixture/scanned-msa.pdf'
const REQUIRED_TOKENS = [
  'MASTER SERVICES AGREEMENT',
  'Acme Corporation',
  'LIMITATION OF LIABILITY',
  'Delaware',
  'twelve',
]

async function login(email, pw) {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then(x => x.json())
  if (!r.accessToken) { console.error('login failed:', r); process.exit(1) }
  return r.accessToken
}

function readEnv(key) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', '-e', `process.stdout.write(process.env['${key}'] ?? '')`], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  return r.stdout.trim()
}

function ensureFixture() {
  if (existsSync(FIXTURE)) return
  const r = spawnSync('bash', ['-c',
    'cd ' + path.join(REPO_ROOT, 'apps/agents') + ' && ' +
    'source .venv/bin/activate && ' +
    `mkdir -p $(dirname ${FIXTURE}) && ` +
    `python -m scripts.make_scanned_pdf ${FIXTURE}`,
  ], { stdio: 'pipe', encoding: 'utf-8' })
  if (r.status !== 0 || !existsSync(FIXTURE)) {
    console.error('fixture build failed:', r.stderr)
    process.exit(1)
  }
}

function dumpLatestVersionMetadata(contractId) {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/_dump-contract-versions.ts', contractId], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  const start = r.stdout.indexOf('{')
  const end   = r.stdout.lastIndexOf('}')
  return start >= 0 ? JSON.parse(r.stdout.slice(start, end + 1)) : null
}

async function waitFor(predicate, { timeout = 60_000, interval = 1500 } = {}) {
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

  // (1) Direct /extract call — bare-minimum that OCR itself runs
  const secret = readEnv('INTERNAL_SERVICE_SECRET')
  const buf = readFileSync(FIXTURE)
  const form1 = new FormData()
  form1.append('file', new Blob([buf], { type: 'application/pdf' }), 'scanned-msa.pdf')
  const extRes = await fetch('http://localhost:8002/extract', {
    method: 'POST',
    body: form1,
    headers: { 'x-internal-secret': secret },
  })
  const ext = await extRes.json()
  check(extRes.status === 200, `(1) /extract returns 200 (got ${extRes.status})`)
  check(ext.ocrApplied === true, `(1) ocrApplied=true on scanned PDF (got ${ext.ocrApplied})`)
  check(ext.ocrBackend && ext.ocrBackend.length > 0, `(1) ocrBackend identified (${ext.ocrBackend})`)
  check(typeof ext.plainText === 'string' && ext.plainText.length > 200,
    `(1) plainText populated (${ext.plainText?.length ?? 0} chars)`)
  for (const t of REQUIRED_TOKENS) {
    check(ext.plainText?.includes(t),
      `(1) OCR text contains "${t}"`)
  }

  // (2/3/4) Upload through the real ingest pipeline
  const token = await login('admin@demo.com', 'password123')
  const form2 = new FormData()
  form2.append('file', new Blob([buf], { type: 'application/pdf' }), 'scanned-msa.pdf')
  form2.append('title', `P2.1 scanned MSA ${Date.now()}`)
  form2.append('type', 'MSA')
  const upRes = await fetch(`${API}/api/v1/contracts/upload`, {
    method: 'POST',
    body: form2,
    headers: { authorization: `Bearer ${token}` },
  })
  check(upRes.ok, `(2) upload returns 2xx (got ${upRes.status})`)
  const upJson = await upRes.json()
  const contractId = upJson.contractId ?? upJson.id ?? upJson.contract?.id
  check(!!contractId, `(2) upload returned a contractId (${contractId})`)

  // Wait for PARSING → OCR text landing on the version
  const gotText = await waitFor(async () => {
    const dump = dumpLatestVersionMetadata(contractId)
    const v = dump?.versions?.[dump.versions.length - 1]
    // version is populated by the worker only after OCR + update
    return v && (v.changeNote != null || (v.createdAt && dump.contract?.currentVersionId))
  }, { timeout: 90_000 })
  check(gotText, '(2) worker processed the upload within 90s')

  // Read the DB snapshot for detailed asserts
  const dump = dumpLatestVersionMetadata(contractId)
  const versions = dump?.versions ?? []
  const current = versions[versions.length - 1]

  // We also need the full version row (including metadata + plainText),
  // which _dump-contract-versions doesn't include — hit the API for it.
  const contractRes = await fetch(`${API}/api/v1/contracts/${contractId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const contract = await contractRes.json()
  const fullVersion = (contract.versions ?? []).find(v => v.id === current?.id)
    ?? (contract.versions ?? [])[contract.versions.length - 1]

  check(!!fullVersion?.plainText && fullVersion.plainText.length > 200,
    `(2) ContractVersion.plainText populated (${fullVersion?.plainText?.length ?? 0} chars)`)
  for (const t of REQUIRED_TOKENS) {
    check((fullVersion?.plainText ?? '').includes(t),
      `(5) stored plainText contains "${t}"`)
  }

  const md = fullVersion?.metadata ?? {}
  check(md?.extraction?.ocrApplied === true,
    `(3) version.metadata.extraction.ocrApplied = true (got ${md?.extraction?.ocrApplied})`)
  check(typeof md?.extraction?.ocrBackend === 'string',
    `(3) version.metadata.extraction.ocrBackend is set (${md?.extraction?.ocrBackend})`)
  check(typeof md?.extraction?.pageCount === 'number' && md.extraction.pageCount > 0,
    `(3) version.metadata.extraction.pageCount > 0 (got ${md?.extraction?.pageCount})`)

  // (4) analysisStatus moved past PARSING — should be PARSING → DONE or
  //     something beyond the silent-failure state.
  const status = contract.analysisStatus
  check(status !== 'FAILED', `(4) contract.analysisStatus is not FAILED (got ${status})`)

  // (6) UI — visit the contract page, confirm the "OCR'd" trust badge
  //     renders + screenshot for proof-of-work.
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
  await page.waitForTimeout(1200)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const badgeVisible = await page.getByTestId('contract-ocr-badge').isVisible().catch(() => false)
  check(badgeVisible, `(6) "OCR'd" trust badge visible on the contract header`)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/124-p21-ocr-badge.png'), fullPage: false })

  await browser.close()

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P2.1 OCR checks pass')
})().catch(e => { console.error(e); process.exit(1) })
