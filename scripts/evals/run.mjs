#!/usr/bin/env node
/**
 * The eval suite runner — ADR-01, docs/37.
 *
 * Runs the checks named in manifest.mjs, by tier, and produces an exit code CI
 * can gate on. It replaces `pytest tests/ -v --tb=short || true`, a step that
 * reported success for a directory that did not exist.
 *
 * Two defects from the harness this supersedes are fixed BY CONSTRUCTION here,
 * because patching them later never happens:
 *
 *   E4 — a check that produces ZERO assertions is a FAILURE, not a pass. The
 *        Python harness returned `True` with a warning string that reached
 *        neither the failure count nor the exit code, so a case with a
 *        forgotten `expected` block inflated the pass rate.
 *
 *   E5 — the baseline records every check's NAME and ASSERTION COUNT. A check
 *        that disappears, or whose assertion count drops, is a regression. In
 *        the harness this replaces, deleting an inconvenient case produced
 *        "no regressions" and exit 0 — verified.
 *
 * A check whose preconditions are unmet is SKIPPED and reported as such. A skip
 * is never a pass. When a tier is being gated, a skip in that tier fails the
 * run: "we could not check" and "we checked and it was fine" must not share an
 * exit code.
 *
 * Usage:
 *   node scripts/evals/run.mjs --tier t1
 *   node scripts/evals/run.mjs --tier t1,t2
 *   node scripts/evals/run.mjs --tier t1 --baseline        # write
 *   node scripts/evals/run.mjs --tier t1 --check-baseline  # compare
 *
 * Exit codes: 0 ok · 1 check failures · 2 usage/precondition · 3 regression.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CHECKS as MANIFEST_CHECKS, CHECK_DIR as DEFAULT_CHECK_DIR, TIERS } from './manifest.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

// --dir / --manifest let this runner be pointed at a fixture tree, which is
// how e1-gate-bites.mjs proves the gate actually fails without mutating real
// checks. A gate nobody has watched fail is not a gate.
const CHECK_DIR = arg('--dir', DEFAULT_CHECK_DIR)
const manifestPath = arg('--manifest', null)
const CHECKS = manifestPath
  ? (await import(path.resolve(REPO, manifestPath))).CHECKS
  : MANIFEST_CHECKS
const BASELINE = path.join(REPO, arg('--baseline-path', 'scripts/evals/baseline.json'))

const tiers = (arg('--tier', 't1') ?? 't1').split(',').map(t => t.trim()).filter(Boolean)
for (const t of tiers) {
  if (!TIERS.includes(t)) {
    console.error(`unknown tier ${JSON.stringify(t)}; expected one of ${TIERS.join(', ')}`)
    process.exit(2)
  }
}

// ── Preconditions ───────────────────────────────────────────────────────────
//
// Probed once, cheaply. The point is to distinguish "the check failed" from
// "the environment could not run it" -- conflating those is how a green CI run
// comes to mean nothing.

function reachable(url) {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '3', '-w', '%{http_code}', url], { encoding: 'utf8' })
  return r.status === 0 && r.stdout && r.stdout !== '000'
}

function probe() {
  const env = fs.existsSync(path.join(REPO, '.env'))
    ? fs.readFileSync(path.join(REPO, '.env'), 'utf8') : ''
  const modelKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']
  return {
    db:  /^DATABASE_URL=.+/m.test(env) || !!process.env.DATABASE_URL,
    api: reachable(`${process.env.API_BASE ?? 'http://localhost:3001'}/health`),
    agents: reachable(`${process.env.AGENTS_BASE ?? 'http://localhost:8002'}/health`),
    web: reachable(process.env.WEB ?? 'http://localhost:5173'),
    model: modelKeys.some(k => process.env[k] || new RegExp(`^${k}=.+`, 'm').test(env)),
    playwright: fs.existsSync(path.join(REPO, 'node_modules/playwright')),
  }
}

// ── Run one check ───────────────────────────────────────────────────────────

/**
 * Parse the shared harness's own summary line: "<title>: <passed>/<total> passed".
 * Reading the count matters as much as the exit code -- a check whose assertions
 * silently vanish still exits 0.
 */
function parseSummary(out) {
  const m = /^(.+): (\d+)\/(\d+) passed\s*$/m.exec(out)
  return m ? { passed: Number(m[2]), total: Number(m[3]) } : null
}

function runCheck(check) {
  const file = path.join(REPO, CHECK_DIR, `${check.id}.mjs`)
  if (!fs.existsSync(file)) {
    return { ...check, status: 'missing', passed: 0, total: 0,
             detail: `${CHECK_DIR}/${check.id}.mjs does not exist` }
  }
  const started = Date.now()
  const r = spawnSync('node', [file], {
    cwd: REPO, encoding: 'utf8', timeout: 15 * 60_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const sum = parseSummary(out)
  const ms = Date.now() - started

  if (!sum) {
    // No summary line at all: the check crashed before reporting, or its output
    // format drifted. Either way we do not know what it asserted, so it cannot
    // be a pass.
    return { ...check, status: 'error', passed: 0, total: 0, ms,
             detail: `no summary line; exit ${r.status}. ${out.trim().slice(-300)}` }
  }
  // E4 — a check that asserted nothing is a failure, not a pass.
  if (sum.total === 0) {
    return { ...check, status: 'empty', passed: 0, total: 0, ms,
             detail: 'ran but asserted NOTHING — an assertion-free check is indistinguishable from an untested one' }
  }
  return {
    ...check, ms, passed: sum.passed, total: sum.total,
    status: r.status === 0 && sum.passed === sum.total ? 'pass' : 'fail',
    detail: r.status === 0 ? '' : (out.split('\nFailures:')[1] ?? '').trim().slice(0, 500),
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const env = probe()
const selected = CHECKS.filter(c => tiers.includes(c.tier))

// Any check file not in the manifest is an error: an unlisted check is one
// nothing runs, which is the whole failure mode this suite exists to end.
const onDisk = fs.readdirSync(path.join(REPO, CHECK_DIR))
  .filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, ''))
const unlisted = onDisk.filter(id => !CHECKS.some(c => c.id === id))

console.log(`\neval suite — tiers ${tiers.join(', ')} — ${selected.length} checks`)
console.log(`environment: ${Object.entries(env).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ')}\n`)

const results = []
for (const check of selected) {
  const missing = check.needs.filter(n => !env[n])
  if (missing.length) {
    console.log(`  SKIP  ${check.id} — needs ${missing.join(', ')}`)
    results.push({ ...check, status: 'skip', passed: 0, total: 0, detail: `needs ${missing.join(', ')}` })
    continue
  }
  const r = runCheck(check)
  const mark = r.status === 'pass' ? ' ok ' : r.status.toUpperCase().slice(0, 4).padEnd(4)
  console.log(`  ${mark}  ${r.id}  ${r.passed}/${r.total}${r.ms ? `  ${(r.ms / 1000).toFixed(1)}s` : ''}`)
  if (r.status !== 'pass' && r.detail) console.log(`        ${r.detail.split('\n')[0]}`)
  results.push(r)
}

const failed  = results.filter(r => ['fail', 'error', 'empty', 'missing'].includes(r.status))
const skipped = results.filter(r => r.status === 'skip')
const passed  = results.filter(r => r.status === 'pass')
const assertions = results.reduce((n, r) => n + r.total, 0)

console.log(`\n${passed.length} passed · ${failed.length} failed · ${skipped.length} skipped · ${assertions} assertions`)
if (unlisted.length) {
  console.log(`\nUNLISTED CHECKS (nothing runs these): ${unlisted.join(', ')}`)
  console.log('Add them to scripts/evals/manifest.mjs with a tier.')
}
for (const f of failed) console.log(`  FAILED ${f.id}: ${f.detail.split('\n')[0]}`)

// ── Baseline ────────────────────────────────────────────────────────────────

const snapshot = {
  tiers,
  // Assertion counts are recorded per check so a SHRINKING check is caught.
  // Pass/fail alone cannot see a check that quietly stopped asserting half of
  // what it used to.
  checks: Object.fromEntries(results.map(r => [r.id, { status: r.status, total: r.total }])),
}

if (has('--baseline')) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`\nbaseline written: ${path.relative(REPO, BASELINE)}`)
  process.exit(failed.length ? 1 : 0)
}

let regressed = []
if (has('--check-baseline')) {
  if (!fs.existsSync(BASELINE)) {
    console.error('\nno baseline to compare against — run with --baseline first')
    process.exit(2)
  }
  const prev = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  for (const [id, was] of Object.entries(prev.checks ?? {})) {
    const now = snapshot.checks[id]
    // E5 — a check that vanished is a regression. Deleting an inconvenient
    // check must not be a way to go green.
    if (!now) { regressed.push(`${id}: PRESENT → GONE (deleted or renamed)`); continue }
    if (was.status === 'pass' && now.status !== 'pass') {
      regressed.push(`${id}: pass → ${now.status}`)
    }
    // ...and a check that still passes while asserting less than it used to
    // has lost coverage silently.
    if (now.total < was.total) {
      regressed.push(`${id}: assertions ${was.total} → ${now.total} (coverage lost)`)
    }
  }
  if (regressed.length) {
    console.log('\nREGRESSIONS:')
    for (const r of regressed) console.log(`  - ${r}`)
  } else {
    console.log('\nno regressions against baseline')
  }
}

// A skip in a gated tier is a failure: "could not check" must not exit 0 as
// though it were "checked and fine".
const gatedSkips = skipped.filter(s => tiers.includes(s.tier))
if (gatedSkips.length && has('--strict')) {
  console.log(`\nSTRICT: ${gatedSkips.length} skipped check(s) in a gated tier — treating as failure`)
}

process.exit(
  regressed.length ? 3
  : failed.length || unlisted.length || (has('--strict') && gatedSkips.length) ? 1
  : 0,
)
