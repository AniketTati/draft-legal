#!/usr/bin/env node
/**
 * E1 — the eval gate can actually fail.
 *
 * The step this suite replaces was, verbatim:
 *
 *     run: pytest tests/ -v --tb=short || true
 *
 * with `apps/agents/tests/` not existing. Three independent reasons it could
 * never fail: no directory, nothing invoked the eval package at all, and
 * `|| true` forced exit 0 regardless. Its own comment admitted it reported
 * nothing. Adding eval cases behind a gate like that produces more dead
 * controls, which is the defect class docs/36 spent four waves removing.
 *
 * So this check watches the gate fail, four ways, before anything is trusted to
 * it. It runs the real runner against a FIXTURE tree (scripts/evals/fixtures/)
 * rather than mutating live checks — a check that has to break the suite to
 * test the suite is one nobody will run twice.
 *
 * Run BEFORE: `pytest tests/ ... || true` — exit 0 always.
 * Run AFTER:  a failing, empty, deleted or shrunken check each fail the build.
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIX  = 'scripts/evals/fixtures'

/** Run the real runner against the fixture tree. */
function run(extra = []) {
  const r = spawnSync('node', [
    'scripts/evals/run.mjs', '--tier', 't1',
    '--dir', `${FIX}/checks`, '--manifest', `${FIX}/manifest.mjs`,
    '--baseline-path', `${FIX}/baseline.json`, ...extra,
  ], { cwd: REPO, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ─── 1. The gate fails on a failing check ───────────────────────────────────

section('1. A failing check fails the run')
{
  const r = run()
  check('the runner exits non-zero', r.code !== 0,
    `exit ${r.code} — the step this replaces exited 0 unconditionally`)
  check('it names the check that failed', /FAILED failing/.test(r.out),
    'an exit code with no name is not actionable in CI')
}

// ─── 2. A check that asserts nothing is a failure, not a pass ───────────────
//
// The harness this supersedes returned True with a warning string that reached
// neither the failure count nor the exit code, so a case with a forgotten
// `expected` block INFLATED the pass rate.

section('2. An assertion-free check cannot pass')
{
  const r = run()
  check('the empty fixture is reported as EMPT, not ok', /EMPT\s+empty/.test(r.out),
    'a check that asserted nothing is indistinguishable from one that was never written')
  check('it does not count toward passes', !/^2 passed/m.test(r.out),
    r.out.split('\n').find(l => /passed ·/.test(l)) ?? '')
}

// ─── 3. Deleting a check is caught ──────────────────────────────────────────
//
// The Python harness iterated case directories off disk, so deleting a case
// produced "no regressions" and exit 0 — verified during scouting. Deleting an
// inconvenient check must not be a way to go green.

section('3. A deleted check is a regression, not a silence')
{
  // Baseline the fixture tree as it stands, then hide a check.
  run(['--baseline'])
  const hidden = `${REPO}/${FIX}/checks/passing.mjs`
  const stash  = `${REPO}/${FIX}/checks/.passing.stash`
  let ok = false, out = ''
  try {
    fs.renameSync(hidden, stash)
    const r = run(['--check-baseline'])
    out = r.out
    ok = r.code === 3 && /passing: PRESENT → GONE|passing: pass → missing/.test(r.out)
  } finally {
    if (fs.existsSync(stash)) fs.renameSync(stash, hidden)
  }
  check('a vanished check exits 3 and is named', ok,
    ok ? 'caught' : `exit/output did not report the deletion: ${out.slice(-260)}`)
}

// ─── 4. A check that quietly asserts LESS is caught ─────────────────────────
//
// The subtlest of the four, and the one pass/fail alone cannot see: everything
// stays green while coverage drains away.

section('4. Losing assertions is a regression even when everything passes')
{
  const file = `${REPO}/${FIX}/checks/passing.mjs`
  const original = fs.readFileSync(file, 'utf8')
  let ok = false, out = ''
  try {
    run(['--baseline'])
    fs.writeFileSync(file, original.replace("check('and another', true)\n", ''))
    const r = run(['--check-baseline'])
    out = r.out
    ok = r.code === 3 && /assertions 2 → 1 \(coverage lost\)/.test(r.out)
  } finally {
    fs.writeFileSync(file, original)
    run(['--baseline'])
  }
  check('a shrinking check exits 3 while still passing', ok,
    ok ? 'caught — 0 failures, still exit 3' : `not caught: ${out.slice(-260)}`)
}

// ─── 5. The wiring, so this cannot be quietly undone ────────────────────────

section('5. CI runs it, and cannot swallow the result')
{
  const ci = fs.readFileSync(`${REPO}/.github/workflows/ci.yml`, 'utf8')
  const job = ci.slice(ci.indexOf('agent-evals:'))
  check('a CI job runs the eval suite', /node scripts\/evals\/run\.mjs/.test(job),
    'the previous step invoked a module that did not exist')
  check('it compares against the baseline', /--check-baseline/.test(job),
    'without it, a deleted or shrunken check is invisible')
  // Scoped to the job, not the file: other jobs may legitimately use `|| true`.
  check('the eval step does not swallow its exit code', !/\|\|\s*true/.test(job),
    '`|| true` is what made the step this replaces incapable of failing')
  check('no pytest step against a non-existent directory remains',
    !/run:\s*pytest tests\//.test(ci),
    'it reported success for a directory that was never created')
}

// ─── 6. Every check on disk is actually run ─────────────────────────────────

section('6. No check is orphaned')
{
  const { CHECKS } = await import(`${REPO}/scripts/evals/manifest.mjs`)
  const onDisk = fs.readdirSync(`${REPO}/scripts/agent-loops`)
    .filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, ''))
  const unlisted = onDisk.filter(id => !CHECKS.some(c => c.id === id))
  check('every check file is in the manifest', unlisted.length === 0,
    unlisted.length ? `orphaned: ${unlisted.join(', ')} — nothing runs these` : `${onDisk.length} checks, all listed`)

  const missing = CHECKS.filter(c => !fs.existsSync(`${REPO}/scripts/agent-loops/${c.id}.mjs`))
  check('every manifest entry has a file', missing.length === 0,
    missing.length ? `listed but absent: ${missing.map(m => m.id).join(', ')}` : 'all present')

  const tiered = CHECKS.filter(c => !['t1', 't2', 't3'].includes(c.tier))
  check('every check declares a valid tier', tiered.length === 0,
    tiered.length ? `bad tier: ${tiered.map(t => t.id).join(', ')}` : '')
}

// ─── 7. Tier 1 really needs nothing ─────────────────────────────────────────
//
// This claim was FALSE when first made, and CI caught it on the gate's first
// real run: every check imports the shared harness, which statically imported
// PrismaClient from apps/api/node_modules, so all five tier-1 checks died on a
// module-resolution error on a clean checkout. "No services, no database, $0"
// has to be enforced, not asserted in a comment.

section('7. Tier 1 pulls in no database client')
{
  const harness = fs.readFileSync(`${REPO}/scripts/week-zero/lib/harness.mjs`, 'utf8')
  const code = harness.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('the harness does not import Prisma at module load',
    !/^import\s+\{?\s*PrismaClient/m.test(code),
    'a static import makes every check need `pnpm install` and a generated client, even ones that never touch the database')
  check('it requires Prisma lazily, inside db()',
    /export function db\(\)[\s\S]{0,400}(createRequire|await import)/.test(code),
    'db() is synchronous and many callers rely on that, so createRequire rather than a dynamic import')

  const { CHECKS } = await import(`${REPO}/scripts/evals/manifest.mjs`)
  const t1 = CHECKS.filter(c => c.tier === 't1')
  check('every tier-1 check declares no preconditions',
    t1.length > 0 && t1.every(c => (c.needs ?? []).length === 0),
    t1.map(c => `${c.id}:[${(c.needs ?? []).join(',')}]`).join(' '))
}

report('E1 eval gate bites')
