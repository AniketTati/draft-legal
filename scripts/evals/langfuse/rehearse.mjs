#!/usr/bin/env node
/**
 * Local dress rehearsal — run the entire production loop on your own machine.
 *
 *   pnpm evals:rehearse                 # ~10 min, real model calls
 *   pnpm evals:rehearse -- --quick      # smaller, ~4 min
 *   pnpm evals:rehearse -- --dry-run    # show the plan, send nothing
 *
 * The point is confidence before commitment. Every mechanism that would run in
 * production runs here first, against the local Langfuse, with traffic you
 * generate — so you can watch each step work and know what "healthy" looks like
 * before anything is pointed at real users.
 *
 * Nothing here is production-specific. The SAME scripts run against Langfuse
 * Cloud later; only the three LANGFUSE_* values change. That is the whole
 * argument for rehearsing locally: if it works here it works there, because it
 * is not a different code path.
 *
 * What it proves, in order:
 *   1. preflight   the pieces are running and configured
 *   2. traffic     real agent calls, traced, across every surface
 *   3. auto-judge  Langfuse scoring by ITSELF, with no script involved
 *   4. health      the pass/fail check the scheduled job will run
 *   5. review      the report a human reads
 *
 * Step 3 is the one worth watching. Everything else is a script you invoked;
 * that step is the platform doing it on its own, which is what production
 * actually depends on.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configured, LANGFUSE_HOST } from './lf.mjs'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const quick = argv.includes('--quick')
const dryRun = argv.includes('--dry-run')
const journeys = quick ? '3' : '8'

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const corpus = arg('corpus', null)

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim  = (s) => `\x1b[2m${s}\x1b[0m`

function run(script, args, { allowFail = false } = {}) {
  const r = spawnSync('node', [path.join(DIR, script), ...args], { stdio: 'inherit' })
  const code = r.status ?? 1
  if (code !== 0 && !allowFail) throw new Error(`${script} exited ${code}`)
  return code
}

function step(n, title, why) {
  console.log(`\n${bold(`── ${n}. ${title}`)}`)
  console.log(dim(`   ${why}\n`))
}

// ── Preflight ────────────────────────────────────────────────────────────────
console.log(`\n${bold('Local dress rehearsal')} — the production loop, on this machine`)
console.log(dim(`   ${LANGFUSE_HOST || '(LANGFUSE_HOST unset)'}\n`))

const problems = []
if (!configured()) problems.push('Langfuse is not configured — set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY')
if (!process.env.INTERNAL_SERVICE_SECRET) problems.push('INTERNAL_SERVICE_SECRET is unset — traffic generation will 401')
const judgeKey = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY]
  .some((v) => typeof v === 'string' && v.trim().length >= 20)
if (!judgeKey) problems.push('no model key — traffic and judging both need one')

const agentsBase = process.env.AGENTS_BASE ?? 'http://localhost:8002'
let agentsUp = false
try {
  const res = await fetch(`${agentsBase}/health`, { signal: AbortSignal.timeout(4000) })
  agentsUp = res.ok
} catch { agentsUp = false }
if (!agentsUp) problems.push(`agents service not answering at ${agentsBase} (set AGENTS_BASE if it is elsewhere)`)

if (problems.length) {
  console.error(bold('✗ Not ready:\n'))
  for (const p of problems) console.error(`   · ${p}`)
  console.error('\n   docs/operations/LANGFUSE-EVALS.md has the setup.\n')
  process.exit(1)
}
console.log('✓ preflight: Langfuse, agents service, model key, internal secret — all present')

if (dryRun) {
  console.log(`\n${dim('[dry-run] would then:')}`)
  console.log(`   2. generate ${journeys} journeys of real traffic across every LLM surface`)
  console.log('   3. wait for Langfuse to score it automatically')
  console.log('   4. run the health check (the one the scheduled job runs)')
  console.log('   5. print the production review\n')
  process.exit(0)
}

// ── 2. Traffic ───────────────────────────────────────────────────────────────
step(2, 'Generate real traffic',
  'Real agent calls across extraction, the AI Assistant and the Chat Agent. This is\n   what production would be sending; here you are sending it deliberately.')
run('traffic.mjs', ['--journeys', journeys, '--concurrency', '3', '--run', 'rehearsal',
  ...(corpus ? ['--corpus', corpus] : [])])

// ── 3. Let the platform judge it, unaided ────────────────────────────────────
step(3, 'Wait for Langfuse to score it by itself',
  'The continuous evaluators fire on new observations with no script involved. This\n   is the step that matters — production depends on it happening unattended.')

const before = await countEvalScores()
process.stdout.write('   waiting')
let after = before
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 6000))
  process.stdout.write('.')
  after = await countEvalScores()
  if (after > before) break
}
console.log()
if (after > before) {
  console.log(`   ✓ Langfuse produced ${after - before} score(s) on its own (source=EVAL)`)
} else {
  console.log('   ⚠ no automatic scores yet. Either the evaluators are not set up')
  console.log('     (run `pnpm evals:setup`), or sampling skipped this batch.')
  console.log('     Not fatal — the rehearsal continues, but this is the step to fix')
  console.log('     before trusting production, because nothing else replaces it.')
}

async function countEvalScores() {
  try {
    const auth = 'Basic ' + Buffer.from(
      `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64')
    const q = JSON.stringify({
      view: 'scores-boolean',
      metrics: [{ measure: 'count', aggregation: 'count' }],
      filters: [{ column: 'source', operator: 'any of', value: ['EVAL'], type: 'stringOptions' }],
      fromTimestamp: new Date(Date.now() - 3600_000).toISOString(),
      toTimestamp: new Date(Date.now() + 300_000).toISOString(),
    })
    const res = await fetch(`${LANGFUSE_HOST.replace(/\/$/, '')}/api/public/metrics?query=${encodeURIComponent(q)}`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return 0
    const d = await res.json()
    return Number(d.data?.[0]?.count_count ?? 0)
  } catch { return 0 }
}

// ── 4. The health check ──────────────────────────────────────────────────────
step(4, 'Run the health check',
  'Exactly what the twice-daily scheduled job runs. Exit 0 healthy, 1 not.\n   A FAILURE here is a success for the rehearsal — it means the alarm works.')
const healthCode = run('health.mjs', ['--hours', '2'], { allowFail: true })

// ── 5. The review ────────────────────────────────────────────────────────────
step(5, 'Print the production review',
  'The report a human reads: volume, cost, latency, errors and quality by surface.')
run('analyze.mjs', ['--hours', '2'], { allowFail: true })

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(bold('\n══ Rehearsal complete\n'))
console.log('   You just ran, end to end, the same mechanisms production will use:')
console.log('     · traffic traced with every step recorded');
console.log('     · Langfuse judging it unattended');
console.log(`     · the health check ${healthCode === 0 ? 'passing' : 'FAILING — read the failed check above'}`)
console.log('     · the review a human reads\n')
console.log('   Look at it yourself:')
console.log(`     ${LANGFUSE_HOST} → Dashboards      the two standing views`)
console.log(`     ${LANGFUSE_HOST} → Tracing → Sessions   the conversations behind the numbers\n`)
console.log('   When you move to production, NOTHING here changes except the three')
console.log('   LANGFUSE_* values. Same scripts, same thresholds, different host.\n')

process.exit(0)
