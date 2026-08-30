#!/usr/bin/env node
/**
 * One front door for the eval suite.
 *
 *   pnpm evals              # this help
 *   pnpm evals:setup        # one-time wiring
 *   pnpm evals:check        # before you ship
 *   pnpm evals:review       # what production did
 *
 * The individual scripts are all still here, still single-purpose, still
 * runnable directly. What was missing was a front door: sixteen commands in
 * package.json with no indication which three anyone actually uses. Someone
 * new opened it and saw a folder of scripts rather than a system.
 *
 * So: three commands people run, mapped to the three moments they run them —
 * wiring it up, shipping a change, reading production. Everything else stays
 * reachable as `pnpm evals <name>` and is listed under "more" below, where it
 * is discoverable without being in the way.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const [, , command, ...rest] = process.argv

/** Run one script, inheriting stdio. Returns its exit code. */
function run(script, args = []) {
  const r = spawnSync('node', [path.join(DIR, script), ...args], { stdio: 'inherit' })
  return r.status ?? 1
}

/** Run several in order; stop at the first failure and return its code. */
function runAll(steps) {
  for (const [label, script, args] of steps) {
    console.log(`\n\x1b[1m── ${label}\x1b[0m`)
    const code = run(script, args)
    if (code !== 0) {
      console.error(`\n✗ "${label}" failed (exit ${code}). Stopping.\n`)
      return code
    }
  }
  return 0
}

/** The advanced scripts, reachable as `pnpm evals <name>`. */
const PASSTHROUGH = {
  push:       'push.mjs',
  run:        'run.mjs',
  selftest:   'selftest.mjs',
  traffic:    'traffic.mjs',
  rehearse:   'rehearse.mjs',
  analyze:    'analyze.mjs',
  health:     'health.mjs',
  score:      'score-production.mjs',
  sessions:   'score-sessions.mjs',
  annotate:   'annotate.mjs',
  promote:    'promote.mjs',
  compare:    'compare.mjs',
  evaluators: 'evaluators.mjs',
  dashboards: 'dashboards.mjs',
}

function help() {
  console.log(`
\x1b[1mdraftLegal eval suite\x1b[0m — LLM quality, offline and in production
Docs: docs/operations/LANGFUSE-EVALS.md

\x1b[1mThe three you actually run\x1b[0m

  pnpm evals:setup      One-time wiring. Pushes the golden corpora, creates the
                        two dashboards, and registers the continuous evaluators
                        so Langfuse scores new traffic by itself. Idempotent —
                        safe to re-run any time.

  pnpm evals:check      Before you ship. Proves the harness still grades
                        correctly, then runs the curated corpora. Exits non-zero
                        on a real failure, so CI can gate on it.

  pnpm evals:rehearse   Dress rehearsal. Runs the ENTIRE production loop locally —
                        traffic, Langfuse judging it unattended, the health check,
                        the review — so you can see it work before pointing any of
                        it at real users. Nothing but the LANGFUSE_* values change
                        when you move.

  pnpm evals:review     What production actually did. Volume, cost, latency,
                        errors and quality, sliced by surface, with findings.
                        Add --score to judge recent traffic first.

\x1b[1mEverything else\x1b[0m  (pnpm evals <name> -- [flags])

  health       Pass/fail production check — what the scheduled job runs
  traffic      Generate realistic traffic — DEV ONLY, spends real model budget
  score        LLM-judge recent traces, step by step
  sessions     Grade whole conversations, not single turns
  annotate     Human review queue, and judge-vs-human calibration
  promote      Turn production failures into permanent test cases
  compare      Diff two dataset runs — did the change help?
  evaluators   Manage Langfuse's own always-on judges
  dashboards   Rebuild the dashboards
  push · run · selftest · analyze     the individual steps

\x1b[1mFirst time here?\x1b[0m

  pnpm langfuse:up && pnpm evals:setup && pnpm evals:check
`)
}

switch (command) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    help()
    process.exit(0)
    break

  case 'setup':
    // Order matters: the corpora must exist before anything reads them, and
    // the evaluators are last because they are the only step that starts
    // spending money on its own.
    process.exit(runAll([
      ['golden corpora → Langfuse', 'push.mjs', []],
      ['dashboards',                'dashboards.mjs', []],
      ['continuous evaluators',     'evaluators.mjs', ['--apply', ...rest]],
    ]))
    break

  case 'check': {
    // The self-test first, always. If the harness itself misgrades, every
    // number after it is unreliable — and a green corpus run would be the most
    // misleading possible result.
    const steps = [['harness self-test', 'selftest.mjs', []]]
    const datasets = rest.filter((a) => !a.startsWith('--'))
    const flags = rest.filter((a) => a.startsWith('--'))
    for (const d of datasets.length ? datasets : ['extraction', 'chat']) {
      steps.push([`corpus: ${d}`, 'run.mjs', ['--dataset', d, ...flags]])
    }
    process.exit(runAll(steps))
    break
  }

  case 'review': {
    const wantScore = rest.includes('--score')
    const flags = rest.filter((a) => a !== '--score')
    const steps = []
    if (wantScore) {
      steps.push(['judging recent traffic', 'score-production.mjs', flags])
      steps.push(['grading conversations',  'score-sessions.mjs',   flags])
    }
    steps.push(['production review', 'analyze.mjs', flags])
    process.exit(runAll(steps))
    break
  }

  default: {
    const script = PASSTHROUGH[command]
    if (!script) {
      console.error(`\n✗ unknown command "${command}"\n`)
      help()
      process.exit(1)
    }
    process.exit(run(script, rest))
  }
}
