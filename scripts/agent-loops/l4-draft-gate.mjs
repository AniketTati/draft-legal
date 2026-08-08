#!/usr/bin/env node
/**
 * L4(a) — contract creation escapes every guardrail the platform has.
 *
 * `build_contract_create_from_template` is registered in the READ-tool block,
 * above the `# Write tools` comment. Its `_arun` POSTs straight to
 * `/tools/contract_draft` and returns `r.text` — it never returns the
 * `awaitingConfirmation` dict the orchestrator short-circuits on. So a contract
 * is created mid-stream, and because no ActionPreview is ever produced,
 * `checkToolPermission` — documented as THE only layer that can see the
 * caller's role — never runs.
 *
 * A VIEWER holds `view:contract` and not `create:contract`, and
 * `POST /api/v1/contracts` refuses them. Asking the assistant does not.
 *
 * ── What this check does and does not enforce ────────────────────────────────
 *
 * Drafting immediately, without a confirmation card, is a DELIBERATE
 * draft-first product choice — `orchestrator.py` instructs the model to draft
 * before asking. This check therefore does NOT assert that a card appears.
 * It asserts the three gaps that the missing card opened and that nobody chose:
 * no permission check, no audit trail, and an owner picked arbitrarily.
 *
 * Whether drafting should move behind the confirmation gate is an open question
 * for the founder in docs/36, and deliberately not answered here.
 *
 * Run BEFORE: a VIEWER can create contracts by asking, no audit row is written,
 *             and the owner is whichever user the org lists first.
 * Run AFTER:  the tool is not offered to a caller without create:contract, the
 *             create is audited, and the owner is the caller.
 */
import { login, api, internal, db, check, report, section, ensureUser } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

const viewer = await ensureUser(orgId, 'VIEWER', 'l4-viewer@demo.com')
const viewerAuth = await login(viewer.email, viewer.password)

const DRAFT_ASK = 'Draft a short mutual NDA with Initech for a 2-year term.'

/** Contracts this probe caused, by org, so assertions are about THIS run. */
const since = new Date()

async function contractsCreatedSince() {
  return prisma.contract.findMany({
    where: { orgId, createdAt: { gte: since } },
    select: { id: true, title: true, ownerId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
}

async function chatAs(token, message) {
  const res = await fetch(`${process.env.API_BASE ?? 'http://localhost:3001'}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message, agentMode: true,
      sessionId: `l4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'openai', modelId: 'gpt-4.1-mini',
    }),
  })
  const body = await res.text()
  const frames = body.split('\n').filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
    .filter(Boolean)
  return { status: res.status, frames, body }
}

// ─── 1. The control — the REST route already refuses a viewer ───────────────

section('1. The REST route refuses a VIEWER (true before and after)')
{
  const res = await api(viewerAuth.accessToken, 'POST', '/contracts', {
    title: 'L4 viewer direct create', type: 'NDA',
  })
  check('POST /contracts is 403 for a VIEWER', res.status === 403,
    `status ${res.status} — this is the bar the agent path should meet`)
}

// ─── 2. The agent path must meet the same bar ───────────────────────────────

section('2. A VIEWER cannot create a contract by asking')
{
  const before = (await contractsCreatedSince()).length
  const t = await chatAs(viewerAuth.accessToken, DRAFT_ASK)
  const after = await contractsCreatedSince()

  check('no contract was created for the VIEWER', after.length === before,
    after.length > before
      ? `created: ${after.slice(0, 2).map(c => `"${c.title}"`).join(', ')} — the assistant did what the REST route forbids`
      : 'nothing created')

  // The tool must not be in this caller's catalog.
  //
  // Asserting on tool_call_start alone is wrong: the orchestrator emits that
  // frame BEFORE looking the name up, so a model that hallucinates a withheld
  // tool still produces one and then gets {"error":"unknown_tool"}. What
  // matters is that the call cannot SUCCEED. An earlier version of this
  // assertion read intent instead of outcome and went red while the denial was
  // working correctly.
  const toolNames = t.frames.filter(f => f.type === 'tool_call_start').map(f => f.name)
  const draftResults = t.frames.filter(f =>
    f.type === 'tool_call_result' && f.name === 'contract_create_from_template')
  const succeeded = draftResults.some(f => !/unknown_tool/.test(JSON.stringify(f.result ?? f)))
  check('the drafting tool is not usable by the VIEWER', !succeeded,
    succeeded
      ? `it executed for a caller without create:contract (tools called: ${toolNames.join(', ')})`
      : `withheld from the catalog (model attempted: ${toolNames.join(', ') || 'none'})`)
}

// ─── 3-5. The drafting endpoint itself ──────────────────────────────────────
//
// Driven directly rather than through chat. Whether the model picks
// contract_create_from_template for a given sentence is not deterministic — an
// earlier version of this check asked it to draft an NDA and passed or failed
// on the model's mood. Section 2 above is where the model's access is asserted;
// these three assert what the endpoint does once it IS called.

section('3-5. The drafting endpoint creates, attributes and audits')
{
  const res = await internal('/tools/contract_draft', {
    orgId, userId: admin.user.id,
    userMessage: DRAFT_ASK,
    contractType: 'NDA',
    counterpartyName: 'Initech',
    title: 'L4 endpoint draft probe',
  }, orgId)

  check('the endpoint drafts a contract', res.status === 200 && !!res.body?.contractId,
    res.status === 200 ? `created ${res.body?.contractId}` : `status ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`)

  const draftId = res.body?.contractId
  if (draftId) {
    const c = await prisma.contract.findUnique({
      where: { id: draftId }, select: { ownerId: true, createdBy: true },
    })
    check('the contract is owned by the caller', c?.ownerId === admin.user.id,
      c?.ownerId === admin.user.id ? 'owner = caller' : `owner is ${c?.ownerId}`)

    // createAuditEvent is fire-and-forget by design -- an audit failure must
    // not fail the draft -- so poll briefly rather than racing it.
    let events = []
    for (let i = 0; i < 10 && events.length === 0; i++) {
      events = await prisma.auditEvent.findMany({
        where: { resourceId: draftId },
        select: { action: true, userId: true, metadata: true },
      })
      if (!events.length) await new Promise(r => setTimeout(r, 400))
    }
    check('an AuditEvent names the contract and the actor',
      events.length > 0 && events.some(e => e.userId === admin.user.id),
      events.length
        ? `${events.length} event(s): ${[...new Set(events.map(e => e.action))].join(', ')}`
        : 'internal-ai.ts had zero createAuditEvent calls — an agent-created contract left no trace of who caused it')
  } else {
    check('owner assertion skipped — nothing drafted', false, '')
    check('audit assertion skipped — nothing drafted', false, '')
  }
}

// ─── 6. /agent/draft — the second, simpler bypass ───────────────────────────

section('6. POST /agent/draft honours create:contract')
{
  const res = await api(viewerAuth.accessToken, 'POST', '/agent/draft', {
    userMessage: DRAFT_ASK,
    saveAs: { title: 'L4 viewer draft-route create' },
  })
  check('a VIEWER cannot create through /agent/draft', res.status === 403,
    `status ${res.status} — the route gates on view:contract while creating contracts`)

  const leaked = await prisma.contract.findFirst({
    where: { orgId, title: 'L4 viewer draft-route create' }, select: { id: true },
  })
  check('no contract was created by that call', !leaked,
    leaked ? 'a row exists despite the caller lacking create:contract' : 'nothing created')
  if (leaked) await prisma.contract.delete({ where: { id: leaked.id } }).catch(() => {})
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

const mine = await contractsCreatedSince()
for (const c of mine) {
  await prisma.contractVersion.deleteMany({ where: { contractId: c.id } }).catch(() => {})
  await prisma.contract.delete({ where: { id: c.id } }).catch(() => {})
}
await prisma.$disconnect()
report('L4 agent drafting gate')
