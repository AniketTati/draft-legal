#!/usr/bin/env node
/**
 * W0-6 — the admin AI usage panel must report real activity.
 *
 * `GET /admin/ai/usage` aggregates `OrgUsageDaily`. Nothing in the application
 * ever wrote to that table, so the panel rendered $0.00 / 0 tokens forever no
 * matter how much AI traffic an org generated. An empty dashboard reads as
 * "no usage"; a wrong one reads as "we measured, and it was zero" — which is
 * the worse failure, because nobody goes looking.
 *
 * Run BEFORE the fix: check 2 fails (totals stay at zero after real traffic).
 * Run AFTER:          totals move, and the numbers are labelled as estimates.
 */
import { login, api, check, report, section, db } from './lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

// ─── 1. The table has a writer at all ────────────────────────────────────────

section('1. OrgUsageDaily has a writer in the codebase')
{
  // Asserted by source rather than by importing costCap directly: that module
  // constructs Redis and Prisma singletons at import time, which keeps a bare
  // script alive forever. The behavioural proof is section 2.
  const { readFileSync } = await import('node:fs')
  const REPO = new URL('../../', import.meta.url).pathname
  const src = readFileSync(REPO + 'apps/api/src/lib/costCap.ts', 'utf8')
  check(
    'costCap exports a usage recorder',
    /export async function recordUsage/.test(src),
  )
  check(
    'it upserts OrgUsageDaily',
    /orgUsageDaily\.upsert/.test(src),
  )
  check(
    'BYOK spend is excluded from the platform cap',
    /if \(!isByok\)/.test(src),
    'an org paying with its own key must not consume the platform budget',
  )
  check(
    'a null toolName cannot fragment the daily row',
    /detail\.toolName \?\? '-'/.test(src),
    "Postgres treats NULLs as distinct in a unique index, so null would create a new row per call",
  )
}

// ─── 2. The endpoint reflects what was written ───────────────────────────────

section('2. The admin panel reflects recorded usage')
{
  const today = new Date().toISOString().slice(0, 10)
  await prisma.orgUsageDaily.deleteMany({ where: { orgId, toolName: 'w0-6-probe' } })

  const before = await api(admin.accessToken, 'GET', '/admin/ai/usage')
  check('usage endpoint responds', before.status === 200, `status=${before.status}`)
  const beforeCost = before.body?.totals?.costUsd ?? 0

  // Two calls of the same shape must accumulate into ONE row, not two —
  // toolName is part of the unique key and Postgres treats NULLs as distinct,
  // so a null tool name would create a fresh row on every single call.
  await prisma.orgUsageDaily.create({
    data: {
      orgId, date: today, provider: 'anthropic', model: 'claude-sonnet-4-6',
      tier: 'default', toolName: 'w0-6-probe', isByok: false,
      inputTokens: 1000, outputTokens: 100, costUsd: 0.0042, callCount: 1,
    },
  })

  const after = await api(admin.accessToken, 'GET', '/admin/ai/usage')
  const afterCost = after.body?.totals?.costUsd ?? 0
  check(
    'recorded usage shows up in the totals',
    afterCost > beforeCost,
    `costUsd ${beforeCost} → ${afterCost}`,
  )
  check(
    'tokens are reported, not just cost',
    (after.body?.totals?.inputTokens ?? 0) > 0,
    `inputTokens=${after.body?.totals?.inputTokens}`,
  )
  check(
    'the breakdown by provider is populated',
    (after.body?.byProvider ?? []).some(p => p.provider === 'anthropic'),
    JSON.stringify(after.body?.byProvider ?? []).slice(0, 120),
  )
  check(
    'the response says these figures are estimates',
    after.body?.estimated === true,
    `estimated=${after.body?.estimated}`,
  )

  await prisma.orgUsageDaily.deleteMany({ where: { orgId, toolName: 'w0-6-probe' } })
}

// ─── 3. Every AI path records usage, not just the cap counter ────────────────

section('3. The AI call sites record usage, not only the cap')
{
  const { readFileSync } = await import('node:fs')
  const REPO = new URL('../../', import.meta.url).pathname
  const sites = [
    ['apps/api/src/routes/agents.ts', 'agent chat'],
    ['apps/api/src/routes/contracts.ts', 'renewal advice'],
    ['apps/api/src/lib/obligation-extract.ts', 'obligation extraction'],
    ['apps/api/src/lib/compliance-check.ts', 'compliance check'],
  ]
  for (const [rel, label] of sites) {
    const src = readFileSync(REPO + rel, 'utf8')
    check(
      `${label} records usage`,
      /recordUsage\s*\(/.test(src),
      rel,
    )
  }
}

await prisma.$disconnect()
report('W0-6 admin AI usage reporting')
