#!/usr/bin/env node
/**
 * run.mjs — execute all persona conversations in parallel by persona,
 * sequential within each persona.
 *
 * Output:
 *   scripts/persona-tests/output/<persona>/<conv-id>.json   — full transcript per turn
 *   scripts/persona-tests/output/scorecard.json             — aggregated scores
 *   scripts/persona-tests/output/summary.md                 — human-readable report
 *
 * Usage:
 *   node scripts/persona-tests/run.mjs                  # all 5 personas, parallel
 *   node scripts/persona-tests/run.mjs vertex-cloud     # one persona only
 *   node scripts/persona-tests/run.mjs --serial         # disable parallelism
 *   node scripts/persona-tests/run.mjs --limit 3        # only first 3 conversations per persona
 */
import { login, askAgent, scoreTurn } from './lib.mjs'
import { PERSONAS, TOTAL_CONVERSATIONS } from './conversations.mjs'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'output')

// CLI parsing
const args = process.argv.slice(2)
const flagSerial = args.includes('--serial')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null
const personaArg = args.find(a => !a.startsWith('--') && a !== String(limit))

const targetPersonas = personaArg
  ? PERSONAS.filter(p => p.slug === personaArg)
  : PERSONAS
if (targetPersonas.length === 0) {
  console.error(`✗ No persona matches "${personaArg}". Choices: ${PERSONAS.map(p => p.slug).join(', ')}`)
  process.exit(1)
}

const PASSWORD = 'password123'

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }) }

ensureDir(OUT)
for (const p of targetPersonas) {
  ensureDir(path.join(OUT, p.slug))
}

// Cache tokens per email (one login per user). Serial-prelogin avoids
// the audit-event hash-chain write conflicts (P2034) we hit when 5
// orgs' first conversations all called login() simultaneously.
const tokenCache = new Map()
async function preloginAll(personas) {
  const emails = new Set()
  for (const p of personas) {
    for (const c of p.conversations) emails.add(c.user)
  }
  console.log(`  pre-login ${emails.size} users (serial to avoid audit-chain conflicts)…`)
  for (const email of emails) {
    try {
      const { accessToken } = await login(email, PASSWORD)
      tokenCache.set(email, accessToken)
    } catch (e) {
      console.error(`    ✗ ${email}: ${e.message.slice(0, 100)}`)
    }
  }
  console.log(`  ✓ ${tokenCache.size}/${emails.size} logins succeeded`)
}
function getToken(email) {
  return tokenCache.get(email)
}

async function runConversation(persona, conv) {
  const start = Date.now()
  const token = getToken(conv.user)
  if (!token) {
    return {
      id: conv.id, persona: persona.slug, user: conv.user, jtbd: conv.jtbd,
      ok: false, reasons: [`no cached token (pre-login failed for ${conv.user})`],
      response: null, totalMs: Date.now() - start,
    }
  }

  const sessionId = `persona-test-${conv.id}-${Date.now()}`
  const response = await askAgent({
    token,
    sessionId,
    message: conv.ask,
    agentMode: true,
    timeoutMs: conv.maxLatencyMs ? conv.maxLatencyMs + 30_000 : 90_000,
  })
  const score = scoreTurn(conv, response)

  // Persist transcript
  const transcriptPath = path.join(OUT, persona.slug, `${conv.id}.json`)
  fs.writeFileSync(transcriptPath, JSON.stringify({
    id: conv.id,
    persona: persona.slug,
    user: conv.user,
    jtbd: conv.jtbd,
    ask: conv.ask,
    expected: {
      tools: conv.expectedTools, mustMention: conv.mustMention,
      shouldNotMention: conv.shouldNotMention, maxLatencyMs: conv.maxLatencyMs,
    },
    response: {
      assistantText: response.assistantText,
      tools: response.tools.map(t => ({
        name: t.name, args: t.args,
        ok: t.ok,
        // Truncate result to keep transcript readable
        resultPreview: typeof t.result === 'object'
          ? `${JSON.stringify(t.result).slice(0, 400)}${JSON.stringify(t.result).length > 400 ? '…' : ''}`
          : String(t.result ?? '').slice(0, 400),
      })),
      latencyMs: response.latencyMs,
      error: response.error,
    },
    score,
  }, null, 2))

  return {
    id: conv.id, persona: persona.slug, user: conv.user, jtbd: conv.jtbd,
    ok: score.ok, reasons: score.reasons,
    response, totalMs: Date.now() - start,
  }
}

async function runPersona(persona) {
  const list = limit ? persona.conversations.slice(0, limit) : persona.conversations
  console.log(`\n[${persona.slug}] running ${list.length} conversation(s)…`)
  const results = []
  for (const conv of list) {
    const res = await runConversation(persona, conv)
    const status = res.ok ? '✓' : '✗'
    const tools = res.response?.tools?.map(t => t.name).join(',') || 'none'
    console.log(`  ${status} ${conv.id.padEnd(34)}  ${res.totalMs}ms  tools=[${tools}]${res.ok ? '' : `  · ${res.reasons.join('; ')}`}`)
    results.push(res)
  }
  return { persona: persona.slug, name: persona.name, results }
}

async function runPersonasSerial(list) {
  const out = []
  for (const p of list) out.push(await runPersona(p))
  return out
}

const overallStart = Date.now()
console.log(`▶ Persona tests — ${TOTAL_CONVERSATIONS} total conversations across ${PERSONAS.length} personas`)
console.log(`  target personas: ${targetPersonas.map(p => p.slug).join(', ')}${limit ? `  (limit ${limit}/persona)` : ''}`)
console.log(`  mode: ${flagSerial ? 'serial' : 'parallel-by-persona'}`)

await preloginAll(targetPersonas)

const personaResults = flagSerial
  ? await runPersonasSerial(targetPersonas)
  : await Promise.all(targetPersonas.map(runPersona))

// ─── Aggregate scorecard ───────────────────────────────────────────────────
const scorecard = personaResults.map(pr => {
  const total = pr.results.length
  const passed = pr.results.filter(r => r.ok).length
  const avgLatencyMs = total
    ? Math.round(pr.results.reduce((s, r) => s + (r.response?.latencyMs ?? 0), 0) / total)
    : 0
  const errors = pr.results.filter(r => r.response?.error).length
  return {
    persona: pr.persona,
    name: pr.name,
    total, passed, failed: total - passed,
    passRate: total ? `${Math.round((passed / total) * 100)}%` : '—',
    errors,
    avgLatencyMs,
    failures: pr.results.filter(r => !r.ok).map(r => ({
      id: r.id,
      jtbd: r.jtbd,
      reasons: r.reasons,
      latencyMs: r.response?.latencyMs,
      tools: r.response?.tools?.map(t => t.name) ?? [],
    })),
  }
})

const overallTotal = scorecard.reduce((s, p) => s + p.total, 0)
const overallPassed = scorecard.reduce((s, p) => s + p.passed, 0)
const overallMs = Date.now() - overallStart

const finalScorecard = {
  ranAt: new Date().toISOString(),
  totalDurationMs: overallMs,
  overall: {
    total: overallTotal,
    passed: overallPassed,
    failed: overallTotal - overallPassed,
    passRate: overallTotal ? `${Math.round((overallPassed / overallTotal) * 100)}%` : '—',
  },
  byPersona: scorecard,
}
fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify(finalScorecard, null, 2))

// ─── Human-readable summary ────────────────────────────────────────────────
const md = []
md.push(`# Persona Tests — Summary\n`)
md.push(`**Run at:** ${finalScorecard.ranAt}`)
md.push(`**Duration:** ${(overallMs / 1000).toFixed(1)}s`)
md.push(`**Overall:** ${overallPassed}/${overallTotal} passed (${finalScorecard.overall.passRate})\n`)
md.push(`## By persona\n`)
md.push(`| Persona | Pass | Total | Rate | Avg Latency | Errors |`)
md.push(`|---|---|---|---|---|---|`)
for (const p of scorecard) {
  md.push(`| ${p.name} | ${p.passed} | ${p.total} | ${p.passRate} | ${p.avgLatencyMs}ms | ${p.errors} |`)
}
md.push('')
for (const p of scorecard) {
  if (p.failures.length === 0) continue
  md.push(`## ${p.name} — failures (${p.failures.length})\n`)
  for (const f of p.failures) {
    md.push(`### ${f.id}`)
    md.push(`- **JTBD:** ${f.jtbd}`)
    md.push(`- **Tools called:** ${f.tools.join(', ') || 'none'}`)
    md.push(`- **Latency:** ${f.latencyMs}ms`)
    md.push(`- **Reasons:**`)
    for (const r of f.reasons) md.push(`  - ${r}`)
    md.push('')
  }
}
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'))

console.log(`\n${'═'.repeat(70)}`)
console.log(`✓ Done — ${overallPassed}/${overallTotal} passed (${finalScorecard.overall.passRate}) in ${(overallMs / 1000).toFixed(1)}s`)
console.log(`${'═'.repeat(70)}\n`)
for (const p of scorecard) {
  console.log(`  ${p.name.padEnd(28)} ${p.passed}/${p.total} (${p.passRate}) — avg ${p.avgLatencyMs}ms`)
}
console.log(`\nDetailed transcripts: ${OUT}/<persona>/`)
console.log(`Scorecard:            ${OUT}/scorecard.json`)
console.log(`Summary:              ${OUT}/summary.md`)

// Canonical summary line for scripts/evals/run.mjs, which parses
// /^(.+): (\d+)\/(\d+) passed\s*$/ (run.mjs:184). manifest.mjs claims "the
// runner treats a suite exactly like a check because both report the same
// summary line" — that was never true of this suite. `✓ Done — 66/66 passed
// (100.0%) in 123s` does not match, so every tier-3 run reported this as
// ERRO / 0-of-0 "no summary line" and the largest corpus in the repo has
// never been counted. Emitted last, and deliberately separate from the human
// line above so reformatting that cannot silently un-count the suite again.
console.log(`Persona conversations: ${overallPassed}/${overallTotal} passed`)
