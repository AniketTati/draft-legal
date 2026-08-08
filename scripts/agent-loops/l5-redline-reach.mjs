#!/usr/bin/env node
/**
 * L5 — the agent cannot reach the redlining feature that shipped last week.
 *
 * Five phases built full-document playbook redlining with a tracked-changes
 * Word export (docs/35, in production 2026-08-08). None of it is reachable by
 * asking.
 *
 * The sharpest part is not the missing capability, it is the DISHONESTY.
 * `redline_propose.py` shipped this string to the model:
 *
 *     "Read-only — use redline_apply to turn a chosen variant into a new
 *      ContractVersion."
 *
 * There is no such tool. So the only place the model is told the verb exists is
 * a description pointing at a tool it cannot call, and the prompt's
 * "never claim the change was made" rule covers only comment_add,
 * contract_update and request_create. Nothing stops the model announcing it
 * applied a variant it never applied — the exact failure this codebase already
 * documents for drafting ("the agent fell into a loop hallucinating 'I created
 * the draft' without ever calling a tool that produced one").
 *
 * Section 1 generalises that into an invariant, because the class matters more
 * than the instance: no tool description may name a tool that is not
 * registered.
 *
 * Run BEFORE: redline_propose points the model at a tool that does not exist,
 *             and no redline_apply is registered.
 * Run AFTER:  every named tool is real, redline_apply is a confirm-gated write
 *             tool, and the Node layers that were already finished are wired.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const TOOLDIR = `${REPO}/apps/agents/app/tools`

const TOOLS = fs.readdirSync(TOOLDIR)
  .filter(f => f.endsWith('.py') && f !== '__init__.py')
  .map(f => f.slice(0, -3))
const registered = new Set(TOOLS)
const orchestrator = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')
const threads = fs.readFileSync(`${REPO}/apps/api/src/routes/agent-threads.ts`, 'utf8')

// ─── 1. No tool description may name a tool that does not exist ─────────────

section('1. Every tool a description names is a tool that exists')
{
  // Tool-shaped identifiers, checked against the registry. Restricted to the
  // known verb prefixes so ordinary snake_case prose is not swept up.
  const VERB = /\b((?:contract|clause|redline|playbook|approval|request|counterparty|obligations|renewal|compliance|portfolio|org|custom_field|matter)_[a-z_]+)\b/g
  const dangling = []
  for (const t of TOOLS) {
    const src = fs.readFileSync(`${TOOLDIR}/${t}.py`, 'utf8')
    for (const m of src.matchAll(VERB)) {
      const name = m[1]
      // Only flag names that LOOK like a tool being recommended, i.e. appear
      // in prose rather than as a python symbol or an API path segment.
      if (registered.has(name)) continue
      if (!/\buse\s+`?$|\buse\s+`?/i.test(src.slice(Math.max(0, m.index - 12), m.index))) continue
      dangling.push(`${t}.py → "${name}"`)
    }
  }
  check('no tool description points the model at an unregistered tool',
    dangling.length === 0,
    dangling.length
      ? `${dangling.join(', ')} — the model is told a verb exists that it cannot call, and nothing stops it narrating the result`
      : 'every named tool is registered')
}

// ─── 2. redline_apply is a real, confirm-gated write tool ───────────────────

section('2. redline_apply exists and is gated')
{
  const exists = registered.has('redline_apply')
  check('a redline_apply tool is registered', exists,
    exists ? 'apps/agents/app/tools/redline_apply.py' : 'the Node side has been complete since P1.5 — allowlist, user field, reversible flag, undo adapter and endpoint')

  if (exists) {
    const src = fs.readFileSync(`${TOOLDIR}/redline_apply.py`, 'utf8')
    check('it returns an awaiting-confirmation payload, never writing directly',
      /awaitingConfirmation/.test(src),
      'a write tool that executes inline skips checkToolPermission — the mistake L4 exists to fix')
    check('it is marked reversible so the 15-minute undo applies',
      /"reversible"\s*:\s*True/.test(src), 'agent-threads.ts computes undo from this')
  }

  // Registration must be in the write block, so the file reads the way it runs.
  const initSrc = fs.readFileSync(`${TOOLDIR}/__init__.py`, 'utf8')
  const writeBlock = initSrc.slice(initSrc.indexOf('# Write tools'))
  check('it is registered in the write-tool block', writeBlock.includes('redline_apply'),
    'registering a write tool above the "# Write tools" comment is how drafting escaped its gate')
}

// ─── 3. The Node layers that were already finished are actually wired ───────

section('3. The apply path is complete end to end')
{
  check('redline_apply is in the WRITE_TOOLS allowlist', /'redline_apply'/.test(threads),
    'without it, apply returns "not a registered write tool"')
  check('it has an undo adapter branch', /redline_apply/.test(threads.slice(threads.indexOf('undo'))),
    'reversible with no adapter yields a 400 on the undo the card advertises')
}

// ─── 4. The model is told the verb exists ───────────────────────────────────

section('4. The prompt covers it')
{
  check('redline_apply appears in the system prompt', orchestrator.includes('redline_apply'),
    'the prompt outranks tool descriptions; a write tool it never names is one the model rarely selects and may narrate instead')

  // The "never claim the change was made" rule must cover every gated tool,
  // not the three it was written for.
  const gated = TOOLS.filter(t => {
    try { return /awaitingConfirmation/.test(fs.readFileSync(`${TOOLDIR}/${t}.py`, 'utf8')) } catch { return false }
  })
  const uncovered = gated.filter(t => !orchestrator.includes(t))
  check('every confirm-gated tool is named in the prompt', uncovered.length === 0,
    uncovered.length ? `missing: ${uncovered.join(', ')}` : `all ${gated.length} covered`)
}

// ─── 5. It loads and produces the shape the Apply card already expects ──────

section('5. The tool builds the payload the UI already sends')
{
  const py = `
import asyncio, json
from app.tools.redline_apply import build_redline_apply
t = build_redline_apply("org_x", "user_y")
out = asyncio.run(t.coroutine(
    contract_id="c1", clause_id="cl1", proposed_text="New clause text.",
    aggression="moderate", rationale="Aligns with playbook."))
print("<<<R>>>" + json.dumps(out))
`
  let payload = null
  try {
    const out = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
      { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    payload = JSON.parse(out.split('<<<R>>>')[1])
  } catch (e) {
    payload = { _error: String(e.stderr ?? e.message).slice(-260) }
  }

  check('the tool runs and awaits confirmation', payload?.awaitingConfirmation === true,
    payload?._error ?? JSON.stringify(payload).slice(0, 200))

  // RedlinePreview.tsx already sends exactly these keys; the tool must match or
  // the apply route's schema rejects what the model proposes.
  const args = payload?.args ?? {}
  for (const k of ['contractId', 'clauseId', 'proposedText']) {
    check(`args carry ${k}`, k in args, `got: ${Object.keys(args).join(', ') || 'none'}`)
  }
}

report('L5 redline reach')
