#!/usr/bin/env node
/**
 * Production health check — the thing that runs on a schedule and tells you
 * when to look.
 *
 *   node scripts/evals/langfuse/health.mjs --hours 24
 *   node scripts/evals/langfuse/health.mjs --hours 1 --json health.json
 *
 * `evals:review` is a report you read. This is a check that PASSES OR FAILS, so
 * a cron job, a CI step or an alerting webhook can act on it without a human
 * reading prose. Exit 0 = healthy, exit 1 = at least one threshold breached.
 *
 * Langfuse (self-hosted) has no alerting of its own — there is no alert or
 * webhook endpoint in its API. A dashboard nobody opens at 3am is not
 * monitoring, so the alert has to come from outside, and this is it.
 *
 * ── The checks, and why each one ────────────────────────────────────────────
 *
 *   traffic      Did ANYTHING run? A silent pipeline scores 100% on every other
 *                check, which is the most dangerous possible green. Tracing
 *                breaking looks identical to a quiet night, so this is first.
 *   errors       Error-level observations as a share of all of them.
 *   latency      p95 on the slowest surface.
 *   ttft         time to FIRST TOKEN — what a streaming user actually feels.
 *                Total latency and TTFT diverge badly: 24s total with 23s of
 *                blank screen is a different product than 24s of visible
 *                progress, and only this number tells them apart.
 *   quality      Judge pass rate, bookkeeping excluded.
 *   coverage     Are judgements actually being produced? Quality at 100% over
 *                two assessments is not evidence; it usually means the
 *                continuous evaluator has stopped.
 *   spend        Cost in the window, against a ceiling.
 *
 * Thresholds are deliberately blunt and overridable. The point is not to be
 * clever, it is to be woken up for the right reasons and left alone otherwise.
 */
import fs from 'node:fs'
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours   = Number(arg('hours', '24'))
const jsonOut = arg('json', null)
const quiet   = process.argv.includes('--quiet')

/** Thresholds. Env-overridable so staging and production can differ. */
const T = {
  minTraces:      Number(process.env.HEALTH_MIN_TRACES      ?? arg('min-traces', '1')),
  maxErrorRate:   Number(process.env.HEALTH_MAX_ERROR_RATE  ?? arg('max-error-rate', '0.05')),
  maxP95Ms:       Number(process.env.HEALTH_MAX_P95_MS      ?? arg('max-p95-ms', '45000')),
  maxTtftMs:      Number(process.env.HEALTH_MAX_TTFT_MS     ?? arg('max-ttft-ms', '10000')),
  minQuality:     Number(process.env.HEALTH_MIN_QUALITY     ?? arg('min-quality', '0.70')),
  minAssessments: Number(process.env.HEALTH_MIN_ASSESSMENTS ?? arg('min-assessments', '5')),
  maxSpendUsd:    Number(process.env.HEALTH_MAX_SPEND_USD   ?? arg('max-spend-usd', '50')),
}

const to = new Date(Date.now() + 5 * 60_000).toISOString()
const from = new Date(Date.now() - hours * 3600_000).toISOString()

async function metrics(spec) {
  const query = JSON.stringify({ ...spec, fromTimestamp: from, toTimestamp: to })
  try {
    const res = await fetch(`${cfg.host.replace(/\/$/, '')}/api/public/metrics?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    return (await res.json()).data ?? []
  } catch { return null }
}

const n = (v) => (v == null ? 0 : Number(v))
const NOT_BOOKKEEPING = [{ column: 'name', operator: 'none of', value: ['ran', 'latency_ms'], type: 'stringOptions' }]

const checks = []
/**
 * `null` for `actual` means the query itself failed. That is NOT healthy and
 * must not pass — an unreachable metrics API is exactly when you want to hear
 * about it, and defaulting a failed read to 0 would silently satisfy any
 * "less than" threshold.
 */
function check({ id, label, actual, ok, detail, unavailable = false }) {
  checks.push({ id, label, actual, ok: unavailable ? false : ok, detail, unavailable })
}

// ── traffic ──────────────────────────────────────────────────────────────────
const traceRows = await metrics({ view: 'traces', metrics: [{ measure: 'count', aggregation: 'count' }] })
const traces = traceRows === null ? null : n(traceRows[0]?.count_count)
check({
  id: 'traffic', label: 'Traffic', actual: traces,
  unavailable: traces === null,
  ok: traces >= T.minTraces,
  detail: traces === null ? 'metrics API unreachable' : `${traces} traces (need ≥ ${T.minTraces})`,
})

// ── errors ───────────────────────────────────────────────────────────────────
const levels = await metrics({ view: 'observations', dimensions: [{ field: 'level' }], metrics: [{ measure: 'count', aggregation: 'count' }] })
let errRate = null
if (levels) {
  const total = levels.reduce((s, r) => s + n(r.count_count), 0)
  const errs  = levels.filter((r) => r.level === 'ERROR').reduce((s, r) => s + n(r.count_count), 0)
  errRate = total ? errs / total : 0
  check({
    id: 'errors', label: 'Error rate', actual: errRate, ok: errRate <= T.maxErrorRate,
    detail: `${(errRate * 100).toFixed(1)}% of ${total} observations (limit ${(T.maxErrorRate * 100).toFixed(0)}%)`,
  })
} else check({ id: 'errors', label: 'Error rate', actual: null, ok: false, unavailable: true, detail: 'metrics API unreachable' })

// ── latency ──────────────────────────────────────────────────────────────────
const lat = await metrics({
  view: 'traces', dimensions: [{ field: 'name' }],
  metrics: [{ measure: 'latency', aggregation: 'p95' }],
})
let worst = null
if (lat) {
  worst = lat.map((r) => ({ name: r.name, p95: n(r.p95_latency) })).sort((a, b) => b.p95 - a.p95)[0] ?? null
  check({
    id: 'latency', label: 'Slowest p95', actual: worst?.p95 ?? 0,
    ok: (worst?.p95 ?? 0) <= T.maxP95Ms,
    detail: worst ? `${worst.name} at ${Math.round(worst.p95)}ms (limit ${T.maxP95Ms}ms)` : 'no latency data',
  })
} else check({ id: 'latency', label: 'Slowest p95', actual: null, ok: false, unavailable: true, detail: 'metrics API unreachable' })

// ── time to first token ──────────────────────────────────────────────────────
// The number a streaming UI is actually judged on. Total latency says how long
// the whole answer took; TTFT says how long the user stared at nothing. They
// diverge badly here — a turn can be 24s total with 23s of it before the first
// character appears, which reads as broken however good the answer is.
const ttftRows = await metrics({ view: 'observations', metrics: [{ measure: 'timeToFirstToken', aggregation: 'p95' }] })
const ttft = ttftRows === null ? null : n(ttftRows[0]?.p95_timeToFirstToken)
check({
  id: 'ttft', label: 'Time to first token', actual: ttft, unavailable: ttft === null,
  ok: (ttft ?? 0) <= T.maxTtftMs,
  detail: ttft === null ? 'metrics API unreachable'
    : `p95 ${Math.round(ttft)}ms before anything appears (limit ${T.maxTtftMs}ms)`,
})

// ── quality + coverage ───────────────────────────────────────────────────────
const qual = await metrics({
  view: 'scores-boolean',
  metrics: [{ measure: 'value', aggregation: 'avg' }, { measure: 'count', aggregation: 'count' }],
  filters: NOT_BOOKKEEPING,
})
if (qual) {
  const rate  = qual.length ? n(qual[0].avg_value) : null
  const count = qual.length ? n(qual[0].count_count) : 0
  check({
    id: 'coverage', label: 'Assessments', actual: count, ok: count >= T.minAssessments,
    detail: `${count} quality judgements (need ≥ ${T.minAssessments}) — too few means the judge has stopped`,
  })
  check({
    id: 'quality', label: 'Quality', actual: rate,
    // Not enough data is not a quality failure — coverage already reports that.
    // Failing both for one cause double-counts and buries the real signal.
    ok: count < T.minAssessments ? true : rate >= T.minQuality,
    detail: count < T.minAssessments
      ? `not enough judgements to assess (${count})`
      : `${(rate * 100).toFixed(1)}% pass (floor ${(T.minQuality * 100).toFixed(0)}%)`,
  })
} else {
  check({ id: 'coverage', label: 'Assessments', actual: null, ok: false, unavailable: true, detail: 'metrics API unreachable' })
  check({ id: 'quality',  label: 'Quality',     actual: null, ok: false, unavailable: true, detail: 'metrics API unreachable' })
}

// ── spend ────────────────────────────────────────────────────────────────────
const costRows = await metrics({ view: 'observations', metrics: [{ measure: 'totalCost', aggregation: 'sum' }] })
const spend = costRows === null ? null : n(costRows[0]?.sum_totalCost)
check({
  id: 'spend', label: 'Spend', actual: spend, unavailable: spend === null,
  ok: spend <= T.maxSpendUsd,
  detail: spend === null ? 'metrics API unreachable' : `$${spend.toFixed(2)} in ${hours}h (ceiling $${T.maxSpendUsd})`,
})

// ── report ───────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok)
const status = failed.length === 0 ? 'HEALTHY' : 'UNHEALTHY'

if (!quiet) {
  console.log(`\n══ LLM health — last ${hours}h — ${status}`)
  console.log(`   ${LANGFUSE_HOST}\n`)
  for (const c of checks) {
    const mark = c.unavailable ? '?' : c.ok ? '✓' : '✗'
    console.log(`  ${mark} ${c.label.padEnd(14)} ${c.detail}`)
  }
  if (failed.length) {
    console.log(`\n  ${failed.length} check(s) failed: ${failed.map((c) => c.id).join(', ')}`)
    console.log(`  Investigate: ${LANGFUSE_HOST} → Tracing → Sessions`)
  }
  console.log()
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    status, window: { from, to, hours }, thresholds: T, checks,
    generatedAt: new Date().toISOString(),
  }, null, 2))
  if (!quiet) console.log(`  wrote ${jsonOut}\n`)
}

process.exit(failed.length ? 1 : 0)
