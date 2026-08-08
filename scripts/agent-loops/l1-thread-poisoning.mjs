#!/usr/bin/env node
/**
 * L1 — every successful write proposal kills the thread that made it.
 *
 * `turn_tool_calls.append({...})` runs for EVERY tool call, before the tool
 * executes. The awaiting-confirmation branch then appends an in-turn
 * ToolMessage and `continue`s — so `turn_tool_results.append(...)` further down
 * is never reached for that call. End-of-turn persistence fires anyway, because
 * its guard is `if final_text or turn_tool_calls:`.
 *
 * The session therefore stores a tool_call with no matching tool_result, and
 * `memory.py` is a dumb JSON list with no pairing check. The next turn's
 * restore rebuilds `AIMessage(tool_calls=[…all persisted…])` and then emits one
 * ToolMessage per persisted RESULT — so the write tool's `tool_call_id` has no
 * answer. OpenAI hard-rejects an assistant message with an unanswered
 * tool_call_id; Anthropic rejects a tool_use block with no tool_result.
 *
 * So: propose one write, and every later message in that thread fails.
 *
 * The primary assertion is the INVARIANT — every persisted tool_call has a
 * matching tool_result — because it is deterministic and is the actual defect.
 * The end-to-end turn is asserted too, but a model is free not to pick a write
 * tool, so that half reports honestly when it could not set the trap rather
 * than passing by default.
 *
 * Run BEFORE: the persisted turn has an unpaired tool_call, and turn 2 errors.
 * Run AFTER:  every call is paired, and turn 2 answers normally.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { login, db, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id
const TITLE = 'L1 thread poisoning probe'

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (!stale.length) return
  const ids = stale.map(c => c.id)
  await prisma.contractComment.deleteMany({ where: { contractId: { in: ids } } }).catch(() => {})
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vs.map(v => v.id) } } })
  await prisma.contractVersion.deleteMany({ where: { id: { in: vs.map(v => v.id) } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

await purge()
const contract = await prisma.contract.create({
  data: {
    org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
    title: TITLE, type: 'NDA', status: 'DRAFT', analysisStatus: 'DONE',
  },
  select: { id: true },
})
const version = await prisma.contractVersion.create({
  data: {
    contractId: contract.id, versionNumber: 1,
    htmlContent: '<p>Liability is capped at the fees paid in the prior twelve months.</p>',
    plainText: 'Liability is capped at the fees paid in the prior twelve months.',
    createdById: userId,
  },
  select: { id: true },
})
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

const sessionId = `l1-probe-${Date.now()}`

/** Read the persisted session straight out of Redis, the way the next turn will. */
function readSession(sid) {
  const py = `
import asyncio, json
from app.memory import get_session_history
print("<<<R>>>" + json.dumps(asyncio.run(get_session_history(${JSON.stringify(sid)}))))
`
  const out = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
    { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 60_000 })
  return JSON.parse(out.split('<<<R>>>')[1])
}

async function chat(message) {
  const res = await fetch(`${API}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({
      message, agentMode: true, sessionId,
      // Pin what the web clients pin (SideAgentRail.tsx, AgentHomePage.tsx).
      // The provider decides whether an unanswered tool_call_id is fatal, so a
      // check that lets the API pick a default is not testing the real path.
      provider: 'openai', modelId: 'gpt-4.1-mini',
      pageContext: { type: 'contract', id: contract.id, label: TITLE },
    }),
  })
  const body = await res.text()
  const frames = body.split('\n').filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean)
  return { status: res.status, frames }
}

// ─── 1. Drive a session that contains a write proposal ─────────────────────
//
// Both turns run before anything is asserted. Which turn the model chooses to
// propose on is not ours to control -- an earlier version asserted on turn 1
// only and went red when the model answered in prose first and proposed on
// turn 2 instead. The invariant below holds across the whole session either
// way, so that is where it is checked.

section('1. A write proposal happens somewhere in the session')
const turns = []
{
  turns.push(await chat('Add a comment to this contract saying "Reviewed by legal - please confirm the cap."'))
  turns.push(await chat('Thanks. Please add that comment now, then tell me what type of contract this is.'))

  const proposed = turns.some(t => t.frames.some(f => f.type === 'tool_call_awaiting_confirmation'))
  check('the agent proposed a write awaiting confirmation', proposed,
    proposed
      ? 'ActionPreview proposed'
      : `frames: ${turns.map(t => [...new Set(t.frames.map(f => f.type))].join('/')).join(' | ')} - no write tool was picked, so the trap was never set`)
}

// ─── 2. The invariant -- this is the defect ─────────────────────────────────

section('2. Every persisted tool_call has a matching tool_result')
{
  const history = readSession(sessionId)
  const assistantTurns = history.filter(m => m.role === 'assistant' && (m.tool_calls ?? []).length)
  check('the session persisted at least one turn with tool calls', assistantTurns.length > 0,
    `${history.length} messages, ${assistantTurns.length} carrying tool_calls`)

  const unpaired = []
  for (const t of assistantTurns) {
    const resultIds = new Set((t.tool_results ?? []).map(r => r.id))
    for (const c of t.tool_calls ?? []) {
      if (!resultIds.has(c.id)) unpaired.push(`${c.name}(${c.id})`)
    }
  }
  check('no tool_call is left without a tool_result', unpaired.length === 0,
    unpaired.length
      ? `unanswered: ${unpaired.join(', ')} - restore rebuilds an AIMessage whose tool_call_id nothing answers, and the model loses any record that it proposed the write`
      : 'every call answered')
}

// ─── 3. The thread keeps working ────────────────────────────────────────────

section('3. The thread still works after a write proposal')
{
  const t2 = turns[1]
  const errs = t2.frames.filter(f => f.type === 'error' || f.error)
  check('the follow-up turn does not error', errs.length === 0,
    errs.length ? String(errs[0].error).slice(0, 220) : 'clean')
  check('the follow-up produced a reply',
    t2.frames.some(f => f.type === 'token' || f.type === 'done'),
    `frames: ${[...new Set(t2.frames.map(f => f.type))].join(', ')}`)
}

if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
report('L1 thread poisoning')
