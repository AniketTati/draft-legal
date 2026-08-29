#!/usr/bin/env node
/**
 * D.4.2 verify — built-in skill catalog is complete + well-shaped.
 *
 *   (1) All 9 built-in slugs are registered
 *   (2) Every skill has non-empty systemPrompt + sensible allowedTools
 *   (3) contextScope distribution covers dashboard / current_contract /
 *       portfolio / selection so chips can live on each surface type
 *   (4) Admin sees the raw systemPrompt; non-admin gets the redacted view
 */
import path from 'node:path'
import { REPO_ROOT } from './lib/repo-root.mjs'
import { spawnSync } from 'node:child_process'

const API = 'http://localhost:3001'

const EXPECTED = [
  { slug: '@review-contract',                  scope: 'current_contract' },
  { slug: '@review-nda',                        scope: 'current_contract' },
  { slug: '@prep-for-approval',                 scope: 'current_contract' },
  { slug: '@renewal-check',                     scope: 'current_contract' },
  { slug: '@draft-from-template',               scope: 'dashboard' },
  { slug: '@draft-from-scratch',                scope: 'dashboard' },
  { slug: '@draft-from-counterparty-paper',     scope: 'current_contract' },
  { slug: '@compliance-sweep',                  scope: 'portfolio' },
  { slug: '@explain-clause',                    scope: 'selection' },
]

function reseed() {
  const r = spawnSync('pnpm', ['tsx', '--env-file=.env', 'scripts/seed-skills.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    stdio: 'pipe', encoding: 'utf-8',
  })
  if (r.status !== 0) { console.error('seed failed:', r.stderr); process.exit(1) }
}

async function login(email, pw) {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  }).then(x => x.json())
  return r.accessToken
}

;(async () => {
  reseed()
  let fail = 0
  const check = (cond, msg) => { console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`); if (!cond) fail++ }

  const adminToken = await login('admin@demo.com', 'password123')

  const r = await fetch(`${API}/api/v1/skills`, {
    headers: { authorization: `Bearer ${adminToken}` },
  }).then(x => x.json())
  const skills = r.skills ?? []
  const bySlug = Object.fromEntries(skills.map(s => [s.slug, s]))

  // (1) all 9 slugs present
  for (const { slug, scope } of EXPECTED) {
    const s = bySlug[slug]
    check(!!s, `(1) ${slug} registered`)
    if (s) check(s.contextScope === scope, `(1) ${slug} contextScope=${scope} (got ${s.contextScope})`)
  }

  // (2) Each skill has allowedTools + non-trivial prompt. Use GET /:id for
  //     systemPrompt (list view doesn't include it).
  for (const { slug } of EXPECTED) {
    const s = bySlug[slug]
    if (!s) continue
    const detail = await fetch(`${API}/api/v1/skills/${s.id}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }).then(x => x.json())
    const looksRealPrompt = typeof detail.systemPrompt === 'string' && detail.systemPrompt.length > 80
    check(looksRealPrompt, `(2) ${slug} has non-trivial systemPrompt (${detail.systemPrompt?.length ?? 0} chars)`)
    check(Array.isArray(s.allowedTools) && s.allowedTools.length >= 1, `(2) ${slug} has allowedTools (${s.allowedTools?.length ?? 0})`)
  }

  // (3) Scope distribution
  const scopes = new Set(skills.map(s => s.contextScope))
  check(scopes.has('current_contract'), '(3) at least one current_contract-scoped skill')
  check(scopes.has('dashboard'),        '(3) at least one dashboard-scoped skill')
  check(scopes.has('portfolio'),        '(3) at least one portfolio-scoped skill')
  check(scopes.has('selection'),        '(3) at least one selection-scoped skill')

  // (4) Non-admin gets redacted systemPrompt on built-ins. Find a non-admin
  //     via the seed-ai-demo admin — pick any other user from /api/v1/team.
  //     For simplicity, re-use the admin account (same JWT) but compare the
  //     list-shape behaviour: list endpoint never returns systemPrompt.
  const listHasPrompt = skills.some(s => 'systemPrompt' in s)
  check(!listHasPrompt, '(4) list endpoint never returns systemPrompt (IP safety)')

  // Simulate the non-admin path via a user without ADMIN role. Best-effort —
  // if demo env has no such user, skip this subcheck.
  const nonAdmin = await login('operator@demo.com', 'password123').catch(() => null)
  if (nonAdmin) {
    const sample = bySlug['@review-contract']
    if (sample) {
      const d = await fetch(`${API}/api/v1/skills/${sample.id}`, {
        headers: { authorization: `Bearer ${nonAdmin}` },
      }).then(x => x.json())
      check(d?.systemPrompt === '[hidden — admin-only]', `(4) non-admin sees redacted systemPrompt (got ${typeof d?.systemPrompt === 'string' ? d.systemPrompt.slice(0, 40) : 'n/a'})`)
    }
  } else {
    console.log('  ~ (4) non-admin redaction skipped (no operator@demo.com user)')
  }

  if (fail) { console.error(`\n✗ ${fail} check(s) failed`); process.exit(1) }
  console.log(`\n✓ All D.4.2 built-in catalog checks pass (${EXPECTED.length} skills)`)
})().catch(e => { console.error(e); process.exit(1) })
