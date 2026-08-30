#!/usr/bin/env node
/**
 * Guardrails — deterministic safety checks over EVERY trace.
 *
 *   node scripts/evals/langfuse/guardrails.mjs --hours 24
 *   node scripts/evals/langfuse/guardrails.mjs --hours 1 --strict   # exit 1 on any violation
 *
 * The judge asks "was this answer good?". These ask "did it do something it must
 * never do?" — leak a credential, emit a payment instrument, return unparseable
 * JSON from an extractor, hand the user an empty response.
 *
 * NOT SAMPLED, deliberately. Every other quality check here runs on 5% because a
 * model judgement costs real money. These are regular expressions: the marginal
 * cost of checking the other 95% is zero, and a credential leak found in one
 * trace out of twenty is a credential leak you did not find in the other
 * nineteen. Sampling a free check is all downside.
 *
 * The rate matters as much as the violations. `guard:refusal` is not a failure —
 * declining to invent a contract it cannot find is exactly right — but a SPIKE
 * in refusals means retrieval broke or a prompt changed, and answers went from
 * useful to apologetic without anything throwing an error.
 */
import { requireConfig, listTraces, postScore, LANGFUSE_HOST } from './lf.mjs'
import { GUARDRAILS } from './scorers.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours  = Number(arg('hours', '24'))
const limit  = Number(arg('limit', '100'))
const strict = process.argv.includes('--strict')
const dryRun = process.argv.includes('--dry-run')

/** Surfaces whose output is meant to be JSON, and the keys each must carry. */
const JSON_SURFACES = {
  'classify.detect':      ['contractType', 'confidence'],
  'intake.classify':      ['contractType'],
  'obligations.extract':  ['obligations'],
  'compliance.check':     [],
  'renewal.advice':       [],
}

async function getTrace(id) {
  try {
    const res = await fetch(`${cfg.host.replace(/\/$/, '')}/api/public/traces/${id}`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000) })
    return res.ok ? res.json() : null
  } catch { return null }
}

const asText = (v) => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v.content === 'string') return v.content
  return JSON.stringify(v)
}

const since = new Date(Date.now() - hours * 3600_000)
const all = await listTraces({ limit: Math.min(100, limit) })
const traces = (all?.data ?? []).filter((t) => new Date(t.timestamp) >= since).slice(0, limit)

console.log(`\nguardrails — last ${hours}h`)
console.log(`  ${traces.length} traces · every one checked, none sampled\n`)

if (dryRun) {
  console.log('  [dry-run] nothing posted\n')
  process.exit(0)
}

const tally = new Map()
const violations = []
let checked = 0

function record(name, value) {
  const a = tally.get(name) ?? { pass: 0, fail: 0 }
  Number(value) >= 1 ? a.pass++ : a.fail++
  tally.set(name, a)
}

for (const t of traces) {
  const full = await getTrace(t.id)
  if (!full) continue

  const obs = (full.observations ?? []).slice()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  const gen = obs.filter((o) => o.type === 'GENERATION').at(-1)
  const text = asText(gen?.output ?? full.output)
  if (!text) continue
  checked++

  const results = [
    GUARDRAILS.secret_leak(text),
    GUARDRAILS.payment_data(text),
    GUARDRAILS.empty(text),
    // A metric, not a verdict — see the module note.
    GUARDRAILS.refusal(text),
  ]

  // Schema only where the surface is supposed to return JSON. Running it on a
  // chat answer would fail every prose reply and drown the real signal.
  if (t.name in JSON_SURFACES) {
    results.push(GUARDRAILS.schema_valid(text, JSON_SURFACES[t.name]))
  }

  for (const r of results) {
    await postScore({
      traceId: t.id, ...r,
      metadata: { guardrail: true, surface: t.name },
    }).catch(() => {})
    record(r.name, r.value)
    // `refusal` scores 1 when it DID refuse, so it is never a violation.
    const isViolation = r.name !== 'guard:refusal' && Number(r.value) < 1
    if (isViolation) violations.push({ trace: t.id, surface: t.name, check: r.name, why: r.comment })
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`  checked ${checked} traces\n`)
for (const [name, a] of [...tally].sort()) {
  const total = a.pass + a.fail
  if (name === 'guard:refusal') {
    const rate = total ? (a.pass / total) * 100 : 0
    console.log(`    ${name.padEnd(24)} ${a.pass}/${total} refused (${rate.toFixed(0)}%)  — a rate, not a failure`)
  } else {
    console.log(`    ${name.padEnd(24)} ${a.pass}/${total} clean`)
  }
}

if (violations.length) {
  console.log(`\n  ${violations.length} VIOLATION(S):`)
  for (const v of violations.slice(0, 20)) {
    console.log(`    ${v.check.padEnd(22)} ${v.surface.padEnd(22)} ${v.trace.slice(0, 12)}`)
    console.log(`        ${v.why}`)
  }
  if (violations.length > 20) console.log(`    … and ${violations.length - 20} more`)
} else {
  console.log('\n  ✓ no violations')
}
console.log(`\n  ${LANGFUSE_HOST} → Tracing → Scores (filter name starts with guard:)\n`)

// Only --strict fails the process. A guardrail sweep is usually informational;
// the health check is what gates. Making this fatal by default would mean a
// single historical violation blocks every later run.
process.exit(strict && violations.length ? 1 : 0)
