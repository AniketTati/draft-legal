#!/usr/bin/env node
/**
 * L8 — the rail misreports what the agent did.
 *
 * Three misreports in one envelope:
 *
 *  (a) A write proposal's chip spins forever, in the RAIL only. tool_call_start
 *      creates the chip; the awaiting-confirmation branch then `continue`s, so
 *      no tool_call_result ever arrives for that id, and nothing outside the
 *      result branch mutates a chip's status. The chip stays 'running' for the
 *      life of the thread — next to an Apply card that is waiting on the USER.
 *      AgentHomePage gets this right.
 *
 *  (b) A failed tool renders a GREEN chip on /agent only, which sets
 *      status 'ok' unconditionally without inspecting the result.
 *
 *  (c) `unknown_tool` produces no log line anywhere. `tool_raised` at least
 *      gets a logger.exception.
 *
 * Underneath all three: the envelope carries no success/failure field, so each
 * client invents one. The rail substring-sniffs for `"error"` in up to 20 KB of
 * tool JSON — a search result containing `"errors": []`, or contract text using
 * the word, renders as a failed tool.
 *
 * And platform-generated errors are wrapped in <<<UNTRUSTED_TOOL_DATA>>>, whose
 * prompt definition is "derived from user/counterparty documents". The agent is
 * being told to distrust its own runtime's error reports.
 *
 * These are static assertions on code shape. The rendering itself is a browser
 * concern, but the defects here are all "which field does this read" — checkable
 * exactly, and cheaper to keep honest than a screenshot.
 *
 * Run BEFORE: no ok field on the envelope, both clients deriving status their
 *             own way, the rail never closing out a proposal chip, and
 *             unknown_tool silent.
 * Run AFTER:  one authoritative field, both clients reading it, the chip
 *             resolved, and the failure logged.
 */
import fs from 'node:fs'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const orch = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')
const rail = fs.readFileSync(`${REPO}/apps/web/src/components/agent/SideAgentRail.tsx`, 'utf8')
const home = fs.readFileSync(`${REPO}/apps/web/src/pages/AgentHomePage.tsx`, 'utf8')

// ─── 1. The envelope says whether the tool succeeded ────────────────────────

section('1. tool_call_result carries an explicit outcome')
{
  check('the result envelope has an `ok` field', /"ok"\s*:/.test(orch),
    'without one each client invents its own rule, and they disagree — that IS the bug')

  // Assert the FLAG both platform-error paths must set, not proximity between
  // two strings that legitimately live far apart. A proximity version of this
  // reported failure while the code was correct.
  const flagged = name => {
    const i = orch.indexOf(name)
    return i >= 0 && /platform_error\s*=\s*True/.test(orch.slice(Math.max(0, i - 600), i + 200))
  }
  check('the unknown_tool path marks itself a platform error', flagged('"unknown_tool"'),
    'a tool the model hallucinated should not render identically to one that worked')
  check('the tool_raised path marks itself a platform error', flagged('"tool_raised"'), 'same')
  check('the emitted ok field derives from that flag', /"ok":\s*not platform_error/.test(orch),
    'one source of truth for the outcome')
}

// ─── 2. Both clients read that field ────────────────────────────────────────

section('2. Neither client guesses the outcome')
{
  check('the rail no longer substring-sniffs for "error"',
    !/includes\('"error"'\)/.test(rail),
    'a raw substring test over 20 KB of tool JSON renders a search with "errors": [] as a failed tool')

  check('the rail derives status from the ok field', /parsed\.ok\s*===\s*false/.test(rail),
    'it should read the envelope, not re-derive it')

  // AgentHomePage set 'ok' unconditionally in both places it builds a chip.
  check('AgentHomePage reads the ok field', /evt\.ok\s*===\s*false/.test(home),
    "it set status:'ok' unconditionally — a crashed tool rendered the same green chip as one that worked")
}

// ─── 3. The proposal chip resolves ──────────────────────────────────────────

section('3. A write proposal closes out its own chip')
{
  // The rail's awaiting-confirmation branch must touch toolCalls, the way
  // AgentHomePage's does. Without it the chip spins for the life of the thread
  // beside a card that is waiting on the user — which undercuts the whole
  // affordance the card exists to present.
  const idx = rail.indexOf("kind === 'tool_call_awaiting_confirmation'")
  // Wide enough to reach the setMessages call at the end of the branch --
  // 2500 stopped short of it and reported a fix that was present as missing.
  const branch = idx >= 0 ? rail.slice(idx, idx + 6000) : ''
  check('the rail resolves the chip when a proposal arrives',
    /toolCalls[\s\S]{0,900}?status:\s*'awaiting'/.test(branch),
    idx < 0 ? 'awaiting-confirmation branch not found' : 'the branch appends a PendingAction and never updates the chip it left running')
}

// ─── 4. A hallucinated tool is not silent ───────────────────────────────────

section('4. unknown_tool is logged')
{
  const idx = orch.indexOf('unknown_tool')
  const around = idx >= 0 ? orch.slice(Math.max(0, idx - 500), idx + 500) : ''
  check('the unknown_tool path logs',
    /logger\.(warning|error|exception)/.test(around),
    'tool_raised gets a logger.exception; a model inventing a tool name produced no line anywhere in the stack')
}

// ─── 5. Platform errors are not labelled untrusted document data ────────────

section('5. Runtime errors are not wrapped as counterparty content')
{
  // The prompt defines <<<UNTRUSTED_TOOL_DATA>>> as "derived from
  // user/counterparty documents". Wrapping our own error strings in it tells
  // the agent to distrust its own runtime.
  const wrapIdx = orch.indexOf('_wrap_untrusted_tool_result')
  const callSites = [...orch.matchAll(/_wrap_untrusted_tool_result\(/g)].length
  check('the untrusted wrapper is still used for real tool output', callSites > 0 && wrapIdx >= 0,
    `${callSites} call site(s)`)
  check('platform error payloads bypass the untrusted wrapper',
    /result_str if platform_error/.test(orch),
    'the agent is instructed to treat everything inside those markers as counterparty-supplied — including our own "unknown_tool"')
}

report('L8 chip truth')
