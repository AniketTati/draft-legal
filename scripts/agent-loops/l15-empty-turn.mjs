#!/usr/bin/env node
/**
 * L15 — a turn that shows the user nothing must say why.
 *
 * Found 2026-08-16 by running the persona corpus once it was countable. Some
 * turns returned HTTP 200 carrying only a `done` frame: no tokens, no tools,
 * no error. The rail rendered an empty assistant bubble with nothing to
 * explain it. Instrumented, the cause was mundane — gemini-2.5-flash returns
 * finish_reason='STOP' with content='' and no tool calls. A normal completion
 * that happens to be empty. Nothing in the service was wrong, which is why
 * nothing logged.
 *
 * The code meant to catch it could not. The A5 synthesis net is the `else:` of
 * `for iteration in range(MAX_TOOL_ITERATIONS)`, and a Python for/else runs
 * its else ONLY when the loop finishes without break — every empty-response
 * path breaks. It has only ever caught iteration-cap exhaustion.
 *
 * Three distinct shapes, all verified by driving the real generator:
 *   A  content=""                       -> was a bare done frame
 *   F  tool call, then empty synthesis  -> tool chips above a blank bubble
 *   G  content=[{'type':'thinking'}]    -> str() made a Python repr, which is
 *                                          non-empty, so it skipped the guard,
 *                                          got PERSISTED, and was replayed
 *                                          into the next prompt as if the
 *                                          assistant had said it
 *
 * Why this is a behavioural check and not a grep: the first version of this
 * assertion lived in l3-error-surface and matched the guard's source text.
 * It went red the moment the guard was corrected — it pinned wording, not
 * behaviour. This drives the actual generator with a stubbed LLM, so it is
 * deterministic, needs no API key, and costs nothing.
 *
 * Run BEFORE: F and G stream a `done` frame with zero tokens; G persists
 *             "[{'type': 'thinking', ...}]" as the assistant's answer.
 * Run AFTER:  every zero-token turn yields an error frame, and nothing is
 *             persisted for it.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

// Drives run_agent_chat_stream directly. Only the LLM, session store and tool
// catalog are stubbed — the generator under test is the real one.
const PY = `
import asyncio, json, sys, types
sys.path.insert(0, ${JSON.stringify(`${REPO}/apps/agents`)})
from langchain_core.messages import AIMessageChunk
import app.orchestrator as o

class StubLLM:
    def __init__(self, rounds): self.rounds, self.i = rounds, 0
    def bind_tools(self, *a, **k): return self
    async def astream(self, messages, config=None):
        r = self.rounds[min(self.i, len(self.rounds) - 1)]; self.i += 1
        for c in r: yield c

PERSISTED = []
def install(rounds):
    async def _resolve(*a, **k):
        return types.SimpleNamespace(
            llm=StubLLM(rounds), provider="stub", model="stub",
            source="platform", tier="fast", callbacks=[])
    o.resolve_llm = _resolve
    async def _hist(*a, **k): return []
    async def _app(sid, role, content, tool_calls=None, tool_results=None):
        PERSISTED.append([role, content])
    o.get_session_history = _hist
    o.append_to_session = _app
    o.get_read_tools = lambda *a, **k: []
    o.get_all_tools = lambda *a, **k: []

async def run(rounds):
    PERSISTED.clear(); install(rounds)
    frames = []
    async for ev in o.run_agent_chat_stream("s", "o", "u", "q", "stub", "stub"):
        frames.append(ev.get("type"))
    return {"frames": frames, "tokens": frames.count("token"), "persisted": list(PERSISTED)}

TOOLCALL = AIMessageChunk(content="", tool_call_chunks=[
    {"name": "contract_search", "args": '{"query":"x"}', "id": "tc1", "index": 0}])

async def main():
    out = {}
    out["A_empty"]    = await run([[AIMessageChunk(content="")]])
    out["F_tool_then_empty"] = await run([[TOOLCALL], [AIMessageChunk(content="")]])
    out["G_thinking"] = await run([[AIMessageChunk(content=[{"type": "thinking", "thinking": "internal"}])]])
    out["E_prose"]    = await run([[AIMessageChunk(content="Here are your contracts.")]])
    print("<<<R>>>" + json.dumps(out))

asyncio.run(main())
`

let R
try {
  const out = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', PY],
    { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 120_000 })
  R = JSON.parse(out.split('<<<R>>>')[1])
} catch (e) {
  check('the stubbed orchestrator ran', false, String(e.message).slice(0, 300))
  report('L15 empty turn')
}

// ─── 1. Every zero-token turn explains itself ───────────────────────────────

section('1. A turn that streams nothing yields an error, not a bare done')
{
  const cases = [
    ['A_empty',            'content="" with no tool calls'],
    ['F_tool_then_empty',  'a tool ran, then the synthesis came back empty — tool chips above a blank bubble'],
    ['G_thinking',         'content was a thinking block with no text'],
  ]
  for (const [key, what] of cases) {
    const r = R[key]
    check(`${key}: zero tokens streamed (confirms the case is set up)`, r.tokens === 0,
      `tokens=${r.tokens} — if this is non-zero the stub stopped reproducing ${what}, and the assertion below proves nothing`)
    check(`${key}: yields an error frame`, r.frames.includes('error'),
      `frames=[${r.frames.join(',')}] — ${what}`)
    check(`${key}: does not end on a bare done`, !r.frames.includes('done'),
      `frames=[${r.frames.join(',')}] — a done frame here is what the rail renders as an empty bubble`)
  }
}

// ─── 2. Nothing empty is persisted into the next turn ───────────────────────

section('2. An empty turn leaves no trace in session memory')
{
  // G is the one that mattered: str() on a block list produced a non-empty
  // Python repr, which was written to the session as the assistant's answer
  // and replayed into the next prompt.
  for (const key of ['A_empty', 'F_tool_then_empty', 'G_thinking']) {
    const p = R[key].persisted
    const assistant = p.filter(([role]) => role === 'assistant')
    check(`${key}: no assistant turn persisted`, assistant.length === 0,
      assistant.length
        ? `persisted ${JSON.stringify(assistant[0][1]).slice(0, 90)} — this is replayed into the next prompt as if the assistant said it`
        : 'nothing written')
  }
}

// ─── 3. The guard does not fire on a real answer ────────────────────────────

section('3. A normal turn is untouched')
{
  const r = R.E_prose
  check('prose still streams as tokens', r.tokens > 0, `tokens=${r.tokens}`)
  check('a real answer ends on done, not error', r.frames.includes('done') && !r.frames.includes('error'),
    `frames=[${r.frames.join(',')}] — a guard that fires here would break every working turn, which is the failure mode worth fearing most`)
}

// ─── 4. The ActionPreview exemption is wired ────────────────────────────────

section('4. A staged write card is not mistaken for an empty turn')
{
  // The confirmation path yields its card and then CONTINUES rather than
  // returning, so a write turn where the model stages a card and writes no
  // prose reaches the same guard. Without the exemption the guard would
  // replace a card the user can act on with an error. Asserted on the source
  // because reaching it needs the full tool-dispatch path, not a stubbed LLM.
  const src = execFileSync('cat', [`${REPO}/apps/agents/app/orchestrator.py`], { encoding: 'utf8' })
  check('the confirmation branch sets the exemption flag',
    /saw_confirmation_card = True[\s\S]{0,200}?"type": "tool_call_awaiting_confirmation"/.test(src),
    'without this, staging an ActionPreview and saying nothing replaces the card with an error frame')
  check('the guard reads the exemption', /and not saw_confirmation_card:/.test(src),
    'the flag must actually gate the guard, not merely exist')
}

report('L15 empty turn')
