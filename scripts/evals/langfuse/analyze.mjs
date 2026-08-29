#!/usr/bin/env node
/**
 * The production review — volume, cost, latency, quality, errors — read out of
 * Langfuse's metrics API instead of by clicking around the dashboard.
 *
 *   node scripts/evals/langfuse/analyze.mjs --hours 6
 *   node scripts/evals/langfuse/analyze.mjs --hours 24 --json review.json
 *
 * Those five are the standard set every LLM-analytics guide converges on, and
 * the value is in the SLICING, not the totals: cost per model, latency per
 * step, errors per surface. A single average hides the one surface that is
 * ten times slower than the rest, which is exactly the thing you needed to
 * find. So every section here groups by something.
 *
 * This is the scriptable half of the review. The other half — reading actual
 * conversations in the Sessions view — is not automatable and is where the
 * qualitative failures live. `--findings` flags what is worth opening, but a
 * human still has to open it.
 */
import fs from 'node:fs'
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const hours = Number(arg('hours', '6'))
const jsonOut = arg('json', null)
const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

const to = new Date(Date.now() + 5 * 60_000).toISOString()
const from = new Date(Date.now() - hours * 3600_000).toISOString()

/**
 * One metrics query. Returns [] on failure rather than throwing: a review that
 * dies because one slice is unavailable is less useful than one that reports
 * the other five and says which it could not get.
 */
async function metrics(spec, label) {
  const query = JSON.stringify({ ...spec, fromTimestamp: from, toTimestamp: to })
  const url = `${cfg.host.replace(/\/$/, '')}/api/public/metrics?query=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (!res.ok) {
      console.error(`  ! ${label}: ${res.status} ${(await res.text()).slice(0, 160)}`)
      return []
    }
    return (await res.json()).data ?? []
  } catch (e) {
    console.error(`  ! ${label}: ${e.message}`)
    return []
  }
}

const n = (v) => (v == null ? 0 : Number(v))
const money = (v) => `$${n(v).toFixed(4)}`
const ms = (v) => `${Math.round(n(v))}ms`
const pad = (s, w) => String(s ?? '—').padEnd(w)
const padL = (s, w) => String(s ?? '—').padStart(w)

function table(rows, cols) {
  for (const r of rows) {
    console.log('    ' + cols.map(([key, w, right, fmt]) => {
      const v = fmt ? fmt(r[key]) : r[key]
      return right ? padL(v, w) : pad(v, w)
    }).join('  '))
  }
}

console.log(`\n══ Langfuse production review — last ${hours}h`)
console.log(`   ${LANGFUSE_HOST}   ${from.slice(0, 16)} → ${to.slice(0, 16)}\n`)

const report = { window: { from, to, hours }, generatedAt: new Date().toISOString() }

// ─── 1. Volume ───────────────────────────────────────────────────────────────
console.log('1. VOLUME — what ran, and how much of it')
const byName = await metrics({
  view: 'traces', dimensions: [{ field: 'name' }],
  metrics: [{ measure: 'count', aggregation: 'count' }],
  orderBy: [{ field: 'count_count', direction: 'desc' }],
}, 'volume by name')
const totalTraces = byName.reduce((s, r) => s + n(r.count_count), 0)
console.log(`   ${totalTraces} traces across ${byName.length} surfaces\n`)
table(byName.map((r) => ({ name: r.name, c: n(r.count_count) })), [['name', 30], ['c', 6, true]])
report.volume = { totalTraces, bySurface: byName.map((r) => ({ name: r.name, count: n(r.count_count) })) }

// ─── 2. Latency ──────────────────────────────────────────────────────────────
console.log('\n2. LATENCY — where the time goes')
const lat = await metrics({
  view: 'traces', dimensions: [{ field: 'name' }],
  metrics: [
    { measure: 'count', aggregation: 'count' },
    { measure: 'latency', aggregation: 'p50' },
    { measure: 'latency', aggregation: 'p95' },
    { measure: 'latency', aggregation: 'max' },
  ],
}, 'latency by name')
const latRows = lat.map((r) => ({
  name: r.name, c: n(r.count_count), p50: n(r.p50_latency), p95: n(r.p95_latency), max: n(r.max_latency),
})).sort((a, b) => b.p95 - a.p95)
console.log(`    ${pad('surface', 30)}  ${padL('n', 6)}  ${padL('p50', 9)}  ${padL('p95', 9)}  ${padL('max', 9)}`)
table(latRows, [['name', 30], ['c', 6, true], ['p50', 9, true, ms], ['p95', 9, true, ms], ['max', 9, true, ms]])
report.latency = latRows

// ─── 3. Cost ─────────────────────────────────────────────────────────────────
console.log('\n3. COST — by model, then by surface')
const byModel = await metrics({
  view: 'observations', dimensions: [{ field: 'providedModelName' }],
  metrics: [
    { measure: 'count', aggregation: 'count' },
    { measure: 'totalCost', aggregation: 'sum' },
    { measure: 'totalTokens', aggregation: 'sum' },
  ],
}, 'cost by model')
const totalCost = byModel.reduce((s, r) => s + n(r.sum_totalCost), 0)
const totalTokens = byModel.reduce((s, r) => s + n(r.sum_totalTokens), 0)
console.log(`   ${money(totalCost)} over ${totalTokens.toLocaleString()} tokens\n`)
console.log(`    ${pad('model', 26)}  ${padL('calls', 6)}  ${padL('cost', 10)}  ${padL('tokens', 10)}`)
table(byModel.map((r) => ({
  m: r.providedModelName, c: n(r.count_count), cost: n(r.sum_totalCost), tok: n(r.sum_totalTokens),
})).sort((a, b) => b.cost - a.cost),
[['m', 26], ['c', 6, true], ['cost', 10, true, money], ['tok', 10, true, (v) => n(v).toLocaleString()]])

const costBySurface = await metrics({
  view: 'observations', dimensions: [{ field: 'traceName' }],
  metrics: [
    { measure: 'totalCost', aggregation: 'sum' },
    { measure: 'totalTokens', aggregation: 'sum' },
    { measure: 'count', aggregation: 'count' },
  ],
}, 'cost by surface')
const costRows = costBySurface.map((r) => ({
  name: r.traceName, c: n(r.count_count), cost: n(r.sum_totalCost), tok: n(r.sum_totalTokens),
  per: n(r.count_count) ? n(r.sum_totalCost) / n(r.count_count) : 0,
})).sort((a, b) => b.cost - a.cost)
console.log(`\n    ${pad('surface', 26)}  ${padL('calls', 6)}  ${padL('cost', 10)}  ${padL('per call', 10)}`)
table(costRows, [['name', 26], ['c', 6, true], ['cost', 10, true, money], ['per', 10, true, money]])
report.cost = { totalCost, totalTokens, byModel: byModel.map((r) => ({ model: r.providedModelName, calls: n(r.count_count), cost: n(r.sum_totalCost), tokens: n(r.sum_totalTokens) })), bySurface: costRows }

// ─── 4. Errors ───────────────────────────────────────────────────────────────
console.log('\n4. ERRORS — the systemic ones')
const byLevel = await metrics({
  view: 'observations', dimensions: [{ field: 'level' }],
  metrics: [{ measure: 'count', aggregation: 'count' }],
}, 'observations by level')
const errCount = byLevel.filter((r) => r.level === 'ERROR').reduce((s, r) => s + n(r.count_count), 0)
const obsTotal = byLevel.reduce((s, r) => s + n(r.count_count), 0)
console.log(`   ${errCount} error observations of ${obsTotal} (${obsTotal ? ((errCount / obsTotal) * 100).toFixed(1) : '0.0'}%)\n`)
table(byLevel.map((r) => ({ l: r.level, c: n(r.count_count) })), [['l', 20], ['c', 6, true]])

// Name the surfaces, not just the count — "3 errors" is not actionable.
const errBySurface = await metrics({
  view: 'observations', dimensions: [{ field: 'traceName' }],
  metrics: [{ measure: 'count', aggregation: 'count' }],
  filters: [{ column: 'level', operator: '=', value: 'ERROR', type: 'string' }],
}, 'errors by surface')
if (errBySurface.length) {
  console.log('\n    failing surfaces:')
  table(errBySurface.map((r) => ({ name: r.traceName, c: n(r.count_count) })), [['name', 30], ['c', 6, true]])
}
report.errors = { errorObservations: errCount, totalObservations: obsTotal, byLevel: byLevel.map((r) => ({ level: r.level, count: n(r.count_count) })), bySurface: errBySurface.map((r) => ({ name: r.traceName, count: n(r.count_count) })) }

// ─── 5. Users and sessions ───────────────────────────────────────────────────
console.log('\n5. USERS & SESSIONS — adoption and heavy users')
const byUser = await metrics({
  view: 'traces', dimensions: [{ field: 'userId' }],
  metrics: [{ measure: 'count', aggregation: 'count' }],
  orderBy: [{ field: 'count_count', direction: 'desc' }],
}, 'traces by user')
const bySession = await metrics({
  view: 'traces', dimensions: [{ field: 'sessionId' }],
  metrics: [{ measure: 'count', aggregation: 'count' }],
  orderBy: [{ field: 'count_count', direction: 'desc' }],
}, 'traces by session')
console.log(`   ${byUser.length} distinct users · ${bySession.length} sessions\n`)
table(byUser.slice(0, 10).map((r) => ({ u: r.userId ?? '(none)', c: n(r.count_count) })), [['u', 34], ['c', 6, true]])
console.log('\n    busiest sessions:')
table(bySession.slice(0, 8).map((r) => ({ s: r.sessionId ?? '(none)', c: n(r.count_count) })), [['s', 34], ['c', 6, true]])
report.users = { distinctUsers: byUser.length, sessions: bySession.length, topUsers: byUser.slice(0, 10).map((r) => ({ userId: r.userId, count: n(r.count_count) })) }

// ─── 6. Quality ──────────────────────────────────────────────────────────────
console.log('\n6. QUALITY — scores')
const scores = await metrics({
  view: 'scores-numeric', dimensions: [{ field: 'name' }],
  metrics: [{ measure: 'value', aggregation: 'avg' }, { measure: 'count', aggregation: 'count' }],
}, 'numeric scores')
if (scores.length) {
  console.log(`    ${pad('score', 30)}  ${padL('n', 6)}  ${padL('avg', 8)}`)
  table(scores.map((r) => ({ s: r.name, c: n(r.count_count), a: n(r.avg_value) })),
    [['s', 30], ['c', 6, true], ['a', 8, true, (v) => n(v).toFixed(2)]])
} else {
  console.log('    no scores in this window.')
  console.log('    Offline: pnpm evals:run -- --dataset extraction')
  console.log('    Online:  configure an observation-level LLM-as-a-judge evaluator in the UI')
}
report.quality = { numericScores: scores.map((r) => ({ name: r.name, count: n(r.count_count), avg: n(r.avg_value) })) }

// ─── Findings ────────────────────────────────────────────────────────────────
//
// Deliberately mechanical thresholds. The point is to shorten the list a human
// has to read, not to replace them — every one of these is "go look at this",
// not "this is broken".
console.log('\n══ FINDINGS')
const findings = []
const p95All = latRows.length ? Math.max(...latRows.map((r) => r.p95)) : 0
for (const r of latRows) {
  if (r.p95 > 20000) findings.push(`SLOW    ${r.name} p95 ${ms(r.p95)} — over 20s; an interactive surface at this latency reads as broken`)
}
for (const r of costRows) {
  if (r.per > 0.02) findings.push(`COST    ${r.name} ${money(r.per)}/call — the expensive surface; check the prompt size before the model`)
}
if (errCount > 0) {
  const names = errBySurface.map((r) => r.traceName).join(', ')
  findings.push(`ERRORS  ${errCount} error observation(s)${names ? ` on ${names}` : ''} — open one and read the exception`)
}
const topCost = costRows[0]
if (topCost && totalCost > 0 && topCost.cost / totalCost > 0.4) {
  findings.push(`SKEW    ${topCost.name} is ${((topCost.cost / totalCost) * 100).toFixed(0)}% of spend — optimise here or nowhere`)
}
if (!scores.length) findings.push('QUALITY no scores — cost and latency are measured, quality is not. Wire an evaluator.')
if (!findings.length) console.log('   nothing crossed a threshold.')
for (const f of findings) console.log(`   ${f}`)
report.findings = findings

console.log(`\n   Read the conversations behind these: ${LANGFUSE_HOST} → Tracing → Sessions`)
console.log(`   Slice further: ${LANGFUSE_HOST} → Dashboards\n`)

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`   wrote ${jsonOut}\n`)
}
