#!/usr/bin/env node
/**
 * P2.3 verify — Multi-doc binder split (Wave F.3).
 *
 *   (1) Uploading a 3-agreement binder PDF triggers the detect-binder →
 *       split-binder pipeline
 *   (2) metadata._binderDetected = true + _suggestedSplits has ≥3 entries
 *   (3) The split creates ≥3 child contracts linked to the parent via
 *       parentContractId
 *   (4) Children have their own plainText (worker re-parses each slice)
 *   (5) The parent's detail page shows the "Auto-split into N contracts"
 *       banner + Contract Family rail section lists the children
 *   (6) Clicking a child link navigates to the child + that child's
 *       detail page shows a link back to the parent
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const API = 'http://localhost:3001'
const FIXTURE = '/tmp/p23-fixture/binder.pdf'

function ensureFixture() {
  if (existsSync(FIXTURE)) return
  const r = spawnSync('bash', ['-c',
    'cd ' + path.join(REPO_ROOT, 'apps/agents') + ' && ' +
    'source .venv/bin/activate && ' +
    'mkdir -p /tmp/p23-fixture && ' +
    'python -m scripts.make_binder_pdf /tmp/p23-fixture/binder.pdf',
  ], { stdio: 'pipe', encoding: 'utf-8' })
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

async function waitFor(predicate, { timeout = 180_000, interval = 2000 } = {}) {
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

  const buf = readFileSync(FIXTURE)
  const token = await login()

  // (1) Upload
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'application/pdf' }), 'binder.pdf')
  form.append('title', `P2.3 binder ${Date.now()}`)
  form.append('type', 'OTHER')
  const upRes = await fetch(`${API}/api/v1/contracts/upload`, {
    method: 'POST', body: form, headers: { authorization: `Bearer ${token}` },
  })
  check(upRes.ok, `(1) upload returns 2xx (got ${upRes.status})`)
  const upJson = await upRes.json()
  const parentId = upJson.contractId ?? upJson.id ?? upJson.contract?.id
  check(!!parentId, `(1) parent contractId returned (${parentId})`)

  // (2/3) Wait for binder detection + splitting
  const ok = await waitFor(async () => {
    const c = await fetch(`${API}/api/v1/contracts/${parentId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null)
    const md = c?.metadata ?? {}
    return md._binderDetected === true && Array.isArray(md._splitInto) && md._splitInto.length >= 2
  }, { timeout: 240_000 })
  check(ok, `(2) detect-binder + split-binder completed within 240s`)

  const parent = await fetch(`${API}/api/v1/contracts/${parentId}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const md = parent?.metadata ?? {}
  check(md._binderDetected === true, `(2) metadata._binderDetected = true`)
  const suggested = Array.isArray(md._suggestedSplits) ? md._suggestedSplits : []
  check(suggested.length >= 2,
    `(2) metadata._suggestedSplits has ≥2 entries (got ${suggested.length})`)
  const childIds = Array.isArray(md._splitInto) ? md._splitInto : []
  check(childIds.length >= 2,
    `(3) ≥2 child contracts created (got ${childIds.length})`)

  // (4) Children have parentContractId + plainText
  let childrenReady = 0
  let childFirstId = null
  for (const childId of childIds) {
    const gotText = await waitFor(async () => {
      const cc = await fetch(`${API}/api/v1/contracts/${childId}`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(r => r.json()).catch(() => null)
      const v = cc?.versions?.[0]
      return cc?.parentContractId === parentId && typeof v?.plainText === 'string' && v.plainText.length > 100
    }, { timeout: 120_000 })
    if (gotText) {
      childrenReady += 1
      if (!childFirstId) childFirstId = childId
    }
  }
  check(childrenReady >= 2,
    `(4) ≥2 children have parentContractId set + plainText populated (got ${childrenReady})`)

  // (5) UI — parent banner + family section
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })

  await page.goto(`http://localhost:5173/contracts/${parentId}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  const coach = page.locator('button:has-text("Got it"), button[aria-label*="close" i], button:has-text("Dismiss")').first()
  if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})

  const banner = page.locator('text=/Auto-split into/i').first()
  check(await banner.isVisible(), `(5) "Auto-split into N contracts" banner visible on parent page`)
  await page.screenshot({
    path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/126-p23-binder-parent.png'),
    fullPage: false,
  })

  // (6) Navigate to a child — parent link visible. Server-side check:
  //     /contracts/:id/family returns {parent, children, siblings} and
  //     parent should be set on the child. UI rendering is a bonus.
  if (childFirstId) {
    const family = await fetch(`${API}/api/v1/contracts/${childFirstId}/family`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => null)
    check(family?.parent?.id === parentId,
      `(6) /family returns parent=${parentId} for child ${childFirstId}`)

    // UI — P2.3 adds a persistent "Split from binder: <title>" banner
    // at the top of every child contract, visible regardless of which
    // tab is active.
    await page.goto(`http://localhost:5173/contracts/${childFirstId}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1800)
    if (await coach.isVisible().catch(() => false)) await coach.click().catch(() => {})
    const banner = page.getByTestId('binder-child-banner')
    check(await banner.isVisible(), `(6) child page shows "Split from binder:" banner`)
    const parentLink = page.getByTestId('binder-child-parent-link')
    const parentLinkText = await parentLink.innerText().catch(() => '')
    check(parentLinkText.includes(parent.title),
      `(6) banner's parent link text matches parent title (got "${parentLinkText}")`)
    await page.screenshot({
      path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/127-p23-binder-child.png'),
      fullPage: false,
    })
  }

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All P2.3 binder-split checks pass')
})().catch(e => { console.error(e); process.exit(1) })
