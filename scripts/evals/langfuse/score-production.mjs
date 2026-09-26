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

/**
 * --only helpfulness,groundedness → run just those rubrics.
 *
 * Without this, changing one rubric means re-judging every other rubric on
 * every trace to see the effect — most of the spend, none of the new signal.
 */
const onlyArg = arg('only', null)
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null
const wants = (criterion) => !only || only.has(criterion)
if (only) {
  const unknown = [...only].filter((c) => !RUBRICS[c])
  if (unknown.length) {
    console.error(`\n✗ --only names unknown rubric(s): ${unknown.join(', ')}`)
    console.error(`  known: ${Object.keys(RUBRICS).join(', ')}\n`)
    process.exit(1)
  }
}
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
  // `failure_mode` only where a failure has more than one plausible cause. On a
  // rewrite there is nothing to triage — it is either useful or it is not, and
  // the numeric score already says so.
  'agent.chat':             ['groundedness', 'helpfulness', 'failure_mode'],
  'ask.answer':             ['groundedness', 'citation', 'failure_mode'],
  'obligations.extract':    ['groundedness', 'failure_mode'],
  'compliance.check':       ['groundedness', 'failure_mode'],
  'renewal.advice':         ['groundedness', 'helpfulness', 'failure_mode'],
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
// Paginate. The API caps a page at 100, so `--limit 200` silently scored 100
// and reported success — the kind of quiet truncation that makes a coverage
// claim wrong rather than incomplete.
async function allTraces(max) {
  const out = []
  for (let page = 1; out.length < max && page <= 50; page++) {
    const res = await listTraces({ limit: 100, page })
    const rows = res?.data ?? []
    out.push(...rows)
    if (rows.length < 100) break
  }
  return out
}

const fetched = await allTraces(Math.max(limit * 3, 100))
const candidates = fetched
  .filter((t) => new Date(t.timestamp) >= since)
  .filter((t) => ANSWER_RUBRICS[t.name])
  // With --only, a trace whose rubrics are all filtered out is not a candidate:
  // counting it would report coverage the run never actually attempted.
  .filter((t) => !only || ANSWER_RUBRICS[t.name].some(wants) || TOOL_RUBRICS.some(wants) || wants('trajectory'))
  .slice(0, limit)

// Deterministic sampling by position — a random sample scores a different
// subset every run, which makes a trend line meaningless.
const picked = candidates.filter((_, i) => (sample >= 1 ? true : i % Math.round(1 / sample) === 0))

console.log(`\nonline scoring — last ${hours}h`)
console.log(`  ${candidates.length} scorable traces, ${picked.length} sampled (${(sample * 100).toFixed(0)}%)`)
console.log(`  rubrics: ${Object.keys(RUBRICS).filter(wants).join(', ')}${only ? '  (--only)' : ''}\n`)

if (dryRun) {
  for (const t of picked) {
    const full = await getTrace(t.id)
    const obs = full?.observations ?? []
    const tools = obs.filter((o) => o.type === 'TOOL').length
    console.log(`  [dry-run] ${t.name.padEnd(22)} ${obs.length} obs, ${tools} tool step(s) → ` +
      `${ANSWER_RUBRICS[t.name].filter(wants).join('+') || '—'}${tools && TOOL_RUBRICS.some(wants) ? ` · ${TOOL_RUBRICS.filter(wants).join('+')} ×${tools}` : ''}`)
  }
  console.log()
  process.exit(0)
}

let scored = 0, failed = 0
const tally = new Map()

/**
 * Three score types need three summaries. A boolean has a pass rate, a numeric
 * has a mean, and a categorical has neither — `Number('hallucinated')` is NaN,
 * so the old pass/fail counter silently filed every categorical verdict as a
 * failure and printed nothing about it.
 */
function record(key, value, dataType) {
  const agg = tally.get(key) ?? { type: dataType, n: 0, pass: 0, sum: 0, labels: new Map() }
  agg.n++
  if (dataType === 'CATEGORICAL') {
    agg.labels.set(value, (agg.labels.get(value) ?? 0) + 1)
  } else {
    agg.sum += Number(value)
    if (Number(value) >= 1) agg.pass++
  }
  tally.set(key, agg)
}

/** Worth printing to the console mid-run? Type decides what "bad" means. */
function isNoteworthy(value, dataType) {
  if (dataType === 'CATEGORICAL') return value !== 'fine'
  if (dataType === 'BOOLEAN') return Number(value) < 1
  return Number(value) < 0.7          // numeric: anything below "minor blemish"
}

async function judgeAndPost({ criterion, ctx, traceId, observationId, label, surface, step }) {
  try {
    const score = await runScorer(`judge:${criterion}`, ctx)
    if (!score) return
    await postScore({
      traceId, observationId, ...score,
      metadata: { onlineEval: true, surface, step },
    })
    const dt = RUBRICS[criterion]?.dataType ?? 'BOOLEAN'
    record(label, score.value, dt)
    scored++
    if (isNoteworthy(score.value, dt)) {
      console.log(`  ✗ ${label} = ${score.value}  (${traceId.slice(0, 12)})`)
      console.log(`      ${String(score.comment ?? '').slice(0, 200)}`)
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
    for (const criterion of TOOL_RUBRICS.filter(wants)) {
      await judgeAndPost({
        criterion, ctx, traceId: t.id, observationId: o.id,
        label: `${o.name} · ${criterion}`, surface: t.name, step: 'tool',
      })
    }
  }

  // ── Trajectory: one score per turn, over the ORDERED tool list ───────────
  //
  // Only when there is more than one call. On a single-tool turn the trajectory
  // and the tool choice are the same question, and paying a judge twice to
  // answer it once is waste.
  const toolCalls = observations.filter((x) => x.type === 'TOOL')
  if (toolCalls.length > 1 && wants('trajectory')) {
    const plan = toolCalls
      .map((o, i) => `${i + 1}. ${o.name}(${asText(o.input).slice(0, 300)}) → ${asText(o.output).slice(0, 600)}`)
      .join('\n')
    await judgeAndPost({
      criterion: 'trajectory',
      ctx: { input: `USER REQUEST:\n${request}`, output: `TOOL CALLS, IN ORDER:\n${plan}` },
      traceId: t.id,
      label: `${t.name} · trajectory (${toolCalls.length} calls)`, surface: t.name, step: 'trajectory',
    })
  }

  // ── Answer scores: the LAST generation is what the user actually read ────
  const generations = observations.filter((x) => x.type === 'GENERATION')
  const answerObs = generations.at(-1) ?? null
  const answer = asText(answerObs?.output ?? full.output)
  const answerText = (() => {
    try {
      const parsed = typeof answer === 'string' && answer.trim().startsWith('{') ? JSON.parse(answer) : null
      if (!parsed) return answer
      if (parsed.content) return String(parsed.content)
      // Empty content + tool_calls = the DECIDE step, not an answer. Falling
      // back to `answer` here handed the judge a raw tool-call payload as the
      // thing to grade; with no prose in it the judge scored 0 and invented a
      // reason ("hallucinates a tool that does not exist"). A confident score
      // about a step that never produced an answer is worse than no score.
      // Older traces (pre per-turn grouping) are all shaped this way.
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) return ''
      return answer
    } catch { return answer }
  })()
  if (!answerText || answerText === '""') continue

  const ctx = {
    input: evidence ? `${request}\n\n--- TOOL RESULTS (the source) ---\n${evidence}` : request,
    output: answerText,
  }
  for (const criterion of ANSWER_RUBRICS[t.name].filter(wants)) {
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
  if (a.type === 'CATEGORICAL') {
    const top = [...a.labels].sort((x, y) => y[1] - x[1]).map(([l, n]) => `${l} ×${n}`).join(', ')
    console.log(`    ${k.padEnd(46)} ${top}`)
  } else if (a.type === 'NUMERIC') {
    console.log(`    ${k.padEnd(46)} mean ${(a.sum / a.n).toFixed(2)}  (n=${a.n})`)
  } else {
    console.log(`    ${k.padEnd(46)} ${a.pass}/${a.n}  ${a.n ? ((a.pass / a.n) * 100).toFixed(0) : '—'}%`)
  }
}
console.log(`\n  ${LANGFUSE_HOST} → Tracing → Scores, or open a trace to see scores on each step\n`)
