#!/usr/bin/env node
/**
 * Online evaluation — score real production traces, step by step.
 *
 *   node scripts/evals/langfuse/score-production.mjs --hours 3 --sample 0.3
 *   node scripts/evals/langfuse/score-production.mjs --hours 24 --limit 40 --dry-run
 *
 * Offline evals (run.mjs) ask "did my change break the cases I curated". This
 * asks the other half: "is what real users are actually getting any good".
 * Both are needed — a curated corpus only knows the failures you already
 * thought of, and production only tells you about inputs you cannot control.
 *
 * ── Why this scores OBSERVATIONS, not traces ────────────────────────────────
 *
 * A chat turn is three steps: the model decides to call a tool, the tool runs,
 * the model answers from what came back. Scoring only the final answer collapses
 * two completely different failures into one number:
 *
 *   the tool returned the wrong data   → a query or endpoint bug
 *   the tool returned the right data
 *     and the model misread it         → a prompt or model problem
 *
 * They need opposite fixes, and one score on the answer cannot tell you which
 * you have. So each step is scored where it happened, and Langfuse anchors the
 * score to that observation. `retrieval_sufficiency` on the tool step is the
 * pivot: if it passes and groundedness on the answer fails, the lookup was fine
 * and the model misread it.
 *
 * Langfuse can also do this in-platform: Evaluators → observation-level
 * LLM-as-a-judge, which runs continuously without anything of ours in the loop
 * and needs an LLM Connection configured in the project. Prefer that for a
 * standing setup. This exists because it needs no UI configuration, reuses the
 * SAME rubrics as the offline scorers — so an online `judge:groundedness` means
 * exactly what the offline one means — and version-controls with the repo.
 *
 * SAMPLE. At roughly $0.01–0.10 per judged assessment, and now several
 * assessments per turn, scoring everything is a real line item.
 */
import { requireConfig, listTraces, postScore, LANGFUSE_HOST } from './lf.mjs'
import { runScorer, judgeAvailable, RUBRICS } from './scorers.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours  = Number(arg('hours', '3'))
const limit  = Number(arg('limit', '50'))
const sample = Number(arg('sample', '1.0'))
const dryRun = process.argv.includes('--dry-run')
const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

/**
 * Which rubrics apply to the FINAL ANSWER of each surface.
 *
 * Not everything deserves a judge. `assist.complete` is a two-word autocomplete
 * and `classify.detect` returns an enum — a judge there pays real money to
 * confirm what the response shape already tells you.
 */
const ANSWER_RUBRICS = {
  'agent.chat':             ['groundedness', 'helpfulness'],
  'ask.answer':             ['groundedness', 'citation'],
  'obligations.extract':    ['groundedness'],
  'compliance.check':       ['groundedness'],
  'renewal.advice':         ['groundedness', 'helpfulness'],
  'assist.rewrite':         ['helpfulness'],
  'assist.simplify':        ['helpfulness'],
  'assist.redline_propose': ['helpfulness'],
  'intake.classify':        ['groundedness'],
}

/** Rubrics for a tool step, wherever one appears. */
const TOOL_RUBRICS = ['tool_selection', 'retrieval_sufficiency']

if (!judgeAvailable()) {
  console.error('\n✗ no judge key. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY.\n')
  process.exit(1)
}

async function getTrace(id) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}/api/public/traces/${id}`, { headers: { Authorization: auth } })
  if (!res.ok) return null
  return res.json()
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/**
 * The user's actual request, dug out of a LangChain message list.
 *
 * The raw input is the whole conversation plus every tool JSON-schema — tens of
 * thousands of characters of which the question is a couple of lines. Both step
 * rubrics are meaningless without it and useless when it is buried.
 */
function userRequest(trace) {
  const inp = trace.input
  if (Array.isArray(inp)) {
    const users = inp.filter((m) => m?.role === 'user')
    const last = users.at(-1)?.content
    if (last) return asText(last).slice(0, 4000)
  }
  return asText(inp).slice(0, 4000)
}

/** The evidence a groundedness verdict rests on: every tool result in the turn. */
function toolEvidence(trace, observations) {
  const fromObs = observations
    .filter((o) => o.type === 'TOOL')
    .map((o) => `[${o.name}] ${asText(o.output)}`)
    .join('\n')
  if (fromObs) return fromObs.slice(0, 20000)
  // Traces from before per-turn grouping have tool results only as `tool` role
  // messages inside the model input.
  const inp = trace.input
  if (!Array.isArray(inp)) return ''
  return inp.filter((m) => m?.role === 'tool').map((m) => asText(m.content)).join('\n').slice(0, 20000)
}

const since = new Date(Date.now() - hours * 3600_000)
const all = await listTraces({ limit: 100 })
const candidates = (all?.data ?? [])
  .filter((t) => new Date(t.timestamp) >= since)
  .filter((t) => ANSWER_RUBRICS[t.name])
  .slice(0, limit)

// Deterministic sampling by position — a random sample scores a different
// subset every run, which makes a trend line meaningless.
const picked = candidates.filter((_, i) => (sample >= 1 ? true : i % Math.round(1 / sample) === 0))

console.log(`\nonline scoring — last ${hours}h`)
console.log(`  ${candidates.length} scorable traces, ${picked.length} sampled (${(sample * 100).toFixed(0)}%)`)
console.log(`  rubrics: ${Object.keys(RUBRICS).join(', ')}\n`)

if (dryRun) {
  for (const t of picked) {
    const full = await getTrace(t.id)
    const obs = full?.observations ?? []
    const tools = obs.filter((o) => o.type === 'TOOL').length
    console.log(`  [dry-run] ${t.name.padEnd(22)} ${obs.length} obs, ${tools} tool step(s) → ` +
      `${ANSWER_RUBRICS[t.name].join('+')}${tools ? ` · ${TOOL_RUBRICS.join('+')} ×${tools}` : ''}`)
  }
  console.log()
  process.exit(0)
}

let scored = 0, failed = 0
const tally = new Map()

function record(key, value) {
  const agg = tally.get(key) ?? { pass: 0, fail: 0 }
  Number(value) >= 1 ? agg.pass++ : agg.fail++
  tally.set(key, agg)
}

async function judgeAndPost({ criterion, ctx, traceId, observationId, label, surface, step }) {
  try {
    const score = await runScorer(`judge:${criterion}`, ctx)
    if (!score) return
    await postScore({
      traceId, observationId, ...score,
      metadata: { onlineEval: true, surface, step },
    })
    record(label, score.value)
    scored++
    if (Number(score.value) < 1) {
      console.log(`  ✗ ${label}  (${traceId.slice(0, 12)})`)
      console.log(`      ${score.comment.slice(0, 200)}`)
    }
  } catch (e) {
    failed++
    console.log(`  ! ${label}: ${e.message.slice(0, 130)}`)
  }
}

for (const t of picked) {
  const full = await getTrace(t.id)
  if (!full) { failed++; continue }

  const observations = (full.observations ?? []).slice()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  const request  = userRequest(full)
  const evidence = toolEvidence(full, observations)

  // ── Step scores: one per tool observation ────────────────────────────────
  for (const o of observations.filter((x) => x.type === 'TOOL')) {
    const out = asText(o.output).slice(0, 20000)
    if (!out) continue
    const ctx = {
      input: `USER REQUEST:\n${request}\n\nTOOL CALLED: ${o.name}`,
      output: `TOOL OUTPUT:\n${out}`,
    }
    for (const criterion of TOOL_RUBRICS) {
      await judgeAndPost({
        criterion, ctx, traceId: t.id, observationId: o.id,
        label: `${o.name} · ${criterion}`, surface: t.name, step: 'tool',
      })
    }
  }

  // ── Answer scores: the LAST generation is what the user actually read ────
  const generations = observations.filter((x) => x.type === 'GENERATION')
  const answerObs = generations.at(-1) ?? null
  const answer = asText(answerObs?.output ?? full.output)
  const answerText = (() => {
    try {
      const parsed = typeof answer === 'string' && answer.trim().startsWith('{') ? JSON.parse(answer) : null
      return parsed?.content ? String(parsed.content) : answer
    } catch { return answer }
  })()
  if (!answerText || answerText === '""') continue

  const ctx = {
    input: evidence ? `${request}\n\n--- TOOL RESULTS (the source) ---\n${evidence}` : request,
    output: answerText,
  }
  for (const criterion of ANSWER_RUBRICS[t.name]) {
    await judgeAndPost({
      criterion, ctx, traceId: t.id,
      // Anchor to the generation when we have one: a score on the step the user
      // read is what makes "which step failed" answerable in the UI.
      observationId: answerObs?.id,
      label: `${t.name} · ${criterion}`, surface: t.name, step: 'answer',
    })
  }
}

console.log(`\n  ${scored} scores posted${failed ? `, ${failed} failed` : ''}\n`)
console.log('  by step:')
for (const [k, a] of [...tally].sort()) {
  const total = a.pass + a.fail
  console.log(`    ${k.padEnd(46)} ${a.pass}/${total}  ${total ? ((a.pass / total) * 100).toFixed(0) : '—'}%`)
}
console.log(`\n  ${LANGFUSE_HOST} → Tracing → Scores, or open a trace to see scores on each step\n`)
