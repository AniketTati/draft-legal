#!/usr/bin/env node
/**
 * E12 — the replay seam: deterministic agent turns with no model, no key, no cost.
 *
 * This is the mechanism ADR-01 rests on. Agent behaviour cannot gate a pull
 * request while every run asks a nondeterministic model, and the usual fixes are
 * both bad: temperature=0 does not make tool-calling deterministic and is not how
 * production runs, and loosening assertions until they stop discriminating
 * defeats the point of having them.
 *
 * So the two questions get separated. "Does my code do the right thing GIVEN what
 * the model said" -- tool dispatch, the confirm gate, RBAC, error surfacing,
 * memory replay -- is deterministic, is most of the agent, and is where every
 * defect docs/36 found actually lived. "Is what the model said any good" is the
 * expensive noisy one, and belongs in tier 3.
 *
 * Note what is NOT stubbed: the tools. A replayed turn still executes
 * contract_search against the real database and streams real results. The model
 * is the only thing replaced, which is exactly the seam that makes the rest
 * testable.
 *
 * Requires the agents service running with AGENT_REPLAY_MODE=replay; /health
 * advertises it, and the runner treats that as a precondition rather than
 * letting this silently run against a live model.
 *
 * Run BEFORE: every agent turn needs a key, costs money, and varies.
 * Run AFTER:  a recorded turn replays byte-identically in milliseconds, keyless.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { login, check, report, section, API, AGENTS } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const admin = await login()

async function turn(sessionId) {
  const t0 = Date.now()
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
    // The message is deliberately NOT the recorded one: under replay the model
    // is served from the fixture regardless, and using different text proves the
    // response is coming from the recording rather than from a live call.
    body: JSON.stringify({ message: 'this text is not what was recorded', agentMode: true, sessionId }),
  })
  const frames = (await res.text()).split('\n').filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean)
  return {
    ms: Date.now() - t0,
    tools: frames.filter(f => f.type === 'tool_call_start').map(f => f.name),
    results: frames.filter(f => f.type === 'tool_call_result'),
    text: frames.filter(f => f.type === 'token').map(f => f.delta ?? '').join(''),
    error: frames.find(f => f.type === 'error')?.error ?? null,
  }
}

// ─── 1. The service is genuinely in replay ──────────────────────────────────

section('1. Replay mode is active')
{
  const health = await fetch(`${AGENTS}/health`).then(r => r.json()).catch(() => ({}))
  check('the agents service advertises replayMode', health.replayMode === 'replay',
    `replayMode=${JSON.stringify(health.replayMode)} — without this, every assertion below could be silently passing against a LIVE model, burning quota and varying run to run`)
}

// ─── 2. A prose turn replays identically ────────────────────────────────────

section('2. A recorded turn is deterministic')
{
  const a = await turn('replay:says-ok')
  const b = await turn('replay:says-ok')
  const c = await turn('replay:says-ok')

  check('the turn produced text', a.text.length > 0, `got ${JSON.stringify(a.text)}`)
  check('three runs are byte-identical', a.text === b.text && b.text === c.text,
    `${JSON.stringify(a.text)} / ${JSON.stringify(b.text)} / ${JSON.stringify(c.text)}`)
  check('and it is fast enough to gate a PR on', b.ms < 2000 && c.ms < 2000,
    `${a.ms}ms, ${b.ms}ms, ${c.ms}ms — a real model turn on this stack is 2-5 seconds`)
}

// ─── 3. Tool dispatch replays, and the tools really run ─────────────────────
//
// The point of tier 2. The model is replayed; contract_search still executes
// against the real database. That is what makes tool dispatch, the confirm gate
// and RBAC testable without a model.

section('3. A tool-calling turn replays, and the tools still execute')
{
  const a = await turn('replay:uses-a-tool')
  const b = await turn('replay:uses-a-tool')

  check('the replayed turn dispatches its recorded tools',
    a.tools.length > 0 && a.tools.every(t => t === 'contract_search'),
    `tools: ${a.tools.join(', ') || 'NONE'}`)
  check('tool dispatch is identical across runs', a.tools.join() === b.tools.join(),
    `${a.tools.join()} vs ${b.tools.join()}`)
  check('the tools genuinely ran against the stack',
    a.results.length === a.tools.length && a.results.every(r => (r.result ?? '').length > 0),
    `${a.results.length} result frame(s) for ${a.tools.length} call(s) — replaying the MODEL must not stub the TOOLS, or the thing under test disappears`)
  check('the follow-up prose is identical too', a.text === b.text && a.text.length > 0,
    `${a.text.length} chars, identical=${a.text === b.text}`)
}

// ─── 4. A missing fixture fails loudly ──────────────────────────────────────
//
// The one behaviour this seam must never have is a quiet fallback to a live
// model: it would turn a free deterministic gate into an unpredictable bill,
// and a green run would stop meaning what it says.

section('4. A missing fixture is an error, never a live call')
{
  const r = await turn(`replay:definitely-not-recorded-${Date.now()}`)
  check('an unrecorded session errors', Boolean(r.error),
    r.error ? String(r.error).slice(0, 120) : 'NO ERROR — the run may have silently called a real model')
  check('the error names the missing fixture',
    /no replay fixture/i.test(String(r.error ?? '')),
    `error: ${String(r.error).slice(0, 150)}`)
  check('and it produced no answer', r.text.length === 0,
    `text=${JSON.stringify(r.text.slice(0, 60))} — answering anyway would mean a live call happened`)
}

// ─── 5. The seam is inert in production ─────────────────────────────────────

section('5. Nothing changes when the mode is unset')
{
  const replay = fs.readFileSync(`${REPO}/apps/agents/app/replay.py`, 'utf8')
  check('wrap() returns the real client when no mode is set',
    /def wrap\([\s\S]{0,400}if m is None:\s*\n\s*return llm/.test(replay),
    'the seam must be a no-op in production, not a branch that behaves subtly differently')

  // Scoped to resolve_llm's OWN body. A first version compared file-wide
  // indexOf positions, which found _platform_resolve's DEFINITION -- earlier in
  // the file than resolve_llm -- so it compared two unrelated offsets and went
  // red against a correct fix.
  const router = fs.readFileSync(`${REPO}/apps/agents/app/router.py`, 'utf8')
  const rlStart = router.indexOf('async def resolve_llm(')
  const rlBody  = rlStart >= 0 ? router.slice(rlStart, rlStart + 3000) : ''
  const scIdx   = rlBody.indexOf('_replay_mode() == "replay"')
  const resIdx  = Math.min(
    ...[rlBody.indexOf('_platform_resolve('), rlBody.indexOf('_node_resolve('), rlBody.indexOf('settings.api_url')]
      .filter(i => i >= 0).concat([Infinity]),
  )
  check('resolve_llm was located', rlBody.length > 0)
  check('the short-circuit is above provider and key resolution',
    scIdx >= 0 && scIdx < resIdx,
    `short-circuit at ${scIdx}, first resolution at ${resIdx} in resolve_llm — placed at build_llm it looked right and was too deep: with no API key the service raises before the router is consulted, so replay still needed a key, which defeats a keyless tier`)

  // Fixtures are committed on purpose: when a change alters which tool the
  // model picks, that should surface as a reviewable diff, not a nightly number.
  const dir = `${REPO}/apps/agents/evals/replay`
  const fixtures = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []
  check('fixtures are committed and readable', fixtures.length >= 2,
    `${fixtures.length} fixture(s): ${fixtures.join(', ')}`)
}

report('E12 replay seam')
