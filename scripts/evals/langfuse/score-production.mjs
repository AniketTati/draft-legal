#!/usr/bin/env node
/**
 * Online evaluation — score real production traces with the LLM judge.
 *
 *   node scripts/evals/langfuse/score-production.mjs --hours 3 --sample 0.3
 *   node scripts/evals/langfuse/score-production.mjs --hours 24 --limit 40 --dry-run
 *
 * Offline evals (run.mjs) ask "did my change break the cases I curated". This
 * asks the other half: "is what real users are actually getting any good".
 * Both are needed — a curated corpus only knows the failures you already
 * thought of, and production only tells you about inputs you cannot control.
 *
 * Langfuse can also do this in-platform: Evaluators → observation-level
 * LLM-as-a-judge, which needs an LLM Connection configured in the project and
 * runs continuously without anything of ours in the loop. Prefer that for a
 * standing setup. This script exists because it needs no UI configuration, it
 * reuses the SAME rubrics as the offline scorers — so an online
 * `judge:groundedness` means exactly what the offline one means, which is the
 * whole point of having both — and it version-controls with the repo.
 *
 * SAMPLE. At roughly $0.01–0.10 per judged assessment, scoring every
 * observation on every turn is a real line item. Default is 100% because these
 * runs are small; drop it for anything continuous.
 */
import { requireConfig, listTraces, postScore, LANGFUSE_HOST } from './lf.mjs'
import { runScorer, judgeAvailable, RUBRICS } from './scorers.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const hours   = Number(arg('hours', '3'))
const limit   = Number(arg('limit', '50'))
const sample  = Number(arg('sample', '1.0'))
const dryRun  = process.argv.includes('--dry-run')
const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

/**
 * Which rubrics apply to which surface.
 *
 * Not everything deserves a judge. `assist.complete` is a two-word
 * autocomplete and `classify.detect` returns an enum — a judge there costs
 * money to confirm what the shape already tells you. Groundedness is the one
 * that matters everywhere text is generated from a document: it is the only
 * check that catches a fluent, well-formed, completely invented answer.
 */
const RUBRICS_BY_SURFACE = {
  'agent.chat':            ['groundedness', 'helpfulness'],
  'ask.answer':            ['groundedness', 'citation'],
  'obligations.extract':   ['groundedness'],
  'compliance.check':      ['groundedness'],
  'renewal.advice':        ['groundedness', 'helpfulness'],
  'assist.rewrite':        ['helpfulness'],
  'assist.simplify':       ['helpfulness'],
  'assist.redline_propose':['helpfulness'],
  'intake.classify':       ['groundedness'],
}

if (!judgeAvailable()) {
  console.error('\n✗ no judge key. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY.\n')
  process.exit(1)
}

/** Full trace detail — the list endpoint does not return input/output bodies. */
async function getTrace(id) {
  const res = await fetch(`${cfg.host.replace(/\/$/, '')}/api/public/traces/${id}`, { headers: { Authorization: auth } })
  if (!res.ok) return null
  return res.json()
}

/**
 * Pull the part a judge should actually read.
 *
 * A raw chat trace input is the entire message list: system prompt, every tool
 * JSON-schema, and the history — tens of thousands of characters, most of it
 * irrelevant. Feeding that to a judge is expensive and makes it worse at the
 * job, because the thing being asked about is buried. Take the last user turn
 * and any tool results, which is the evidence the answer should be grounded in.
 */
function extractForJudging(trace) {
  const inp = trace.input
  let question = ''
  let evidence = ''
  if (Array.isArray(inp)) {
    const users = inp.filter((m) => m?.role === 'user')
    question = typeof users.at(-1)?.content === 'string' ? users.at(-1).content : JSON.stringify(users.at(-1)?.content ?? '')
    const tools = inp.filter((m) => m?.role === 'tool' || m?.type === 'tool')
    // Tool results are the ENTIRE basis for a groundedness verdict, so this
    // budget has to hold the whole result. At 5000 a 20-row renewal listing was
    // cut to its first six rows and four correct answers were judged
    // hallucinations. Keep it generous; scorers.mjs declares any further clip.
    evidence = tools.map((t) => (typeof t.content === 'string' ? t.content : JSON.stringify(t.content))).join('\n').slice(0, 20000)
  } else if (typeof inp === 'string') {
    question = inp
  } else if (inp) {
    question = JSON.stringify(inp)
  }
  const out = trace.output
  const answer = typeof out === 'string' ? out
    : typeof out?.content === 'string' ? out.content
    : JSON.stringify(out ?? '')
  return {
    input: evidence ? `${question.slice(0, 4000)}\n\n--- TOOL RESULTS (the source) ---\n${evidence}` : question.slice(0, 20000),
    output: answer,
  }
}

const since = new Date(Date.now() - hours * 3600_000)
const all = await listTraces({ limit: 100 })
const candidates = (all?.data ?? [])
  .filter((t) => new Date(t.timestamp) >= since)
  .filter((t) => RUBRICS_BY_SURFACE[t.name])
  .slice(0, limit)

// Deterministic sampling by position — a random sample would score a different
// subset every run, which makes a trend line meaningless.
const picked = candidates.filter((_, i) => (sample >= 1 ? true : i % Math.round(1 / sample) === 0))

console.log(`\nonline scoring — last ${hours}h`)
console.log(`  ${candidates.length} scorable traces, ${picked.length} sampled (${(sample * 100).toFixed(0)}%)`)
console.log(`  rubrics: ${Object.keys(RUBRICS).join(', ')}\n`)

if (dryRun) {
  for (const t of picked) console.log(`  [dry-run] ${t.name.padEnd(24)} ${RUBRICS_BY_SURFACE[t.name].join(', ')}`)
  console.log()
  process.exit(0)
}

let scored = 0, failed = 0
const tally = new Map()

for (const t of picked) {
  const full = await getTrace(t.id)
  if (!full) { failed++; continue }
  const ctx = extractForJudging(full)
  if (!ctx.output || ctx.output === '""') { continue }   // nothing was said; nothing to judge

  for (const criterion of RUBRICS_BY_SURFACE[t.name]) {
    try {
      const score = await runScorer(`judge:${criterion}`, ctx)
      if (!score) continue
      await postScore({ traceId: t.id, ...score, metadata: { onlineEval: true, surface: t.name } })
      const key = `${t.name} · ${criterion}`
      const agg = tally.get(key) ?? { pass: 0, fail: 0 }
      Number(score.value) >= 1 ? agg.pass++ : agg.fail++
      tally.set(key, agg)
      scored++
      if (Number(score.value) < 1) {
        console.log(`  ✗ ${t.name} / ${criterion}  (${t.id.slice(0, 12)})`)
        console.log(`      ${score.comment.slice(0, 220)}`)
      }
    } catch (e) {
      failed++
      console.log(`  ! ${t.name} / ${criterion}: ${e.message.slice(0, 140)}`)
    }
  }
}

console.log(`\n  ${scored} scores posted${failed ? `, ${failed} failed` : ''}\n`)
console.log('  by surface · criterion:')
for (const [k, a] of [...tally].sort()) {
  const total = a.pass + a.fail
  const rate = total ? ((a.pass / total) * 100).toFixed(0) : '—'
  console.log(`    ${k.padEnd(40)} ${a.pass}/${total}  ${rate}%`)
}
console.log(`\n  ${LANGFUSE_HOST} → Tracing → Scores (or the Quality section of analyze.mjs)\n`)
