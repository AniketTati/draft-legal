#!/usr/bin/env node
/**
 * L12 — session memory grows without bound, and truncates the wrong tools.
 *
 * memory.py trimmed to the last 50 MESSAGES, which is not a size bound. Tool
 * results persist at up to 20_000 chars each for most tools, and the restore
 * loop replays every one of them into the next prompt with no cap. Worst case
 * is 25 tool calls x 20 KB x 25 assistant turns -- megabytes re-sent on EVERY
 * subsequent message, so cost grows quadratically in turn count. Long before
 * the wallet notices, it exceeds the context window and 400s, which L3 then
 * swallowed into a blank bubble.
 *
 * The comment claiming the persisted slice was capped "at the same preview
 * (<=2000 chars typically)" was true before the 20K allowlist was added
 * immediately above it. Being off by 10x is exactly why this was invisible in
 * review.
 *
 * Run BEFORE: only a message-count trim, and the persisted slice is whatever
 *             the streamed preview was (up to 20K).
 * Run AFTER:  a byte ceiling on the log, and a separate, tighter cap on what is
 *             persisted for replay.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const mem  = fs.readFileSync(`${REPO}/apps/agents/app/memory.py`, 'utf8')
const orch = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')

section('1. The session log has a size bound, not just a message count')
{
  check('memory.py defines a byte ceiling', /MAX_SESSION_BYTES/.test(mem),
    'a message COUNT is not a size bound when one message can carry 500 KB of tool results')
  check('the trim loop enforces it',
    /while\s+len\(encoded\)\s*>\s*MAX_SESSION_BYTES/.test(mem),
    'oldest-first, because the newest turns are the ones the model needs')
}

section('2. What is REPLAYED is capped tighter than what is streamed')
{
  check('a separate persist cap exists', /PERSIST_RESULT_CHARS/.test(orch),
    'the persisted slice used to be whatever the streamed preview was -- up to 20K per result, replayed every turn')
  check('the persisted slice uses it', /persisted\s*=\s*preview\[:PERSIST_RESULT_CHARS\]/.test(orch))
  const capMatch = /PERSIST_RESULT_CHARS\s*=\s*([\d_]+)/.exec(orch)
  const cap = capMatch ? Number(capMatch[1].replace(/_/g, '')) : Infinity
  check('it is well below the 20K streaming allowlist', cap <= 4000, `PERSIST_RESULT_CHARS = ${cap}`)
}

section('3. The bound actually holds when a session is hammered')
{
  // Append far more than the ceiling and confirm the stored log stays under it.
  const py = `
import asyncio, json
from app.memory import append_to_session, get_session_history, MAX_SESSION_BYTES
sid = "l12-budget-probe"
big = "x" * 20_000
async def main():
    for i in range(60):
        await append_to_session(sid, "assistant", "turn %d" % i,
            tool_calls=[{"id": "t%d" % i, "name": "contract_search", "args": {}}],
            tool_results=[{"id": "t%d" % i, "name": "contract_search", "result": big, "truncated": True}])
    h = await get_session_history(sid)
    print("<<<R>>>" + json.dumps({"bytes": len(json.dumps(h)), "ceiling": MAX_SESSION_BYTES, "messages": len(h)}))
asyncio.run(main())
`
  let out = null
  try {
    const raw = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
      { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    out = JSON.parse(raw.split('<<<R>>>')[1])
  } catch (e) {
    out = { _error: String(e.stderr ?? e.message).slice(-300) }
  }
  check('60 turns of 20 KB results stay under the ceiling',
    out && !out._error && out.bytes <= out.ceiling,
    out?._error ?? `${out?.bytes} bytes vs ceiling ${out?.ceiling} (${out?.messages} messages) — before the fix this was ~1.2 MB and climbing`)
}

report('L12 memory budget')
