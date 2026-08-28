#!/usr/bin/env node
/**
 * E15 — the corpus data has not drifted out from under its own questions.
 *
 * `seed-personas.ts` pins TODAY to a fixed date so the 810-contract corpus is
 * reproducible from the script rather than from a database dump. That is the
 * right default and this check does not argue with it.
 *
 * The problem is the SECOND clock. The data is pinned; the agent answers
 * against the real one. So an ask like "which expire in the next 30 days"
 * selects against a window that slides away from the data every single day,
 * and eventually selects nothing — while the rubric still expects the
 * contracts it was written against. Nothing fails loudly. The row just stops
 * measuring what it was written to measure, and the corpus quietly gets easier
 * or harder depending on which direction the miss falls.
 *
 * docs/38 §16.3 names exactly this: "regression tests start failing with no
 * code change — check whether the data moved before investigating the system".
 * This is that check, made mechanical.
 *
 * The drift assertion itself lives in the RUNNER, not here: a t1 check that
 * goes red on a calendar date with no code change is a flaky gate, and flaky
 * gates get `continue-on-error`d. What this asserts is that the runner's
 * freshness precondition exists, is called, derives its threshold from the
 * corpus rather than a magic number, and exits non-zero.
 *
 * As of writing the corpus IS stale — anchored 2026-04-27, 123 days behind,
 * against a tightest window of 30 days. Eleven asks have been selecting nothing
 * for roughly three months. The runner now says so and refuses.
 *
 * NOTE — this corrects docs/38 and docs/39, which both said the corpus
 * "re-anchors to today" and that a re-run therefore measures date drift. It
 * does not: the anchor is FIXED and SEED_TODAY is opt-in. A same-day re-run is
 * stable, so this does not contaminate a noise-floor measurement. What it does
 * contaminate is comparing a number from one month against a number from
 * another.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }

const seed = read('apps/api/scripts/seed-personas.ts')
const corpusFiles = [
  'scripts/persona-tests/conversations.mjs',
  ...fs.readdirSync(`${REPO}/scripts/persona-tests/personas`)
      .filter(f => f.endsWith('.mjs'))
      .map(f => `scripts/persona-tests/personas/${f}`),
]
const corpus = corpusFiles.map(read).join('\n')

// ─── 1. The anchor is discoverable and still fixed ──────────────────────────

section('1. The corpus anchor is pinned, and this check can find it')
{
  const m = /const TODAY = new Date\(`\$\{SEED_TODAY \?\? '(\d{4}-\d{2}-\d{2})'\}/.exec(seed)
  check('the pinned anchor date is parseable from the seed script', !!m,
    'if this regex stops matching, everything below silently passes — fix the anchor, do not delete the assertion')
  check('SEED_TODAY remains an opt-in override, not the default',
    /SEED_TODAY \?\?/.test(seed),
    'making today the default would trade reproducibility for freshness, which is the opposite trade to the one documented')
  globalThis.__anchor = m?.[1] ?? null
}

// ─── 2. Time-relative asks exist, so drift matters ──────────────────────────

const asks = [...corpus.matchAll(/ask:\s*'([^']*)'/g)].map(m => m[1])
const TIME_RELATIVE = /next \d+ (days|months)|this year|this quarter|expiring|renewal.{0,20}year|past \d+|last \d+ (days|months)/i
const relative = asks.filter(a => TIME_RELATIVE.test(a))

section('2. How much of the corpus is exposed to the clock')
{
  check('the corpus was found and parsed', asks.length > 100, `${asks.length} asks parsed`)
  check('time-relative asks are present', relative.length > 0,
    `${relative.length} of ${asks.length} — if this ever hits zero the drift stops mattering and this check can go`)
}

// ─── 3. The runner refuses to produce a number from a decayed corpus ────────
//
// The drift assertion deliberately does NOT live here. A t1 check that goes red
// on a calendar date with no code change is the flaky-gate pattern docs/39
// warns about, and the standard response to a flaky gate is
// `continue-on-error`, which is the `|| true` this suite spent a wave deleting.
//
// The drift is a runtime property of the seeded data, so the gate belongs in
// the runner as a PRECONDITION — the repo's existing idiom: a precondition is a
// fact, and "could not check" must not exit 0 as though it were "checked and
// fine". What is asserted here is that the gate exists and still bites.

const runner = read('scripts/persona-tests/run-personas.mjs')

section('3. The persona runner gates on corpus freshness')
{
  check('a freshness precondition exists', /function assertCorpusIsFresh/.test(runner),
    'without it the suite happily reports a pass rate computed from asks that select nothing')
  check('…and is actually called', /^assertCorpusIsFresh\(\)$/m.test(runner),
    'a gate that is defined and never invoked is the exact defect class docs/36 removed')
  check('it reads the anchor from the seed script rather than hardcoding one',
    /seed-personas\.ts/.test(runner) && /SEED_TODAY/.test(runner),
    'a second copy of the anchor date would drift from the first')
  check('it derives the threshold from the corpus, not a magic number',
    /Math\.min\(\.\.\.windows\)/.test(runner),
    'the tightest window IS the threshold — the point where the narrowest ask stops selecting what it was written against')
  // Anchored to the STALE branch, not to the file. There are two exits in the
  // gate — the other is for an unreadable anchor — so a bare
  // /process\.exit\(2\)/ still matched when the stale branch was changed to
  // `return`. Found by mutating it and watching this stay green.
  check('the STALE branch exits non-zero rather than warning',
    /CORPUS IS STALE[\s\S]{0,1400}?process\.exit\(2\)/.test(runner),
    'a warning on a decayed corpus produces a number that looks like a quality signal and is not')
  check('the remedy is in the message', /SEED_TODAY=\$\(date -u \+%F\)/.test(runner),
    'an error a reader cannot act on gets suppressed rather than fixed')
}

report('E15 corpus clock')
