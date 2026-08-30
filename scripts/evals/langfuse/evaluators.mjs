#!/usr/bin/env node
/**
 * Langfuse's OWN continuous evaluators — the judge that runs without us.
 *
 *   node scripts/evals/langfuse/evaluators.mjs --apply --sampling 0.05
 *   node scripts/evals/langfuse/evaluators.mjs --dry-run
 *   node scripts/evals/langfuse/evaluators.mjs --status
 *
 * `score-production.mjs` judges traces when somebody runs it. This registers
 * the same rubrics INSIDE Langfuse, as observation-level LLM-as-a-judge rules
 * that fire on new production data by themselves. That is the difference
 * between an evaluation you remember to do and one that is simply always on.
 *
 * Same rubric text on both sides, imported from `scorers.mjs` rather than
 * retyped — an online `groundedness` and an offline `groundedness` have to mean
 * the same thing or the two numbers cannot be compared, which is most of the
 * reason to have both.
 *
 * Three objects, in order:
 *   1. an LLM connection      — the judge's own model credentials
 *   2. evaluators             — a named rubric + output shape
 *   3. evaluation rules       — what to run each evaluator ON, and how often
 *
 * OBSERVATION-level, never trace-level: trace-level evaluators are deprecated
 * and stop producing results on Langfuse Cloud after 16 November 2026. It is
 * also the right altitude — grading the retrieval step separately from the
 * answer is the whole point (see score-production.mjs).
 *
 * SAMPLING defaults to 0.05 — the low end of the 1–5% published guidance for
 * production LLM judging, not a number picked for comfort. A local rehearsal at
 * 20% put the judge at 48% OF TOTAL MODEL SPEND: the graders cost about as much
 * as the product they were grading. At real traffic volumes that ratio is the
 * difference between observability and an unexplained bill.
 *
 * Raise it deliberately: for a low-traffic high-risk flow, 5% of ten calls a day
 * measures nothing, and near-complete coverage is the right call there. Lower it
 * for anything high-volume. `--sampling` on a re-run CONVERGES an existing rule
 * rather than skipping it, so changing your mind is one command.
 */
import fs from 'node:fs'
import { requireConfig, LANGFUSE_HOST } from './lf.mjs'
import { RUBRICS } from './scorers.mjs'

const cfg = requireConfig()
const auth = 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const sampling = Number(arg('sampling', '0.05'))
const apply    = process.argv.includes('--apply')
const dryRun   = process.argv.includes('--dry-run')
const status   = process.argv.includes('--status')

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

/**
 * The judge model. Mirrors scorers.mjs precedence so the in-platform judge and
 * the script judge are the same model unless someone deliberately changes it —
 * two judges disagreeing because they are different models is a confusing way
 * to discover you configured them separately.
 */
function judgeConnection() {
  const model = process.env.EVAL_JUDGE_MODEL
  const usable = (v) => typeof v === 'string' && v.trim().length >= 20
  if (usable(process.env.ANTHROPIC_API_KEY)) {
    return { provider: 'draftlegal-judge', adapter: 'anthropic', secretKey: process.env.ANTHROPIC_API_KEY, model: model ?? 'claude-sonnet-4-6' }
  }
  if (usable(process.env.OPENAI_API_KEY)) {
    return { provider: 'draftlegal-judge', adapter: 'openai', secretKey: process.env.OPENAI_API_KEY, model: model ?? 'gpt-4.1' }
  }
  const g = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY
  if (usable(g)) {
    return { provider: 'draftlegal-judge', adapter: 'google-ai-studio', secretKey: g, model: model ?? 'gemini-2.5-pro' }
  }
  return null
}

/**
 * `{{variables}}` are filled by the rule's mapping below. Each prompt is the
 * shared rubric plus the JSON contract Langfuse expects back.
 */
/**
 * Human corrections, from the same store the script judge reads.
 *
 * Both judges must carry the same corrections or they drift apart, and then a
 * disagreement between them tells you nothing about the product — only that
 * one of them was updated and the other was not.
 *
 * Note the operational consequence: after `--emit-examples` writes new
 * corrections, the in-platform judge does NOT pick them up until
 * `evaluators.mjs --apply` pushes the new prompt. The script judge reads the
 * file at run time; this one has a copy stored inside Langfuse.
 */
function calibrationExamples(criterion) {
  let examples = []
  try {
    const raw = fs.readFileSync(new URL('./calibration/examples.json', import.meta.url), 'utf8')
    examples = JSON.parse(raw).examples ?? []
  } catch { return '' }
  const mine = examples.filter((e) => e.criterion === criterion).slice(0, 8)
  if (!mine.length) return ''
  return [
    '',
    'The following cases were previously scored INCORRECTLY and corrected by a',
    'human reviewer. Match their reasoning.',
    '',
    ...mine.map((e, i) => [
      `--- CORRECTED EXAMPLE ${i + 1} ---`,
      `INPUT: ${String(e.input ?? '').slice(0, 900)}`,
      `ANSWER: ${String(e.output ?? '').slice(0, 900)}`,
      `CORRECT SCORE: ${e.correct}`,
      `WHY: ${String(e.why ?? '').slice(0, 400)}`,
    ].join('\n')),
    '',
  ].join('\n')
}

function judgePrompt(criterion, vars) {
  return [
    `You are grading the output of a contract-lifecycle assistant.`,
    ``,
    `CRITERION (${criterion}): ${RUBRICS[criterion]}`,
    calibrationExamples(criterion) || null,
    ``,
    ...vars.map((v) => `${v.toUpperCase()}:\n{{${v}}}`),
    ``,
    `Reason briefly, then score. Score 1 if the criterion is met, 0 if not.`,
  ].filter((line) => line !== null).join('\n')
}

/**
 * What runs where.
 *
 * `filter` narrows a rule to the observations it makes sense on: grading a tool
 * result for "helpfulness" or an answer for "retrieval sufficiency" spends money
 * to produce a meaningless number.
 */
const EVALUATORS = [
  {
    criterion: 'groundedness',
    vars: ['input', 'output'],
    target: 'GENERATION',
    mapping: [
      { variable: 'input',  source: 'input' },
      { variable: 'output', source: 'output' },
    ],
  },
  {
    criterion: 'helpfulness',
    vars: ['input', 'output'],
    target: 'GENERATION',
    mapping: [
      { variable: 'input',  source: 'input' },
      { variable: 'output', source: 'output' },
    ],
  },
  {
    criterion: 'retrieval_sufficiency',
    vars: ['input', 'output'],
    target: 'TOOL',
    mapping: [
      { variable: 'input',  source: 'input' },
      { variable: 'output', source: 'output' },
    ],
  },
]

const NAME = (criterion) => `draftlegal ${criterion}`

if (status) {
  const conns = await api('GET', '/api/public/llm-connections').catch(() => ({ data: [] }))
  const evals = await api('GET', '/api/public/unstable/evaluators?limit=100').catch(() => ({ data: [] }))
  const rules = await api('GET', '/api/public/unstable/evaluation-rules?limit=100').catch(() => ({ data: [] }))
  const ours = (evals.data ?? []).filter((e) => e.scope === 'project')
  console.log(`\nevaluator status — ${LANGFUSE_HOST}\n`)
  console.log(`  LLM connections : ${(conns.data ?? []).map((c) => `${c.provider} (${c.adapter})`).join(', ') || 'NONE — the judge cannot run'}`)
  console.log(`  project evaluators: ${ours.length}`)
  for (const e of ours) console.log(`     ${e.name}  vars=[${(e.variables ?? []).join(', ')}]  rules=${e.evaluationRuleCount ?? 0}`)
  console.log(`  rules           : ${(rules.data ?? []).length}`)
  for (const r of rules.data ?? []) {
    console.log(`     ${r.name}  target=${r.target}  enabled=${r.enabled}  sampling=${r.sampling ?? 1}`)
  }
  console.log()
  process.exit(0)
}

if (!apply && !dryRun) {
  console.error('usage: evaluators.mjs --apply [--sampling 0.05] | --dry-run | --status')
  process.exit(1)
}

const conn = judgeConnection()
if (!conn) {
  console.error('\n✗ no judge key. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY.\n')
  process.exit(1)
}

console.log(`\ncontinuous evaluators → ${LANGFUSE_HOST}`)
console.log(`  judge     : ${conn.adapter} / ${conn.model}`)
console.log(`  target    : observation-level (trace-level is deprecated after 2026-11-16)`)
console.log(`  sampling  : ${(sampling * 100).toFixed(0)}% of matching observations\n`)

for (const e of EVALUATORS) {
  console.log(`  ${e.criterion.padEnd(24)} on ${e.target} observations`)
}

if (dryRun) { console.log('\n[dry-run] nothing created\n'); process.exit(0) }

// 1. The judge's credentials. PUT is an upsert keyed on provider name.
await api('PUT', '/api/public/llm-connections', {
  provider: conn.provider,
  adapter: conn.adapter,
  secretKey: conn.secretKey,
  withDefaultModels: true,
})
console.log(`\n  ✓ llm connection "${conn.provider}"`)

// 2. Evaluators. Names are checked first — this API has no upsert, so a second
//    run would otherwise stack duplicates that all fire on the same data.
const existingEvals = await api('GET', '/api/public/unstable/evaluators?limit=100').catch(() => ({ data: [] }))
const evalByName = new Map((existingEvals.data ?? []).map((e) => [e.name, e]))

for (const e of EVALUATORS) {
  const name = NAME(e.criterion)
  const existing = evalByName.get(name)
  const wanted = judgePrompt(e.criterion, e.vars)
  if (existing) {
    // A stale prompt is worse than no prompt: it looks configured while
    // silently missing every correction a reviewer has made since. The API has
    // no update for evaluators, so say so rather than printing "exists" and
    // moving on.
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
    if (norm(existing.prompt) !== norm(wanted)) {
      console.log(`  ⚠ evaluator "${name}" exists but its prompt is STALE`)
      console.log(`     (calibration examples have changed since it was created)`)
      console.log(`     Delete it in the UI and re-run --apply to pick up the corrections:`)
      console.log(`     ${LANGFUSE_HOST} → Evaluations → Evaluators → ${name}`)
    } else {
      console.log(`  · evaluator "${name}" (up to date)`)
    }
    continue
  }
  try {
    await api('POST', '/api/public/unstable/evaluators', {
      type: 'llm_as_judge',
      name,
      prompt: wanted,
      // BOOLEAN output requires BOTH field definitions — `reasoning` is not
      // optional, and that is a good constraint: a bare 1/0 with no stated
      // reason is unreviewable, and reviewing the reason is how you catch a
      // judge that is confidently wrong.
      outputDefinition: {
        dataType: 'BOOLEAN',
        reasoning: { description: 'One or two sentences explaining the verdict, citing the specific claim or data point that decided it.' },
        score: { description: 'true if the criterion is met, false if not.' },
      },
      modelConfig: { provider: conn.provider, model: conn.model },
    })
    console.log(`  ✓ evaluator "${name}"`)
  } catch (err) {
    console.log(`  ✗ evaluator "${name}": ${err.message.slice(0, 200)}`)
  }
}

// 3. Rules — what each evaluator runs on.
const existingRules = await api('GET', '/api/public/unstable/evaluation-rules?limit=100').catch(() => ({ data: [] }))
const ruleByName = new Map((existingRules.data ?? []).map((r) => [r.name, r]))

for (const e of EVALUATORS) {
  const name = `${NAME(e.criterion)} — live`
  const existing = ruleByName.get(name)
  if (existing) {
    // Converge rather than skip. Re-running with a different --sampling should
    // CHANGE the sampling, not silently leave the old value in place while
    // printing a reassuring "exists" — that is how a rule ends up at 100% in
    // production because someone tested at 100% locally months ago.
    if (Number(existing.sampling ?? 1) !== sampling || existing.enabled === false) {
      try {
        await api('PATCH', `/api/public/unstable/evaluation-rules/${existing.id}`, { sampling, enabled: true })
        console.log(`  ✓ rule "${name}" updated → sampling ${(sampling * 100).toFixed(0)}%, enabled`)
      } catch (err) {
        console.log(`  ✗ rule "${name}" update: ${err.message.slice(0, 180)}`)
      }
    } else {
      console.log(`  · rule "${name}" (already ${(sampling * 100).toFixed(0)}%)`)
    }
    continue
  }
  try {
    await api('POST', '/api/public/unstable/evaluation-rules', {
      name,
      evaluator: { name: NAME(e.criterion), scope: 'project', type: 'llm_as_judge' },
      target: 'observation',
      enabled: true,
      sampling,
      // A stringOptions filter — operator is "any of"/"none of" with an ARRAY
      // value. The plain string filter (`=`) is a different union member and is
      // rejected here.
      // A stringOptions filter: operator is "any of"/"none of", value is an
      // ARRAY, and `type` is a required discriminator for the filter union.
      // The plain string filter (`=`, scalar value) is a different member and
      // is rejected here.
      filter: [{ column: 'type', operator: 'any of', value: [e.target], type: 'stringOptions' }],
      mapping: e.mapping,
    })
    console.log(`  ✓ rule "${name}"  (${e.target}, ${(sampling * 100).toFixed(0)}%)`)
  } catch (err) {
    console.log(`  ✗ rule "${name}": ${err.message.slice(0, 240)}`)
  }
}

console.log(`\n  Verify: node scripts/evals/langfuse/evaluators.mjs --status`)
console.log(`  Scores appear on new traces automatically — no script run required.\n`)
