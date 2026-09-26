#!/usr/bin/env node
/**
 * Compare dataset runs — did the change help?
 *
 *   node scripts/evals/langfuse/compare.mjs --dataset draftlegal-extraction
 *   node scripts/evals/langfuse/compare.mjs --dataset draftlegal-chat --runs pr-482,main-baseline
 *
 * This is what datasets are FOR. A single run tells you a pass rate, which on
 * its own means very little — 70% is good or terrible depending entirely on
 * what it was last week. The question worth answering is always comparative:
 * this prompt against that one, this model against the cheaper one, today
 * against the baseline.
 *
 * Works on runs produced any way — `run.mjs`, the Langfuse UI, or a colleague's
 * machine — because it reads the runs back rather than owning how they were
 * made.
 *
 * Per-case deltas matter as much as the totals. Two runs can both score 8/12
 * with a completely different 8, which is a regression and an improvement
 * cancelling out; the aggregate says "no change" and the case table says what
 * actually happened.
 */
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const dataset = arg('dataset')
const runsArg = arg('runs')
const limit   = Number(arg('limit', '2'))

if (!dataset) {
  console.error('usage: compare.mjs --dataset <name> [--runs runA,runB] [--limit 2]')
  process.exit(1)
}

async function api(path) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}${path}`, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const runsIndex = await api(`/api/public/datasets/${encodeURIComponent(dataset)}/runs?limit=50`)
const all = runsIndex.data ?? []
if (!all.length) {
  console.error(`\n✗ no runs on dataset "${dataset}". Produce one: pnpm evals:run -- --dataset <file>\n`)
  process.exit(1)
}

// Newest first, so the default comparison is "latest vs the one before".
all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
const chosen = runsArg
  ? runsArg.split(',').map((n) => all.find((r) => r.name === n.trim())).filter(Boolean)
  : all.slice(0, limit)

if (chosen.length < 2) {
  console.error(`\n✗ need two runs to compare; found ${chosen.length}.`)
  console.error(`  available: ${all.map((r) => r.name).join(', ')}\n`)
  process.exit(1)
}

/** One run's scores, keyed by dataset item so cases line up across runs. */
async function loadRun(runName) {
  const run = await api(`/api/public/datasets/${encodeURIComponent(dataset)}/runs/${encodeURIComponent(runName)}`)
  const items = run.datasetRunItems ?? []
  const byItem = new Map()
  for (const it of items) {
    if (!it.traceId) continue
    const scores = await api(`/api/public/v2/scores?traceId=${it.traceId}&limit=50`).then((r) => r.data ?? []).catch(() => [])
    // `ran` is bookkeeping, not quality; latency is a metric, not a verdict.
    const graded = scores.filter((s) => s.name !== 'ran' && s.name !== 'latency_ms' && s.dataType !== 'NUMERIC')
    byItem.set(it.datasetItemId, graded)
  }
  return { name: runName, createdAt: run.createdAt, byItem }
}

console.log(`\ncomparing runs of "${dataset}"\n`)
const loaded = []
for (const r of chosen) {
  process.stdout.write(`  loading ${r.name} … `)
  loaded.push(await loadRun(r.name))
  console.log('done')
}

// ── Aggregate: pass rate per scorer, per run ─────────────────────────────────
const scorerNames = new Set()
for (const run of loaded) for (const scores of run.byItem.values()) for (const s of scores) scorerNames.add(s.name)

const pad = (s, w) => String(s ?? '').padEnd(w)
const padL = (s, w) => String(s ?? '').padStart(w)
const rate = (run, name) => {
  let pass = 0, total = 0
  for (const scores of run.byItem.values()) {
    for (const s of scores) {
      if (s.name !== name) continue
      total++
      if (Number(s.value) >= 1) pass++
    }
  }
  return { pass, total }
}

console.log(`\n  ${pad('scorer', 34)}${loaded.map((r) => padL(r.name.slice(0, 18), 20)).join('')}   delta`)
console.log('  ' + '─'.repeat(34 + loaded.length * 20 + 8))
for (const name of [...scorerNames].sort()) {
  const cells = loaded.map((r) => rate(r, name))
  const pcts = cells.map((c) => (c.total ? c.pass / c.total : null))
  const first = pcts[0], last = pcts[pcts.length - 1]
  const delta = first != null && last != null ? (last - first) * 100 : null
  const arrow = delta == null ? '' : delta > 0.5 ? `▲ +${delta.toFixed(0)}pp` : delta < -0.5 ? `▼ ${delta.toFixed(0)}pp` : '·  same'
  console.log('  ' + pad(name, 34) +
    cells.map((c) => padL(c.total ? `${c.pass}/${c.total}` : '—', 20)).join('') +
    '   ' + arrow)
}

// ── Per-case: what actually moved ────────────────────────────────────────────
// Two runs can post the same total with a different set of passing cases. The
// aggregate calls that "no change"; it is a regression and a fix cancelling out.
const a = loaded[0], b = loaded[loaded.length - 1]
const verdict = (scores) => {
  if (!scores?.length) return null
  return scores.every((s) => Number(s.value) >= 1) ? 'pass' : 'fail'
}
const moved = []
for (const itemId of new Set([...a.byItem.keys(), ...b.byItem.keys()])) {
  const va = verdict(a.byItem.get(itemId))
  const vb = verdict(b.byItem.get(itemId))
  if (va && vb && va !== vb) moved.push({ itemId, from: va, to: vb })
}

if (moved.length) {
  console.log(`\n  cases that changed verdict (${a.name} → ${b.name}):`)
  for (const m of moved) {
    const mark = m.to === 'pass' ? '▲ fixed  ' : '▼ broke  '
    console.log(`    ${mark} ${m.itemId}`)
  }
} else {
  console.log(`\n  no case changed verdict between ${a.name} and ${b.name}.`)
}

console.log(`\n  Side by side: ${LANGFUSE_HOST} → Datasets → ${dataset} → Runs\n`)
