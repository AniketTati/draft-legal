#!/usr/bin/env node
/**
 * Promote failing production traces into the golden corpus.
 *
 *   node scripts/evals/langfuse/promote.mjs --hours 24 --dry-run
 *   node scripts/evals/langfuse/promote.mjs --hours 24 --apply
 *
 * This is the loop that keeps the corpus alive. A curated dataset only knows
 * the failures somebody thought of in advance; production keeps producing the
 * ones nobody did. Without a path from "found in production" to "permanent test
 * case", every defect is free to come back, and the corpus slowly becomes a
 * snapshot of the problems you had the month you wrote it.
 *
 * What gets promoted: any trace with a failing judge score, a thumbs-down from
 * a real user, or a human annotation marked needs_fix. A user thumbs-down is
 * the strongest of the three — it is the only one where a person who wanted
 * something said they did not get it.
 *
 * `sourceTraceId` on each item records where it came from, so the case is one
 * click from the conversation that produced it. That link is what stops a
 * regression case becoming an unexplained blob of JSON in six months.
 *
 * DELIBERATELY LEFT BLANK: `expectedOutput`. We know the answer was wrong; we
 * do not know what right looks like, and inventing one produces a case that
 * enshrines a guess. Promoted items are graded by RUBRIC (groundedness and
 * friends) until a human fills in the expected output — the metadata flags
 * which ones are still waiting.
 */
import { requireConfig, listTraces, ensureDataset, upsertItem, getDatasetItems, LANGFUSE_HOST } from './lf.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours  = Number(arg('hours', '24'))
const max    = Number(arg('max', '25'))
const apply  = process.argv.includes('--apply')
const dryRun = process.argv.includes('--dry-run') || !apply

const DATASET = 'draftlegal-regressions'

async function api(path) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}${path}`, { headers: { Authorization: auth } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json()
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** The user's request, dug out of a LangChain message list. */
function userRequest(trace) {
  const inp = trace.input
  if (Array.isArray(inp)) {
    const users = inp.filter((m) => m?.role === 'user')
    const last = users.at(-1)?.content
    if (last) return asText(last).slice(0, 4000)
  }
  return asText(inp).slice(0, 4000)
}

// ── Gather failing signals ───────────────────────────────────────────────────
const since = Date.now() - hours * 3600_000
const scores = (await api('/api/public/v2/scores?limit=100')).data ?? []

/** traceId → why it should be promoted, most severe reason first. */
const failing = new Map()
for (const s of scores) {
  if (new Date(s.timestamp ?? s.createdAt ?? 0).getTime() < since) continue
  if (!s.traceId) continue
  const label = s.stringValue ?? s.value
  let reason = null
  let severity = 0
  if (s.name === 'user_feedback' && Number(s.value) < 1) {
    reason = `a real user marked this unhelpful${s.comment ? `: "${s.comment}"` : ''}`
    severity = 3   // strongest signal — a person who wanted something didn't get it
  } else if (s.name?.startsWith('human_') && (label === 'needs_fix' || label === 'not_grounded' || label === 'not_useful')) {
    reason = `human review: ${s.name} = ${label}`
    severity = 2
  } else if ((s.name?.startsWith('judge:') || s.name?.startsWith('draftlegal ')) && Number(s.value) < 1) {
    reason = `${s.name} failed${s.comment ? `: ${String(s.comment).slice(0, 200)}` : ''}`
    severity = 1
  }
  if (!reason) continue
  const prev = failing.get(s.traceId)
  if (!prev || severity > prev.severity) failing.set(s.traceId, { reason, severity, scoreName: s.name })
}

const traces = ((await listTraces({ limit: 100 }))?.data ?? [])
  .filter((t) => new Date(t.timestamp).getTime() >= since)
  .filter((t) => failing.has(t.id))
  .slice(0, max)

console.log(`\npromote failing traces → "${DATASET}"`)
console.log(`  window: last ${hours}h · ${failing.size} traces carry a failing signal · ${traces.length} in range\n`)

if (!traces.length) {
  console.log('  Nothing to promote. That is either good news or a sign nothing has been scored yet.\n')
  process.exit(0)
}

// Already-promoted items, so a second run does not re-add the same trace.
let existing = new Set()
try {
  const items = await getDatasetItems(DATASET, 100)
  existing = new Set((items.data ?? []).map((i) => i.metadata?.sourceTraceId ?? i.sourceTraceId).filter(Boolean))
} catch { /* dataset does not exist yet */ }

const plan = []
for (const t of traces) {
  const info = failing.get(t.id)
  if (existing.has(t.id)) { console.log(`  · ${t.name.padEnd(22)} ${t.id.slice(0, 12)}  already promoted`); continue }
  const full = await api(`/api/public/traces/${t.id}`)
  const request = userRequest(full)
  if (!request) { console.log(`  ! ${t.id.slice(0, 12)} — no user request found, skipping`); continue }
  plan.push({
    // Stable id: re-promoting the same trace updates rather than duplicates.
    id: `regress-${t.id.slice(0, 12)}`,
    traceId: t.id,
    surface: t.name,
    input: { message: request, surface: t.name },
    metadata: {
      sourceTraceId: t.id,
      surface: t.name,
      promotedAt: new Date().toISOString().slice(0, 10),
      reason: info.reason,
      signal: info.scoreName,
      // Honest about what this case can and cannot assert yet.
      expectedOutputStatus: 'unset — graded by rubric until a human writes the right answer',
      target: t.name === 'agent.chat' ? 'chat' : 'classify',
      scorers: ['judge:groundedness', 'judge:helpfulness'],
    },
  })
  console.log(`  + ${t.name.padEnd(22)} ${t.id.slice(0, 12)}  ${info.reason.slice(0, 90)}`)
}

if (!plan.length) { console.log('\n  Nothing new to promote.\n'); process.exit(0) }

if (dryRun) {
  console.log(`\n  [dry-run] ${plan.length} item(s) would be added. Re-run with --apply.\n`)
  process.exit(0)
}

await ensureDataset(
  DATASET,
  'Failures found in production, promoted so they cannot come back silently. expectedOutput is deliberately unset — these are graded by rubric until a human writes the right answer.',
  { source: 'production', maintainedBy: 'promote.mjs' },
)
let added = 0
for (const item of plan) {
  await upsertItem({
    datasetName: DATASET,
    id: item.id,
    input: item.input,
    expectedOutput: undefined,
    metadata: item.metadata,
  })
  added++
}
console.log(`\n  ✓ ${added} item(s) in "${DATASET}"`)
console.log(`  ${LANGFUSE_HOST} → Datasets → ${DATASET}`)
console.log(`  Next: write the expected answers, then \`pnpm evals:run -- --dataset regressions\`\n`)
