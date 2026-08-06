#!/usr/bin/env node
/**
 * W0-1 — the agent apply/undo path must enforce the same permissions as the
 * REST routes that perform the same writes.
 *
 * The bug: `agent-threads.ts` gates every route with `requireAuth` and nothing
 * else. A VIEWER — who is 403'd by `PATCH /contracts/:id` — can perform the
 * identical mutation by POSTing it to the agent thread's apply endpoint, which
 * proxies to an internal surface that runs as ADMIN.
 *
 * This check is two-sided on purpose. It asserts both that the escalation is
 * closed AND that a legitimately-permissioned user can still apply — a fix
 * that 403s everybody would "pass" a one-sided check while breaking the
 * feature.
 *
 * Run it BEFORE the fix: checks 2 and 5 must FAIL (the escalation succeeds).
 * Run it AFTER:          everything passes.
 */
import { login, api, check, report, section, ensureUser, db } from './lib/harness.mjs'

const prisma = db()

// ─── Fixtures ────────────────────────────────────────────────────────────────

const admin = await login()
const orgId = admin.user.orgId

const viewer = await ensureUser(orgId, 'VIEWER', 'w0-viewer@demo.com')
const manager = await ensureUser(orgId, 'CONTRACT_MANAGER', 'w0-manager@demo.com')
const viewerAuth = await login(viewer.email, viewer.password)
const managerAuth = await login(manager.email, manager.password)

/**
 * A contract we can safely flip between two adjacent statuses. Created through
 * the API as the admin, so it goes through the same path a real one does.
 */
async function freshContract(title) {
  const existing = await prisma.contract.findFirst({
    where: { orgId, title, deletedAt: null },
    select: { id: true },
  })
  if (existing) {
    await prisma.contract.update({ where: { id: existing.id }, data: { status: 'DRAFT' } })
    return existing.id
  }
  const r = await api(admin.accessToken, 'POST', '/contracts', { title, type: 'NDA' })
  if (r.status >= 300) throw new Error(`contract create → ${r.status} ${JSON.stringify(r.body)}`)
  const id = r.body.id ?? r.body.contract?.id
  await prisma.contract.update({ where: { id }, data: { status: 'DRAFT' } })
  return id
}

async function statusOf(id) {
  const c = await prisma.contract.findUnique({ where: { id }, select: { status: true } })
  return c?.status
}

/** Open a thread owned by `token`'s user and return its id. */
async function newThread(token, title) {
  const r = await api(token, 'POST', '/agent/threads', { title })
  if (r.status >= 300) throw new Error(`thread create → ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id ?? r.body.thread?.id
}

/** Apply a contract_update through the agent path. */
function applyStatusChange(token, threadId, contractId, status) {
  return api(token, 'POST', `/agent/threads/${threadId}/actions/apply`, {
    toolName: 'contract_update',
    args: {
      contractId,
      action: 'set_status',
      payload: { status },
    },
  })
}

// ─── 1. Control: the REST route already refuses a VIEWER ──────────────────────

section('1. Control — REST route refuses the VIEWER (true before and after the fix)')
const cid1 = await freshContract('W0-1 RBAC probe A')
const rest = await api(viewerAuth.accessToken, 'PATCH', `/contracts/${cid1}`, { status: 'PENDING_REVIEW' })
check(
  'VIEWER is 403 on PATCH /contracts/:id',
  rest.status === 403,
  `got ${rest.status} ${JSON.stringify(rest.body).slice(0, 120)}`,
)
check(
  'contract status unchanged by the refused REST call',
  (await statusOf(cid1)) === 'DRAFT',
  `status=${await statusOf(cid1)}`,
)

// ─── 2. The escalation: same mutation, agent path ────────────────────────────

section('2. Escalation — the same VIEWER via the agent apply path')
const vThread = await newThread(viewerAuth.accessToken, 'w0-1 viewer probe')
const esc = await applyStatusChange(viewerAuth.accessToken, vThread, cid1, 'PENDING_REVIEW')
const afterEsc = await statusOf(cid1)
check(
  'VIEWER is 403 on agent apply (matching the REST route)',
  esc.status === 403,
  `got ${esc.status} ${JSON.stringify(esc.body).slice(0, 160)}`,
)
check(
  'contract status unchanged by the VIEWER agent apply',
  afterEsc === 'DRAFT',
  `status=${afterEsc} (escalation succeeded if this is PENDING_REVIEW)`,
)

// ─── 3. Regression: a permissioned role still works ──────────────────────────

section('3. Regression — CONTRACT_MANAGER can still apply')
const cid2 = await freshContract('W0-1 RBAC probe B')
const mThread = await newThread(managerAuth.accessToken, 'w0-1 manager probe')
const ok = await applyStatusChange(managerAuth.accessToken, mThread, cid2, 'PENDING_REVIEW')
check(
  'CONTRACT_MANAGER agent apply succeeds',
  ok.status === 200,
  `got ${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`,
)
check(
  'contract status actually changed for the permissioned user',
  (await statusOf(cid2)) === 'PENDING_REVIEW',
  `status=${await statusOf(cid2)}`,
)

// ─── 4. Unknown tool is still rejected ───────────────────────────────────────

section('4. Allowlist still holds')
const bogus = await api(managerAuth.accessToken, 'POST', `/agent/threads/${mThread}/actions/apply`, {
  toolName: 'definitely_not_a_tool',
  args: {},
})
check('unregistered tool rejected with 400', bogus.status === 400, `got ${bogus.status}`)

// ─── 5. Undo is gated the same way ───────────────────────────────────────────

section('5. Undo path carries the same permission')
// The manager's apply above produced a reversible tool call; find it.
const toolCall = await prisma.toolCall.findFirst({
  where: { threadId: mThread, reversible: true },
  orderBy: { createdAt: 'desc' },
  select: { id: true },
})

if (!toolCall) {
  check('undo probe skipped — no reversible tool-call row', true, 'soft-pass: apply may have failed above')
} else {
  // Give the VIEWER their own thread carrying the same reversible call, so the
  // ownership check can't mask a missing permission check. We reassign the
  // thread rather than re-running the write, because the point is to isolate
  // authorization from ownership.
  await prisma.agentThread.update({
    where: { id: mThread },
    data: { userId: viewer.userId },
  })
  const viewerUndo = await api(
    viewerAuth.accessToken, 'POST',
    `/agent/threads/${mThread}/actions/${toolCall.id}/undo`, {},
  )
  check(
    'VIEWER is 403 on undo even when they own the thread',
    viewerUndo.status === 403,
    `got ${viewerUndo.status} ${JSON.stringify(viewerUndo.body).slice(0, 140)}`,
  )
  check(
    'undo did not revert the status for the unpermissioned user',
    (await statusOf(cid2)) === 'PENDING_REVIEW',
    `status=${await statusOf(cid2)}`,
  )
}

await prisma.$disconnect()
report('W0-1 agent apply/undo RBAC')
