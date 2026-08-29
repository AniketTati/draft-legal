#!/usr/bin/env node
/**
 * Run a dataset as a Langfuse experiment: execute each case against the
 * product, link it to the run, and score it.
 *
 * Usage:
 *   node scripts/evals/langfuse/run.mjs --dataset harness            # self-test, no services
 *   node scripts/evals/langfuse/run.mjs --dataset extraction         # needs agents-service + a key
 *   node scripts/evals/langfuse/run.mjs --dataset chat --run-name pr-482
 *   node scripts/evals/langfuse/run.mjs --dataset extraction --concurrency 4 --threshold 0.8
 *
 * Exit codes — a suite is only useful if the exit code means something:
 *   0  every case ran, and the pass rate cleared --threshold (if given)
 *   1  a case errored, the corpus is invalid, or the pass rate fell short
 *
 * A SKIPPED scorer never counts as a pass. "could not check" and "checked and
 * fine" must not share an exit code (scripts/evals/README.md), so a run whose
 * judge had no API key reports skips loudly and does not silently go green.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  configured, createTrace, getRun, linkRunItem, postScore, runName as defaultRunName, waitForTrace, LANGFUSE_HOST,
} from './lf.mjs'
import { runScorer, judgeAvailable } from './scorers.mjs'
import { getTarget } from './targets.mjs'

const DIR = fileURLToPath(new URL('./datasets', import.meta.url))

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const datasetArg  = arg('dataset')
const runLabel    = arg('run-name', defaultRunName(process.env.EVAL_RUN_PREFIX ?? 'local'))
const concurrency = Number(arg('concurrency', '2'))
const threshold   = arg('threshold') ? Number(arg('threshold')) : null
const orgId       = arg('org-id', process.env.EVAL_ORG_ID ?? null)
const traceWaitMs = Number(arg('trace-wait-ms', '20000'))

if (!datasetArg) {
  console.error('usage: run.mjs --dataset <harness|extraction|chat> [--run-name X] [--concurrency N] [--threshold 0.8]')
  process.exit(1)
}
if (!configured()) {
  console.error('✗ Langfuse is not configured. Set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (docs/operations/LANGFUSE.md).')
  process.exit(1)
}

const file = path.join(DIR, `${datasetArg}.json`)
if (!fs.existsSync(file)) {
  console.error(`✗ no case file ${file}. Available: ${fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).join(', ')}`)
  process.exit(1)
}
const spec = JSON.parse(fs.readFileSync(file, 'utf8'))

// Tell the operator up front what will and will not be graded. Discovering
// mid-run that every judge scorer is skipping is a waste of a real model spend.
const needsJudge = spec.items.some((i) => (i.scorers ?? []).some((s) => String(s).startsWith('judge:')))
if (needsJudge && !judgeAvailable()) {
  console.warn('⚠  no judge key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY) — judge scorers will SKIP, not fail.')
}

console.log(`\n${spec.dataset} — run "${runLabel}"  (${spec.items.length} cases, concurrency ${concurrency})`)
console.log(`${LANGFUSE_HOST}\n`)

const results = []

async function runCase(item) {
  // One session id per case: it is the correlation key that finds the trace the
  // PRODUCT emitted (apps/agents sets Langfuse session_id from it), and it
  // keeps cases from bleeding conversational state into each other.
  const sessionId = `eval-${runLabel}-${item.id}-${randomUUID().slice(0, 8)}`
  const ctx = { sessionId, orgId, runLabel }
  const row = { id: item.id, target: item.target, scores: [], skips: [], error: null, traceSource: null }

  let result
  try {
    result = await getTarget(item.target)(item, ctx)
  } catch (e) {
    row.error = e.message
    // Still record the case, so a failure is visible in the run rather than
    // being a hole in it. A run that silently contains fewer cases looks
    // healthier than one that reports the failure.
    const traceId = await createTrace({
      name: `eval.${item.target}.${item.id}`, sessionId,
      input: item.input, output: { error: e.message },
      metadata: { traceSource: 'harness', evalRun: runLabel, caseId: item.id, failed: true },
      tags: ['eval', `dataset:${spec.dataset}`, 'error'],
    }).catch(() => null)
    if (traceId) {
      await linkRunItem({ runName: runLabel, runDescription: spec.description, datasetItemId: item.id, traceId, metadata: { error: e.message } }).catch(() => {})
      await postScore({ traceId, name: 'ran', value: 0, dataType: 'BOOLEAN', comment: e.message.slice(0, 300) }).catch(() => {})
    }
    return row
  }

  // Prefer the product's own trace — it holds the prompts, tokens and cost.
  // Fall back to a harness trace so the case still appears in the run.
  let traceId = null
  if (result.sessionId) {
    const found = await waitForTrace(result.sessionId, { timeoutMs: traceWaitMs })
    if (found) { traceId = found.id; row.traceSource = 'product' }
  }
  if (!traceId) {
    row.traceSource = 'harness'
    traceId = await createTrace({
      name: `eval.${item.target}.${item.id}`, sessionId,
      input: item.input, output: result.output,
      metadata: { traceSource: 'harness', evalRun: runLabel, caseId: item.id, ...result.meta },
      tags: ['eval', `dataset:${spec.dataset}`, `target:${item.target}`],
    })
  }

  await linkRunItem({
    runName: runLabel,
    runDescription: spec.description,
    datasetItemId: item.id,
    traceId,
    metadata: { traceSource: row.traceSource, ...result.meta },
  })

  const scoreCtx = { input: item.input, output: result.output, expectedOutput: item.expectedOutput, meta: result.meta }
  for (const spec_ of item.scorers ?? []) {
    let score
    try {
      score = await runScorer(spec_, scoreCtx)
    } catch (e) {
      // A scorer that throws is a harness bug or an unreachable judge. Record
      // it as a skip with the reason rather than a 0 — scoring the product
      // badly because our grader broke is worse than no score.
      row.skips.push(`${spec_} (${e.message.slice(0, 120)})`)
      continue
    }
    if (!score) { row.skips.push(spec_); continue }
    row.scores.push(score)
    await postScore({ traceId, ...score, metadata: { evalRun: runLabel, caseId: item.id } })
  }
  await postScore({ traceId, name: 'ran', value: 1, dataType: 'BOOLEAN' })
  return row
}

/** Bounded concurrency — a corpus of judged cases will rate-limit at 20 wide. */
async function pool(items, width, fn) {
  const out = []
  let i = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx])
    }
  }))
  return out
}

results.push(...await pool(spec.items, concurrency, runCase))

// ─── report ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0, skipped = 0, errored = 0
const byScorer = new Map()

for (const r of results) {
  if (r.error) { errored++; console.log(`  ERRO ${r.id}\n         ${r.error}`); continue }
  const parts = []
  for (const s of r.scores) {
    const isMetric = s.dataType === 'NUMERIC' && s.name === 'latency_ms'
    if (!isMetric) {
      const ok = Number(s.value) >= 1
      ok ? pass++ : fail++
      const agg = byScorer.get(s.name) ?? { pass: 0, fail: 0 }
      ok ? agg.pass++ : agg.fail++
      byScorer.set(s.name, agg)
      parts.push(`${ok ? '✓' : '✗'} ${s.name}`)
    } else {
      parts.push(`${s.value}ms`)
    }
  }
  skipped += r.skips.length
  const anyFail = r.scores.some((s) => s.name !== 'latency_ms' && Number(s.value) < 1)
  console.log(`  ${anyFail ? 'FAIL' : 'PASS'} ${r.id}  [${r.traceSource}]  ${parts.join('  ')}`)
  for (const s of r.scores.filter((x) => x.comment && Number(x.value) < 1)) console.log(`         ${s.name}: ${s.comment}`)
  for (const s of r.skips) console.log(`         SKIP ${s}`)
}

const total = pass + fail
const rate = total ? pass / total : 0
console.log(`\n  ${pass}/${total} assertions passed (${(rate * 100).toFixed(1)}%)` +
  (skipped ? `, ${skipped} skipped` : '') + (errored ? `, ${errored} case(s) errored` : ''))

if (byScorer.size) {
  console.log('\n  by scorer:')
  for (const [name, a] of [...byScorer].sort()) {
    console.log(`    ${String(name).padEnd(28)} ${a.pass}/${a.pass + a.fail}`)
  }
}

// Confirm the run is actually readable back. Everything above can succeed
// against a server that then drops the events, and a run you cannot open is
// not a result.
//
// Poll rather than read once: Langfuse ingestion is asynchronous, so an
// immediate read reliably reports "0 items linked" for a run that is complete
// a second later — an alarming message about a healthy run.
let run = null
for (const waitMs of [0, 1000, 2000, 3000, 5000]) {
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
  run = await getRun(spec.dataset, runLabel).catch(() => null)
  if ((run?.datasetRunItems ?? []).length >= results.length) break
}
console.log(run
  ? `\n  run "${run.name}" recorded — ${(run.datasetRunItems ?? []).length} item(s) linked`
  : `\n  ⚠ run "${runLabel}" did not read back — check ingestion (pnpm langfuse:logs)`)
console.log(`  compare runs: ${LANGFUSE_HOST} → Datasets → ${spec.dataset} → Runs\n`)

if (errored) process.exit(1)
if (threshold != null && rate < threshold) {
  console.error(`✗ pass rate ${(rate * 100).toFixed(1)}% is below --threshold ${(threshold * 100).toFixed(1)}%`)
  process.exit(1)
}
