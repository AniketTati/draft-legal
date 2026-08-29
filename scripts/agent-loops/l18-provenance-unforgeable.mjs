#!/usr/bin/env node
/**
 * L18 — the browser cannot say which model gave legal advice.
 *
 * AppendTurnSchema accepted provider, model, tier, inputTokens, outputTokens,
 * costUsd and traceId FROM THE CLIENT and persisted all seven verbatim onto
 * AgentMessage. So the record of which model produced a contract answer was
 * whatever the browser claimed, and any authenticated user could post an
 * arbitrary model name or cost onto a turn.
 *
 * It was not only forgeable, it was already false: SideAgentRail sent the
 * literal `provider: 'openai', model: 'gpt-4.1-mini'` on every turn regardless
 * of what answered, and AgentHomePage sent nothing. On the dev database only 9
 * of 107 assistant turns carried a model, and those 9 were that constant.
 *
 * docs/37 E2 is the same defect one layer up: 66 persona conversations were
 * attributed to a model they never ran on. This is its production twin.
 *
 * Run BEFORE: a forged POST is accepted and stored.
 * Run AFTER:  it is rejected, and real turns carry what the agents service said.
 */
import { check, report, section, api, login, db } from '../week-zero/lib/harness.mjs'
import { readDoneProvenance } from '../../apps/api/dist/lib/turn-provenance.js'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

let threadId = null
try {
  const thread = await prisma.agentThread.create({
    data: { orgId, userId: admin.user.id, title: 'L18 provenance fixture' },
    select: { id: true },
  })
  threadId = thread.id

  section('1. A forged provenance POST is refused, not ignored')
  {
    const r = await api(admin.accessToken, 'POST', `/agent/threads/${threadId}/turns`, {
      userMessage: 'what is our liability cap with Acme?',
      assistant: {
        content: 'The cap is $5,000,000.',
        provider: 'totally-made-up',
        model:    'gpt-9-ultra',
        costUsd:  0.0001,
        traceId:  'forged-trace',
      },
    })
    // REJECTED, not stripped. Silently ignoring would leave a client "working"
    // while sending values that go nowhere — exactly how the hardcoded literal
    // survived unnoticed.
    check('a POST carrying provenance is rejected', r.status >= 400 && r.status < 500,
      `status ${r.status} — a 2xx here means the browser is still the system of record for provenance`)

    const stored = await prisma.agentMessage.findMany({
      where: { threadId, role: 'assistant' }, select: { model: true, provider: true },
    })
    check('nothing forged was persisted', stored.every(m => m.model !== 'gpt-9-ultra'),
      JSON.stringify(stored))
  }

  section('2. A clean turn is accepted and carries no client-supplied model')
  {
    const r = await api(admin.accessToken, 'POST', `/agent/threads/${threadId}/turns`, {
      userMessage: 'and the notice period?',
      assistant: { content: '30 days.' },
    })
    check('a turn without provenance is accepted', r.status === 200, `status ${r.status}`)

    const msg = await prisma.agentMessage.findFirst({
      where: { threadId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { model: true, provider: true, tier: true, content: true },
    })
    check('the turn was stored', !!msg)
    // Null is the honest answer when the turn did not go through /agent/chat.
    // A plausible-looking constant is what this check exists to prevent.
    check('provenance is null rather than invented',
      msg?.model === null && msg?.provider === null,
      `got ${msg?.provider}/${msg?.model} — nothing should have supplied these`)
  }

  section('3. The done frame is what provenance is read from')
  {
    const sse = [
      'data: {"type":"token","delta":"The cap is ","model_id":"gpt-4.1-mini"}',
      'data: {"type":"token","delta":"$5m.","model_id":"gpt-4.1-mini"}',
      'data: {"type":"done","session_id":"s1","provider":"anthropic","model":"claude-opus-4","tier":"reasoning","source":"byok","model_id":"gpt-4.1-mini"}',
      'data: [DONE]',
      '',
    ].join('\n')
    const prov = readDoneProvenance(Buffer.from(sse, 'utf8'))
    check('the resolved model is read, not the requested one', prov?.model === 'claude-opus-4',
      `got ${prov?.model} — routes/chat.py stamps model_id (the REQUEST) onto every frame, so reading that key first reports a model that may never have run`)
    check('provider and tier come from the done frame',
      prov?.provider === 'anthropic' && prov?.tier === 'reasoning')
    check('source is captured', prov?.source === 'byok',
      'whose key paid answers: did this org own key answer their question?')

    check('a stream with no done frame yields null',
      readDoneProvenance(Buffer.from('data: {"type":"token","delta":"hi"}\n', 'utf8')) === null,
      'inventing a model when none was reported is the bug, not the fix')
    check('an empty tail yields null', readDoneProvenance(Buffer.alloc(0)) === null)

    // The scan runs BACKWARDS. A tool result carrying "done" inside a string is
    // harmless (it parses as type tool_call_result), so the case that actually
    // matters is more than one done frame reaching the tail -- the LAST one is
    // the turn's. Asserted with two, because a forward scan returns the first
    // and this is the only thing that makes the direction load-bearing.
    const twoDone = [
      'data: {"type":"done","provider":"openai","model":"stale-earlier-frame","tier":"fast"}',
      'data: {"type":"token","delta":"more"}',
      'data: {"type":"done","provider":"anthropic","model":"claude-opus-4","tier":"reasoning"}',
      '',
    ].join('\n')
    check('the LAST done frame wins, not the first',
      readDoneProvenance(Buffer.from(twoDone, 'utf8'))?.model === 'claude-opus-4',
      'a forward scan would report a superseded resolution as the one that answered')
  }

  section('4. The clients no longer send what the server rejects')
  {
    const fs = await import('node:fs')
    const rail = fs.readFileSync('apps/web/src/components/agent/SideAgentRail.tsx', 'utf8')
    const home = fs.readFileSync('apps/web/src/pages/AgentHomePage.tsx', 'utf8')
    check('the rail no longer hardcodes a model', !/model:\s*'gpt-4\.1-mini'/.test(rail),
      'every rail turn was persisted as that literal regardless of what answered')
    check('the rail sends content only', /assistant:\s*\{\s*content:\s*finalText\s*\}/.test(rail))
    check('AgentHomePage reads the resolved model first',
      /model:\s*String\(evt\.model \?\? evt\.model_id/.test(home),
      'reading model_id first showed the request, never the answer')
  }
} finally {
  if (threadId) await prisma.agentThread.delete({ where: { id: threadId } }).catch(() => {})
  await prisma.$disconnect()
}

section('5. Both chat surfaces disclose that a machine is answering')
{
  const fs = await import('node:fs')
  const rail = fs.readFileSync('apps/web/src/components/agent/SideAgentRail.tsx', 'utf8')
  const home = fs.readFileSync('apps/web/src/pages/AgentHomePage.tsx', 'utf8')

  // EU AI Act Art 50(1) has applied since 2026-08-02: a user must be told they
  // are interacting with an AI system unless it is obvious from context, and it
  // must be perceivable in the interaction rather than buried in terms.
  check('a single shared disclosure string exists',
    /export const DISCLOSURE\s*=/.test(rail),
    'two surfaces stating it differently is how one of them silently loses it')
  check('it says the thing plainly', /AI assistant/i.test(rail),
    'the rail empty state used to say "I\'m context-aware" in the first person, with no statement that it is a machine')
  check('it warns the output can be wrong', /can be wrong/i.test(rail),
    'a verification duty the user cannot discharge is not a disclosure')

  for (const [name, src] of [['the rail', rail], ['AgentHomePage', home]]) {
    check(`${name} renders it before the first reply`,
      /data-testid="ai-disclosure"/.test(src),
      'the per-message "Machine-authored" marker only appears AFTER a reply, which is too late for Art 50')
  }
  check('AgentHomePage uses the shared constant, not its own copy',
    /\{DISCLOSURE\}/.test(home))
}

report('L18 provenance unforgeable')
