#!/usr/bin/env node
/**
 * L13 — dead names, and one dead code path that blocks the event loop.
 *
 * `matter_get` is phantom in THREE independent places: a PER_TOOL_BUDGET entry
 * documented twice, and a branch in each web client. There is no tool file, no
 * registry entry and no endpoint. Three layers agree on a capability that has
 * never existed — the budget can never be hit and the branches never match.
 *
 * `draft_clause` is phantom in one: a branch in artifact-from-tool.ts. Runtime
 * impact nil; the cost is that it reads as a supported capability, so an
 * engineer adding clause drafting will assume the artifact path is wired. That
 * same file carries the receipt for this exact bug class — "Audit 2026-06-10:
 * dropped the save_draft / send_for_review pseudo-tool buttons" — and
 * draft_clause survived that cleanup.
 *
 * The legacy non-agentMode path is worse than stale. `graph.invoke(...)` is
 * synchronous inside `async def run_chat`, awaited with no threadpool, and
 * `general_respond` is a plain `def` whose `llm.invoke(...)` blocks for the
 * whole model round-trip. One such request stalls the entire uvicorn worker for
 * 5-30 seconds — every concurrent chat, tool callback and health check behind
 * it. It is latent only because both web surfaces send agentMode: true, while
 * agents.ts defaults it to FALSE, so any direct caller, probe or eval script
 * that omits the flag trips it.
 *
 * Run BEFORE: three phantom matter_get references, one draft_clause, and a
 *             blocking call on the legacy path.
 * Run AFTER:  the phantoms are gone and the blocking call is off the loop.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const read = p => { try { return fs.readFileSync(`${REPO}/${p}`, 'utf8') } catch { return '' } }

const orch = read('apps/agents/app/orchestrator.py')
const chat = read('apps/agents/app/routes/chat.py')
const rail = read('apps/web/src/components/agent/SideAgentRail.tsx')
const home = read('apps/web/src/pages/AgentHomePage.tsx')
const artifact = read('apps/web/src/components/agent/artifact-from-tool.ts')

const TOOLS = fs.readdirSync(`${REPO}/apps/agents/app/tools`)
  .filter(f => f.endsWith('.py') && f !== '__init__.py')
  .map(f => f.slice(0, -3))

// ─── 1. No layer references a tool that does not exist ─────────────────────

section('1. Phantom tool names are gone')
{
  check('matter_get is not a registered tool (confirming it is phantom)',
    !TOOLS.includes('matter_get'), 'if this ever fails, the references below stop being dead')

  for (const [label, src] of [['the tool budget', orch], ['the rail', rail], ['AgentHomePage', home]]) {
    check(`${label} does not reference matter_get`, !/matter_get/.test(src),
      'three layers agreed on a capability that never existed — the budget can never be hit and the branch never matches')
  }

  check('artifact-from-tool does not branch on draft_clause',
    !/call\.name === 'draft_clause'/.test(artifact),
    'it reads as a supported capability; the same file records dropping save_draft/send_for_review for exactly this reason')
}

// ─── 2. The legacy path must not block the event loop ──────────────────────

section('2. The legacy chat path is off the event loop')
{
  // `async def run_chat` awaiting a synchronous graph.invoke stalls the whole
  // uvicorn worker for the duration of the model call.
  const runChatIdx = orch.indexOf('async def run_chat')
  const body = runChatIdx >= 0 ? orch.slice(runChatIdx, runChatIdx + 2200) : ''
  check('run_chat was located', runChatIdx >= 0)
  check('run_chat does not call graph.invoke synchronously on the loop',
    !/(?<!await\s)(?<!threadpool\()\bgraph\.invoke\(/.test(body) || /run_in_threadpool|to_thread|ainvoke/.test(body),
    'one such request stalls every concurrent chat, tool callback and health check behind it for 5-30 seconds')

  // This assertion used to be `/agent_mode/.test(chat)`, which was INVERTED:
  // it was green BECAUSE the hazard was present, and deleting the flag — the
  // fix it claims to want — was the one edit that turned it red. A check that
  // punishes the fix and rewards the defect is worse than no check.
  //
  // The proposition is what the title already says: either the flag is gone,
  // or the risky default carries the explanation of why it is risky.
  const hasRiskyDefault = /agent_mode:\s*bool\s*=\s*False/.test(chat)
  const documented = /Legacy callers[^\n]*\n\s*agent_mode:\s*bool\s*=\s*False/.test(chat)
  check('the default for agent_mode is documented as a hazard or removed',
    !hasRiskyDefault || documented,
    hasRiskyDefault
      ? 'agent_mode still defaults to False, and the comment explaining that legacy callers land on the fake-streamed path is gone — so the next reader sees an innocuous default'
      : 'the flag is gone entirely, which is the stronger outcome')
}

report('L13 dead names')
