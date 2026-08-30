#!/usr/bin/env node
/**
 * Human annotation queue — the part of qualitative review a model cannot do.
 *
 *   node scripts/evals/langfuse/annotate.mjs --seed --hours 24   # fill the queue
 *   node scripts/evals/langfuse/annotate.mjs --calibrate         # judge vs human
 *
 * Two jobs, and the second is the one that matters.
 *
 * 1. A person reads real traces and labels them. Rubrics only catch failures
 *    someone anticipated; a human reading a transcript catches the ones nobody
 *    wrote a rubric for.
 *
 * 2. It is the ONLY way to find out whether the judge is any good. Right now
 *    nothing checks it, and this project has already watched it produce a
 *    confident, articulate, completely wrong verdict (it called four correct
 *    answers hallucinations because its evidence had been truncated). A judge
 *    score with no human baseline is a number, not a measurement.
 *
 * The seed is deliberately MIXED: every trace the judge failed, plus a sample
 * of ones it passed. A queue of only-failures measures nothing — you cannot see
 * false positives if you never show the annotator a case the judge liked, and
 * false positives are exactly the failure mode we hit.
 *
 * Annotating happens in the Langfuse UI (Annotation Queues). This script sets
 * the queue up and, later, reads the labels back to score the scorer.
 */
import { requireConfig, listTraces, postScore, LANGFUSE_HOST } from './lf.mjs'
import { runScorer } from './scorers.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours     = Number(arg('hours', '24'))
const maxItems  = Number(arg('max', '20'))
const doSeed    = process.argv.includes('--seed')
const doCal     = process.argv.includes('--calibrate')
const doSecond  = process.argv.includes('--second-opinion')
const dryRun    = process.argv.includes('--dry-run')

async function api(method, path, body) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 300)}`)
  return parsed
}

const QUEUE_NAME = 'draftLegal — agent quality review'

/** Full trace detail — the list endpoint returns no input/output bodies. */
async function getTrace(id) {
  return api('GET', `/api/public/traces/${id}`).catch(() => null)
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : (typeof v?.content === 'string' ? v.content : JSON.stringify(v)))

/** The user's actual request, dug out of a LangChain message list. */
function userRequest(trace) {
  const inp = trace.input
  if (Array.isArray(inp)) {
    const users = inp.filter((m) => m?.role === 'user')
    const last = users.at(-1)?.content
    if (last) return asText(last).slice(0, 4000)
  }
  return asText(inp).slice(0, 4000)
}

/** Every tool result in the turn — the evidence a groundedness verdict rests on. */
function toolEvidence(trace, observations) {
  const fromObs = observations.filter((o) => o.type === 'TOOL')
    .map((o) => `[${o.name}] ${asText(o.output)}`).join('\n')
  if (fromObs) return fromObs.slice(0, 20000)
  const inp = trace.input
  if (!Array.isArray(inp)) return ''
  return inp.filter((m) => m?.role === 'tool').map((m) => asText(m.content)).join('\n').slice(0, 20000)
}

const QUEUE_NAME_MARKER = true


/**
 * The labels an annotator picks from.
 *
 * `human_` prefixed so they never collide with the judge's `judge:` scores —
 * the whole point is to hold both on the same trace and compare them.
 *
 * Underscore rather than colon because score CONFIG names are validated against
 * /^[\p{L}\p{N}_ .()-]+$/u and reject `:`, even though score NAMES accept it.
 * Mixing separators is a small ugliness that beats a 400.
 *
 * The "unclear" option on groundedness is deliberate: forcing a binary on a
 * genuinely ambiguous case produces a confident label that then poisons the
 * calibration set it was collected for.
 */
const SCORE_CONFIGS = [
  {
    name: 'human_groundedness',
    dataType: 'CATEGORICAL',
    description: 'Is every factual claim traceable to the tool output or document? Same question the judge answers.',
    categories: [
      { value: 1, label: 'grounded' },
      { value: 0, label: 'not_grounded' },
      { value: 0.5, label: 'unclear' },
    ],
  },
  {
    name: 'human_helpfulness',
    dataType: 'CATEGORICAL',
    description: 'Would a busy contracts lawyer consider this a useful reply?',
    categories: [
      { value: 1, label: 'useful' },
      { value: 0.5, label: 'partly_useful' },
      { value: 0, label: 'not_useful' },
    ],
  },
  {
    // Three buttons can record a verdict but not a REASON, and the reason is
    // the whole point: "not_grounded" tells you a number, "it cited clause 9.2
    // but the cap is in 9.4" tells you what to fix. Langfuse supports a TEXT
    // score type and this queue was built without one — a reviewer could
    // disagree with the judge and had nowhere to say why.
    //
    // This is also what makes calibration diagnostic rather than just a
    // percentage: when human and judge disagree, the note says which of them
    // misread the trace.
    name: 'human_notes',
    dataType: 'TEXT',
    description: 'WHY. What specifically was wrong (or right)? Quote the clause, the number, or the tool result that decided it. Most valuable when you disagree with the judge.',
  },
  {
    name: 'human_verdict',
    dataType: 'CATEGORICAL',
    description: 'What should happen about this turn?',
    categories: [
      { value: 1, label: 'fine' },
      { value: 0, label: 'needs_fix' },
      { value: 0.5, label: 'needs_investigation' },
    ],
  },
]

async function ensureScoreConfigs() {
  const existing = await api('GET', '/api/public/score-configs?limit=100').catch(() => ({ data: [] }))
  const byName = new Map((existing.data ?? []).map((c) => [c.name, c]))
  const ids = []
  for (const cfgDef of SCORE_CONFIGS) {
    const found = byName.get(cfgDef.name)
    if (found) { ids.push(found.id); console.log(`  · ${cfgDef.name} (exists)`); continue }
    const made = await api('POST', '/api/public/score-configs', cfgDef)
    ids.push(made.id)
    console.log(`  ✓ ${cfgDef.name}`)
  }
  return ids
}

async function ensureQueue(scoreConfigIds) {
  const existing = await api('GET', '/api/public/annotation-queues?limit=100').catch(() => ({ data: [] }))
  const found = (existing.data ?? []).find((q) => q.name === QUEUE_NAME)
  if (found) {
    // The queue API is create-and-read only — there is no PATCH. So a score
    // config added AFTER the queue was created never reaches the reviewer, and
    // the only symptom is a field quietly missing from the annotation form.
    // Say it out loud; a silent skip here is how someone spends an hour
    // labelling without the field you added for them.
    const attached = new Set(found.scoreConfigIds ?? [])
    const missing = scoreConfigIds.filter((id) => !attached.has(id))
    if (missing.length) {
      console.log(`  · queue exists (${found.id}) — ⚠ ${missing.length} score config(s) NOT attached`)
      console.log(`    The API cannot update a queue. Add them once in the UI:`)
      console.log(`    ${LANGFUSE_HOST} → Annotation Queues → ${QUEUE_NAME} → Settings → add the human_* configs`)
      console.log(`    (queued items are preserved; this is a form-field change, not a data change)`)
    } else {
      console.log(`  · queue exists (${found.id})`)
    }
    return found.id
  }
  const made = await api('POST', '/api/public/annotation-queues', {
    name: QUEUE_NAME,
    description: 'Mixed sample of agent turns — every judge failure plus a control sample of passes. Label these to check the judge, not just the agent.',
    scoreConfigIds,
  })
  console.log(`  ✓ queue created (${made.id})`)
  return made.id
}

/** Judge scores in the window, keyed by trace. */
async function judgeScoresByTrace() {
  const res = await api('GET', '/api/public/v2/scores?limit=100')
  const since = Date.now() - hours * 3600_000
  const map = new Map()
  for (const s of res.data ?? []) {
    if (!s.name?.startsWith('judge:')) continue
    if (new Date(s.timestamp ?? s.createdAt ?? 0).getTime() < since) continue
    const tid = s.traceId
    if (!tid) continue
    const entry = map.get(tid) ?? { failed: [], passed: [] }
    ;(Number(s.value) >= 1 ? entry.passed : entry.failed).push(s.name)
    map.set(tid, entry)
  }
  return map
}

if (doSeed) {
  console.log(`\nannotation queue — seeding from the last ${hours}h`)
  // Set up only for a real run. A --dry-run that creates three score configs
  // and a queue is not a dry run, and the surprise lands on whoever trusted
  // the flag.
  let queueId = null
  if (!dryRun) {
    console.log('  score configs:')
    const ids = await ensureScoreConfigs()
    console.log('  queue:')
    queueId = await ensureQueue(ids)
  } else {
    console.log('  [dry-run] score configs and queue not created')
  }

  const scores = await judgeScoresByTrace()
  const since = new Date(Date.now() - hours * 3600_000)
  const traces = ((await listTraces({ limit: 100 }))?.data ?? [])
    .filter((t) => new Date(t.timestamp) >= since)

  const failed = traces.filter((t) => (scores.get(t.id)?.failed?.length ?? 0) > 0)
  const passed = traces.filter((t) => {
    const s = scores.get(t.id)
    return s && s.failed.length === 0 && s.passed.length > 0
  })

  // Two thirds failures, one third controls — enough passes to catch a judge
  // that cries wolf, without wasting a reviewer's time on obvious fine cases.
  const wantFail = Math.min(failed.length, Math.ceil(maxItems * 0.66))
  const wantPass = Math.min(passed.length, maxItems - wantFail)
  const chosen = [
    ...failed.slice(0, wantFail).map((t) => ({ t, why: `judge failed: ${scores.get(t.id).failed.join(', ')}` })),
    // Spread the controls across the window rather than taking the newest few.
    ...passed.filter((_, i) => i % Math.max(1, Math.floor(passed.length / Math.max(1, wantPass))) === 0)
      .slice(0, wantPass).map((t) => ({ t, why: 'judge passed — control' })),
  ]

  console.log(`\n  ${failed.length} judge-failed / ${passed.length} judge-passed traces in window`)
  console.log(`  queueing ${chosen.length} (${wantFail} failures + ${wantPass} controls)\n`)

  if (dryRun) {
    for (const { t, why } of chosen) console.log(`  [dry-run] ${t.name.padEnd(22)} ${t.id.slice(0, 12)}  ${why}`)
    console.log()
    process.exit(0)
  }

  let added = 0
  for (const { t, why } of chosen) {
    try {
      await api('POST', `/api/public/annotation-queues/${queueId}/items`, {
        objectId: t.id, objectType: 'TRACE', status: 'PENDING',
      })
      added++
      console.log(`  + ${t.name.padEnd(22)} ${t.id.slice(0, 12)}  ${why}`)
    } catch (e) {
      console.log(`  ! ${t.id.slice(0, 12)}: ${e.message.slice(0, 120)}`)
    }
  }
  console.log(`\n  ${added} items queued.`)
  console.log(`  Annotate at: ${LANGFUSE_HOST} → Annotation Queues → "${QUEUE_NAME}"`)
  console.log(`  Then: node scripts/evals/langfuse/annotate.mjs --calibrate\n`)
}

if (doCal) {
  // ── Calibration: does the judge agree with the human? ─────────────────────
  console.log(`\njudge calibration — last ${hours}h\n`)
  const res = await api('GET', '/api/public/v2/scores?limit=100')
  const since = Date.now() - hours * 3600_000
  const byTrace = new Map()
  for (const s of res.data ?? []) {
    if (new Date(s.timestamp ?? s.createdAt ?? 0).getTime() < since) continue
    if (!s.traceId) continue
    const e = byTrace.get(s.traceId) ?? {}
    // Categorical scores carry the label in stringValue and a number in value.
    const val = s.stringValue != null ? s.stringValue : s.value
    e[s.name] = val
    byTrace.set(s.traceId, e)
  }

  const pairs = [['groundedness'], ['helpfulness']]
  let anyHuman = false
  for (const [criterion] of pairs) {
    const rows = []
    for (const [tid, s] of byTrace) {
      const h = s[`human_${criterion}`]
      const j = s[`judge:${criterion}`]
      if (h == null || j == null) continue
      anyHuman = true
      const humanPass = h === 'grounded' || h === 'useful' || Number(h) >= 1
      const judgePass = Number(j) >= 1
      rows.push({ tid, h, j, agree: humanPass === judgePass })
    }
    if (!rows.length) { console.log(`  ${criterion}: no trace has both a human and a judge label yet`); continue }
    const agree = rows.filter((r) => r.agree).length
    console.log(`  ${criterion}: ${agree}/${rows.length} agree (${((agree / rows.length) * 100).toFixed(0)}%)`)
    for (const r of rows.filter((x) => !x.agree)) {
      console.log(`     disagreement ${r.tid.slice(0, 12)}  human=${r.h}  judge=${r.j}`)
    }
  }
  if (!anyHuman) {
    console.log('\n  Nothing to compare. Seed the queue, label some traces in the UI, then re-run.')
    console.log(`  ${LANGFUSE_HOST} → Annotation Queues → "${QUEUE_NAME}"`)
  } else {
    console.log('\n  Every disagreement is worth opening. The judge being wrong and the')
    console.log('  annotator being wrong look identical in this table — only the trace says which.')
  }
  console.log()
}

if (doSecond) {
  // ── Second opinion: a DIFFERENT model re-grades the queue ─────────────────
  //
  // This is not a substitute for the human labels and must never be recorded
  // as one. A model cannot be its own ground truth, and two models agreeing
  // can be two models sharing a blind spot. What a second opinion DOES do is
  // triage: where a newer, independent model agrees with the primary judge,
  // confidence rises and a reviewer can skip it; where they disagree, that is
  // precisely the short list worth a person's time.
  //
  // Scores land under `judge2:` so they can never be mistaken for `human_`.
  const model = process.env.EVAL_JUDGE_MODEL
  if (!model) {
    console.error('\n✗ --second-opinion needs EVAL_JUDGE_MODEL set to a DIFFERENT model than the primary judge.')
    console.error('  e.g. EVAL_JUDGE_MODEL=gemini-3.7-flash ... --second-opinion\n')
    process.exit(1)
  }
  console.log(`\nsecond opinion — ${model}`)
  console.log('  NOT a human baseline. This narrows what a reviewer must read.\n')

  const queues = await api('GET', '/api/public/annotation-queues?limit=100').catch(() => ({ data: [] }))
  const queue = (queues.data ?? []).find((q) => q.name === QUEUE_NAME)
  if (!queue) { console.error(`✗ no queue "${QUEUE_NAME}". Run --seed first.\n`); process.exit(1) }

  const items = await api('GET', `/api/public/annotation-queues/${queue.id}/items?limit=100`).catch(() => ({ data: [] }))
  const traceIds = (items.data ?? []).filter((i) => i.objectType === 'TRACE').map((i) => i.objectId)
  console.log(`  ${traceIds.length} queued trace(s)\n`)

  // The primary judge's verdicts come off each TRACE, not from the scores list.
  // The list endpoint pages at 100 and this project already has 300+ scores, so
  // reading page one found none of the queued traces' verdicts and the whole
  // pass reported "0 posted" — a silent empty result rather than an error,
  // which is the worst way for a bug to present.
  const primaryFor = (trace) => {
    const m = new Map()
    for (const s of trace.scores ?? []) {
      if (!String(s.name).startsWith('judge:')) continue
      m.set(String(s.name).slice('judge:'.length), Number(s.value))
    }
    return m
  }

  let posted = 0, agree = 0, disagree = 0
  const conflicts = []

  for (const tid of traceIds) {
    const full = await getTrace(tid)
    if (!full) continue
    const obs = (full.observations ?? []).slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    const request = userRequest(full)
    const evidence = toolEvidence(full, obs)
    const gen = obs.filter((o) => o.type === 'GENERATION').at(-1)
    const answer = asText(gen?.output ?? full.output)
    if (!answer) continue
    const ctx = {
      input: evidence ? `${request}\n\n--- TOOL RESULTS (the source) ---\n${evidence}` : request,
      output: answer,
    }
    const prior = primaryFor(full)
    for (const criterion of ['groundedness', 'helpfulness']) {
      const before = prior.get(criterion)
      if (before === undefined) continue   // nothing to compare against
      try {
        const score = await runScorer(`judge:${criterion}`, ctx)
        if (!score) continue
        await postScore({
          traceId: tid, name: `judge2:${criterion}`, value: score.value,
          dataType: 'BOOLEAN', comment: score.comment,
          metadata: { secondOpinion: true, model, primaryValue: before },
        })
        posted++
        if (Number(score.value) === before) agree++
        else {
          disagree++
          conflicts.push({ tid, criterion, primary: before, second: Number(score.value), why: score.comment })
        }
      } catch (e) {
        console.log(`  ! ${tid.slice(0, 12)} / ${criterion}: ${e.message.slice(0, 120)}`)
      }
    }
  }

  const total = agree + disagree
  console.log(`  ${posted} second-opinion scores posted`)
  console.log(`  agreement with the primary judge: ${agree}/${total}` +
    (total ? ` (${((agree / total) * 100).toFixed(0)}%)` : ''))
  if (conflicts.length) {
    console.log(`\n  DISAGREEMENTS — read these ${conflicts.length} first:`)
    for (const c of conflicts) {
      console.log(`    ${c.tid.slice(0, 12)}  ${c.criterion}: primary=${c.primary} second=${c.second}`)
      console.log(`        ${String(c.why).slice(0, 190)}`)
    }
    console.log(`\n  The other ${agree} are where both models agreed — lower priority for a reviewer,`)
    console.log('  but agreement is not proof: two models can share a blind spot.')
  }
  console.log(`\n  Human queue is untouched: ${LANGFUSE_HOST} → Annotation Queues\n`)
}

if (!doSeed && !doCal && !doSecond) {
  console.error('usage: annotate.mjs --seed [--hours 24] [--max 20] [--dry-run]')
  console.error('       annotate.mjs --calibrate [--hours 24]')
  console.error('       EVAL_JUDGE_MODEL=<other-model> annotate.mjs --second-opinion')
  process.exit(1)
}
