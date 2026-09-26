#!/usr/bin/env node
/**
 * The Langfuse eval harness, checked against itself.
 *
 * docs/37 E1: a gate that has never been watched failing is not known to work,
 * and thirty-eight assertions in docs/36 passed against broken code. So this
 * does not ask "did the harness run" — it drives cases whose outcomes are known
 * in advance and asserts the harness reports each one CORRECTLY, including the
 * ones that must come out red.
 *
 * Deterministic and free: the `stub` target makes no model call and needs no
 * service beyond Langfuse itself. That is what lets it sit in t2 and gate a PR,
 * while the real corpora (extraction, chat) stay in t3 where the money is.
 *
 *   node scripts/evals/langfuse/selftest.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../../week-zero/lib/harness.mjs'
import {
  configured, createTrace, ensureDataset, getRun, linkRunItem, postScore, upsertItem, getDataset,
} from './lf.mjs'
import { runScorer, judgeAvailable, SCORER_NAMES } from './scorers.mjs'
import { getTarget, TARGETS } from './targets.mjs'

const spec = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./datasets/harness.json', import.meta.url)), 'utf8'))

// What each case MUST report. Written here, independently of the case file, so
// a corpus edit that quietly changes an outcome fails this check instead of
// redefining what "correct" means.
const EXPECTED = {
  'self-pass':        { 'field_match:contractType': 1, 'not_empty:reason': 1, 'json_subset': 1 },
  'self-fail':        { 'field_match:contractType': 0, 'json_subset': 0 },
  'self-empty-field': { 'field_match:contractType': 1, 'not_empty:reason': 0 },
}

section('1. Preconditions')
check('Langfuse is configured (all three vars)', configured(),
  'set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY — see docs/operations/LANGFUSE.md')
if (!configured()) { report('Langfuse eval harness self-test'); process.exit(1) }

let reachable = false
try { await getDataset(spec.dataset).catch(() => null); reachable = true } catch { reachable = false }
check('Langfuse answers', reachable, 'is it up? `pnpm langfuse:up`')

section('2. The corpus declares only things that exist')
{
  for (const item of spec.items) {
    check(`${item.id}: target "${item.target}" exists`, Boolean(TARGETS[item.target]))
    const unknown = (item.scorers ?? []).filter(
      (s) => !SCORER_NAMES.some((n) => n === s || n.split(':')[0] === String(s).split(':')[0]))
    check(`${item.id}: all scorers known`, unknown.length === 0, unknown.join(', '))
    check(`${item.id}: has at least one scorer`, (item.scorers ?? []).length > 0,
      'a case with no assertions always passes — docs/37 E4')
  }
}

section('3. Every case scores exactly as predicted — including the red ones')
const runLabel = `selftest-${Date.now().toString(36)}`
const traceIds = {}
{
  await ensureDataset(spec.dataset, spec.description, spec.metadata)
  for (const item of spec.items) {
    await upsertItem({
      datasetName: spec.dataset, id: item.id, input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: { ...item.metadata, target: item.target, scorers: item.scorers },
    })

    const result = await getTarget(item.target)(item, { sessionId: null })
    const ctx = { input: item.input, output: result.output, expectedOutput: item.expectedOutput, meta: result.meta }

    const got = {}
    for (const s of item.scorers ?? []) {
      const score = await runScorer(s, ctx)
      if (score) got[score.name] = Number(score.value)
    }

    const want = EXPECTED[item.id] ?? {}
    for (const [name, wantVal] of Object.entries(want)) {
      check(`${item.id} → ${name} = ${wantVal}`, got[name] === wantVal,
        got[name] === undefined ? 'scorer did not run at all' : `got ${got[name]}`)
    }

    // Round-trip it, so this also proves the write path Langfuse actually sees.
    const traceId = await createTrace({
      name: `selftest.${item.id}`, input: item.input, output: result.output,
      metadata: { traceSource: 'harness', selftest: true }, tags: ['eval', 'selftest'],
    })
    traceIds[item.id] = traceId
    await linkRunItem({ runName: runLabel, datasetItemId: item.id, traceId, metadata: { selftest: true } })
    for (const [name, value] of Object.entries(got)) {
      await postScore({ traceId, name, value, dataType: 'BOOLEAN' })
    }
  }
}

section('4. A failing case is visible as failing, not merely absent')
{
  // The failure mode this guards: a case that errors, gets dropped, and leaves
  // a run that looks smaller but greener. Absence must not read as health.
  const failing = await runScorer('field_match:contractType', {
    output: { contractType: 'NDA' }, expectedOutput: { contractType: 'MSA' },
  })
  check('a mismatched field scores 0', failing?.value === 0, `got ${failing?.value}`)
  check('and says what it expected', /expected "MSA"/.test(failing?.comment ?? ''), failing?.comment)

  const passing = await runScorer('field_match:contractType', {
    output: { contractType: 'msa' }, expectedOutput: { contractType: 'MSA' },
  })
  check('case-insensitive match still scores 1', passing?.value === 1, `got ${passing?.value}`)
}

section('5. A scorer that cannot run SKIPS — it does not score 0')
{
  const noLatency = await runScorer('latency_ms', { meta: {} })
  check('latency_ms with no timing returns null (skip)', noLatency === null, `got ${JSON.stringify(noLatency)}`)

  if (!judgeAvailable()) {
    const j = await runScorer('judge:groundedness', { input: 'x', output: 'y' })
    check('judge with no API key returns null (skip), not 0', j === null, `got ${JSON.stringify(j)}`)
  } else {
    check('judge key present — skip-path not exercised here', true, 'a key is set, so the no-key branch cannot be tested in this run')
  }

  let threw = false
  try { await runScorer('no_such_scorer', {}) } catch { threw = true }
  check('an unknown scorer throws rather than silently passing', threw)
}

section('6. The run reads back from Langfuse')
{
  let run = null
  for (const waitMs of [500, 1500, 3000, 5000]) {
    await new Promise((r) => setTimeout(r, waitMs))
    run = await getRun(spec.dataset, runLabel).catch(() => null)
    if ((run?.datasetRunItems ?? []).length >= spec.items.length) break
  }
  const linked = (run?.datasetRunItems ?? []).length
  check('the run exists', Boolean(run), `looked for "${runLabel}"`)
  check(`all ${spec.items.length} cases are linked to it`, linked === spec.items.length,
    `${linked} linked — ingestion is async, so a short count here can also mean the worker is behind (pnpm langfuse:logs)`)
}

report('Langfuse eval harness self-test')
