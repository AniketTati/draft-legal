#!/usr/bin/env node
/**
 * W0-3 — an org that brings its own API key must actually have it used.
 *
 * Every specialist agent built its LLM with
 * `build_llm(active_provider(), active_model()/smart_model())`, which reads the
 * platform key from env and never consults the org. Only `router.resolve_llm`
 * asks Node for the org's BYOK key and per-org model override, and only it
 * attaches Langfuse callbacks — so these pipelines also produced zero traces.
 *
 * Two layers here:
 *
 *   Structural — the invariant, greppable and cheap enough to gate CI on:
 *   no specialist agent may construct an LLM or read a platform key directly.
 *   This is the part that stops the bypass being reintroduced.
 *
 *   Behavioural — proof the org key is genuinely on the wire: point the org's
 *   BYOK key at a deliberately invalid value and confirm the pipeline now
 *   FAILS. If it still succeeds, the platform key was used and the customer
 *   was billed for work they thought they were paying for themselves. The
 *   invalid key fails at authentication, so this consumes no tokens.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { login, check, report, section, db, AGENTS, INTERNAL_SECRET } from './lib/harness.mjs'

const prisma = db()
const REPO = new URL('../../', import.meta.url).pathname
const AGENTS_APP = join(REPO, 'apps/agents/app')

const admin = await login()
const orgId = admin.user.orgId

// ─── Structural invariant ────────────────────────────────────────────────────

function pyFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory() && e.name !== '__pycache__') return pyFiles(join(dir, e.name))
    return e.isFile() && e.name.endsWith('.py') ? [join(dir, e.name)] : []
  })
}

/** Files allowed to touch platform keys / build_llm directly. */
const RESOLVER_FILES = ['router.py', 'providers.py', 'config.py']

// NB: match on `/app/agents/`, not `/agents/` — the whole service lives under
// apps/agents/, so the looser pattern matches every file in the tree.
const specialistFiles = pyFiles(AGENTS_APP).filter(f => {
  const base = f.split('/').pop()
  if (RESOLVER_FILES.includes(base)) return false
  return f.includes('/app/agents/') || f.includes('/app/routes/') || base === 'orchestrator.py'
})

section('1. No specialist agent constructs its own LLM')
{
  const offenders = []
  for (const f of specialistFiles) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\bbuild_llm\s*\(/.test(line) && !line.trim().startsWith('#')) {
        offenders.push(`${f.replace(REPO, '')}:${i + 1}`)
      }
    })
  }
  check(
    'no build_llm() outside router/providers',
    offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'clean',
  )
}

section('2. No specialist agent reads a platform key directly')
{
  const offenders = []
  for (const f of specialistFiles) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (line.trim().startsWith('#')) return
      if (/os\.getenv\(\s*["'][A-Z_]*API_KEY/.test(line) ||
          /settings\.(anthropic|openai|google|openrouter)_api_key/.test(line)) {
        offenders.push(`${f.replace(REPO, '')}:${i + 1}`)
      }
    })
  }
  check(
    'no direct platform-key reads',
    offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'clean',
  )
}

section('3. Every resolve passes an org and forwards its callbacks')
{
  const noOrg = []
  const noCallbacks = []
  for (const f of specialistFiles) {
    const src = readFileSync(f, 'utf8')
    // Walk the argument list with a paren counter. A lazy regex stops at the
    // first ')', which for `resolve_llm(_tier_for_model(model_id), org_id=...)`
    // is the nested call's — reporting a false miss on a correct call site.
    for (const m of src.matchAll(/\bresolve_llm\s*\(/g)) {
      let depth = 1
      let i = m.index + m[0].length
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++
        else if (src[i] === ')') depth--
        i++
      }
      const args = src.slice(m.index + m[0].length, i - 1)
      if (!/org_id\s*=/.test(args)) {
        noOrg.push(`${f.replace(REPO, '')} → ${args.split('\n')[0].trim() || '(no args)'}`)
      }
    }
    // An .ainvoke on a resolved llm that drops callbacks produces no trace.
    for (const m of src.matchAll(/(\w+)\.llm\.ainvoke\s*\(([\s\S]{0,400}?)\)\s*$/gm)) {
      if (!/callbacks/.test(m[2])) noCallbacks.push(`${f.replace(REPO, '')} → ${m[1]}.llm.ainvoke`)
    }
  }
  check('every resolve_llm call names an org_id', noOrg.length === 0, noOrg.join(' · ') || 'clean')
  check('every resolved ainvoke forwards callbacks', noCallbacks.length === 0, noCallbacks.join(' · ') || 'clean')
}

section('4. The agents service imports cleanly')
{
  let out = ''
  let ok = true
  try {
    out = execSync(
      `cd ${join(REPO, 'apps/agents')} && ./.venv/bin/python -c "import main" 2>&1`,
      { encoding: 'utf8' },
    )
  } catch (e) {
    ok = false
    out = (e.stdout ?? '') + (e.stderr ?? '')
  }
  check('main imports without error', ok, out.trim().slice(-300) || 'ok')
}

// ─── Behavioural: an invalid BYOK key must break the pipeline ────────────────

section('5. A bad org key actually breaks the call (proving it is used)')
{
  // Whichever provider the platform is configured for — that is the one the
  // tier will resolve to, so that is the one to shadow with a BYOK key.
  const envRaw = readFileSync(join(REPO, '.env'), 'utf8')
  const provider =
    /^ANTHROPIC_API_KEY=.{10,}$/m.test(envRaw) ? 'anthropic'
    : /^OPENAI_API_KEY=.{10,}$/m.test(envRaw) ? 'openai'
    : /^GOOGLE_API_KEY=.{10,}$/m.test(envRaw) ? 'google'
    : null

  if (!provider) {
    check('behavioural probe skipped — no platform key configured locally', true,
      'soft-pass: set one provider key in .env to run this')
  } else {
    // encrypt() lives in the API; shell out so the ciphertext matches exactly
    // what getByokKey() will decrypt.
    // BYOK keys are stored encrypted, so this needs a usable
    // AI_KEY_ENCRYPTION_KEY. If the local one is a stub, say so rather than
    // reporting a red that has nothing to do with the code under test.
    let enc
    try {
      enc = execSync(
        `cd ${join(REPO, 'apps/api')} && ./node_modules/.bin/tsx --env-file=../../.env ` +
        `${join(REPO, 'scripts/week-zero/lib/encrypt-one.ts')} INVALID-BYOK-SENTINEL-KEY`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim()
    } catch (e) {
      const why = String(e.stderr ?? e.message).match(/Error: (.*)/)?.[1] ?? 'unknown'
      check('behavioural probe skipped — BYOK encryption unavailable locally', true,
        `soft-pass: ${why}`)
      await prisma.$disconnect()
      report('W0-3 BYOK routing')
      process.exit(process.exitCode ?? 0)
    }

    await prisma.orgAiKey.upsert({
      where:  { orgId_provider: { orgId, provider } },
      update: { encryptedKey: enc, isActive: true },
      create: {
        org:       { connect: { id: orgId } },
        createdBy: { connect: { id: admin.user.id } },
        provider, encryptedKey: enc, isActive: true, keyPrefix: 'INVALID-',
      },
    })

    const body = {
      contractId: 'w0-3-probe',
      orgId,
      contractType: 'NDA',
      clauses: [{
        id: 'c1', clauseType: 'limitation_of_liability',
        content: 'Liability is capped at the fees paid in the prior twelve months.',
        sectionRef: 'Section 5.2',
      }],
      playbookPositions: [{
        clauseType: 'limitation_of_liability',
        preferredText: 'Liability is capped at two times fees.',
        rules: {},
      }],
    }
    const withBadKey = await fetch(`${AGENTS}/playbook-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(body),
    })
    const badText = (await withBadKey.text()).slice(0, 200)

    // Clean up before asserting, so a failed assertion can't leave the org
    // holding a broken key.
    await prisma.orgAiKey.deleteMany({ where: { orgId, provider } })

    check(
      'pipeline fails when the org key is invalid',
      withBadKey.status >= 400,
      `status=${withBadKey.status} — a 200 here means the platform key was used instead. ${badText}`,
    )

    const withoutKey = await fetch(`${AGENTS}/playbook-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(body),
    })
    check(
      'pipeline recovers on the platform key once BYOK is removed',
      withoutKey.status === 200,
      `status=${withoutKey.status} ${(await withoutKey.text()).slice(0, 160)}`,
    )
  }
}

await prisma.$disconnect()
report('W0-3 BYOK routing')
