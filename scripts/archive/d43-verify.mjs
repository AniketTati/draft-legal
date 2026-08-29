#!/usr/bin/env node
/**
 * D.4.3 verify — Skills admin page.
 *
 *   (1) /admin/skills renders the 9 built-in rows
 *   (2) Search narrows the list
 *   (3) Edit drawer opens, prompt is editable, save bumps the version
 *   (4) Create drawer spins up a new org skill with a custom slug
 *   (5) That new org skill shows up on GET /skills with ownerType='org'
 *   (6) Editing a built-in's systemPrompt via the drawer bumps its
 *       `version` column so future invocations snapshot the new prompt
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-skills.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr); process.exit(1) }
}

async function login(page) {
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', 'admin@demo.com')
  await page.fill('input[type="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15_000 })
}

;(async () => {
  // Also drop any org-created skills from prior runs
  spawnSync('pnpm', ['tsx', '--env-file=.env', '-e', `
    import { PrismaClient } from '@prisma/client'
    const p = new PrismaClient()
    await p.skillInvocation.deleteMany({ where: { skill: { ownerType: 'org' } } })
    await p.skill.deleteMany({ where: { ownerType: 'org' } })
    await p.$disconnect()
  `.replace(/\n/g, ' ')], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  reseed()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', d => d.accept().catch(() => {}))

  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  await login(page)
  await page.goto('http://localhost:5173/admin/skills', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_200)

  // (1) 9 built-in rows rendered
  const rows = await page.locator('[data-testid^="admin-skill-row-"]').count()
  check(rows >= 9, `(1) admin page lists all skills (got ${rows})`)

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/97-d43-admin-skills-list.png'), fullPage: false })

  // (2) Search narrows
  await page.getByTestId('admin-skills-search').fill('draft')
  await page.waitForTimeout(250)
  const narrowed = await page.locator('[data-testid^="admin-skill-row-"]').count()
  check(narrowed >= 2 && narrowed <= 4, `(2) searching 'draft' narrows to 2-4 rows (got ${narrowed})`)
  await page.getByTestId('admin-skills-search').fill('')
  await page.waitForTimeout(200)

  // (3) Edit @review-contract — bump the description + verify version bump
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('clm-auth') ?? '{}').state?.accessToken ?? null }
    catch { return null }
  })
  const pre = await fetch(`${API}/api/v1/skills`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
  const reviewPre = pre.skills.find(s => s.slug === '@review-contract')
  const versionBefore = reviewPre?.version ?? 0

  await page.getByTestId('admin-skill-edit-review-contract').click()
  await page.getByTestId('admin-skill-edit-drawer').waitFor({ state: 'visible', timeout: 5_000 })

  // Edit the systemPrompt (requires admin — the redacted "[hidden]" only
  // appears for non-admin). Append a sentinel string.
  const promptField = page.getByTestId('admin-skill-edit-prompt')
  const current = await promptField.inputValue()
  check(current.length > 80, `(3) prompt is loaded + editable (got ${current.length} chars)`)
  const sentinel = `\n\n[D.4.3 verify marker ${Date.now()}]`
  await promptField.fill(current + sentinel)
  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/98-d43-admin-skill-edit.png'), fullPage: false })

  await page.getByTestId('admin-skill-edit-save').click()
  await page.waitForTimeout(1_200)

  const post = await fetch(`${API}/api/v1/skills`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
  const reviewPost = post.skills.find(s => s.slug === '@review-contract')
  check(reviewPost?.version === versionBefore + 1, `(3) edit bumped version ${versionBefore} → ${reviewPost?.version}`)

  // Also confirm the systemPrompt actually persisted
  const reviewDetail = await fetch(`${API}/api/v1/skills/${reviewPost.id}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json())
  check(reviewDetail.systemPrompt.includes(sentinel.trim()), '(3) saved prompt contains sentinel string')

  // (4) Create a new org skill
  await page.getByTestId('admin-skills-create').click()
  await page.getByTestId('admin-skill-create-drawer').waitFor({ state: 'visible', timeout: 5_000 })
  const orgSlug = `@e2e-${Date.now()}`
  await page.getByTestId('admin-skill-create-name').fill('E2E verify skill')
  await page.getByTestId('admin-skill-create-slug').fill(orgSlug)
  await page.getByTestId('admin-skill-create-description').fill('A test skill created by the D.4.3 verify script.')
  await page.getByTestId('admin-skill-create-scope').selectOption('dashboard')
  await page.getByTestId('admin-skill-create-tools').fill('contract_search')
  await page.getByTestId('admin-skill-create-prompt').fill('You are the D.4.3 verify skill. Say hello and stop — this prompt exists only for testing.')
  await page.getByTestId('admin-skill-create-submit').click()
  await page.waitForTimeout(1_000)

  // (5) Org skill visible on GET /skills with ownerType='org'
  const withOrg = await fetch(`${API}/api/v1/skills`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
  const created = withOrg.skills.find(s => s.slug === orgSlug)
  check(!!created, `(5) new org skill ${orgSlug} visible in GET /skills`)
  check(created?.ownerType === 'org', `(5) new skill ownerType=org (got ${created?.ownerType})`)
  check(created?.contextScope === 'dashboard', `(5) scope persisted (${created?.contextScope})`)

  await page.screenshot({ path: path.join(REPO_ROOT, 'scripts/screenshots/desktop/99-d43-admin-skill-created.png'), fullPage: false })

  await browser.close()
  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log('\n✓ All D.4.3 admin-page checks pass')
})().catch(e => { console.error(e); process.exit(1) })
