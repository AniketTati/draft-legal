#!/usr/bin/env node
/**
 * L9 — three verbs the loops need and do not have.
 *
 * user_search is the blocker. contract_update's assign_owner action requires
 * payload.ownerId as a user CUID, and internal-ai.ts 404s "User not found in
 * this org" for anything else. Nothing anywhere turns a NAME into an id, so
 * "assign the Acme MSA to Alice" dead-ends: the agent either asks the user to
 * paste a CUID or gives up. The nearest existing route, GET /api/v1/users, is
 * requireAuth-only with no query param and no limit, and returns every org
 * member's email and role list -- so the internal twin has to be NARROWER than
 * its user-facing counterpart, which is the reverse of the usual direction.
 *
 * template_list answers "what can I draft from?", which today is answered from
 * memory or not at all. It must NOT include sections: they carry full HTML and
 * would blow the tool budget on the first call.
 *
 * approval_decide is the one with teeth. The REST twin's authorization
 * predicate requires the step to satisfy {id, approvalInstanceId, orgId,
 * approverId: userId, status:'PENDING'} -- so any internal twin that drops
 * `approverId` from that where-clause hands the agent the ability to approve on
 * other people's behalf. That single assertion (section 4) is the reason this
 * check exists; everything else is capability.
 *
 * Run BEFORE: none of the three tools is registered, no endpoint answers, and
 *             the assign-by-name flow produces no valid ownerId.
 * Run AFTER:  all three resolve, and approval-forgery is refused at the
 *             internal endpoint.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { login, db, check, report, section, API } from '../week-zero/lib/harness.mjs'

const REPO = '/Users/temp/Documents/Code/draft-legal'
const prisma = db()
const admin  = await login()
const orgId  = admin.user.orgId
const userId = admin.user.id

// The shared secret is not in a checked-in .env in this workspace -- both
// services read it from the real environment. Prefer our own env, fall back to
// a dotenv if one exists, and last resort read it out of a running service so
// the check works on a developer machine without extra setup.
const INTERNAL = process.env.INTERNAL_SERVICE_SECRET || readSecret()
function readSecret() {
  for (const f of ['apps/api/.env', '.env']) {
    try {
      const m = /^INTERNAL_SERVICE_SECRET=(.*)$/m.exec(
        fs.readFileSync(`${REPO}/${f}`, 'utf8').replace(/\r/g, ''))
      if (m) return m[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* next */ }
  }
  try {
    const pids = execFileSync('pgrep', ['-f', 'uvicorn main:app'], { encoding: 'utf8' }).trim().split('\n')
    for (const pid of pids) {
      const env = execFileSync('ps', ['-Eww', '-p', pid], { encoding: 'utf8' })
      const m = /INTERNAL_SERVICE_SECRET=(\S+)/.exec(env)
      if (m) return m[1]
    }
  } catch { /* fall through */ }
  return ''
}

/** Call an internal tool endpoint the way the agents service does. */
async function tool(name, body) {
  const res = await fetch(`${API}/api/internal/ai/tools/${name}`, {
    method: 'POST',
    headers: {
      'x-internal-secret':  INTERNAL,
      'x-internal-service': 'agents',
      'content-type':       'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* left null */ }
  return { status: res.status, json, text }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TAG = 'l9probe'
const CONTRACT_TITLE = 'L9 assign-by-name probe'

async function purge() {
  await prisma.approvalStep.deleteMany({ where: { orgId, stepName: { startsWith: TAG } } }).catch(() => {})
  const insts = await prisma.approvalInstance.findMany({
    where: { orgId, contract: { title: CONTRACT_TITLE } }, select: { id: true },
  }).catch(() => [])
  if (insts.length) {
    await prisma.approvalStep.deleteMany({ where: { approvalInstanceId: { in: insts.map(i => i.id) } } }).catch(() => {})
    await prisma.approvalInstance.deleteMany({ where: { id: { in: insts.map(i => i.id) } } }).catch(() => {})
  }
  const stale = await prisma.contract.findMany({ where: { orgId, title: CONTRACT_TITLE }, select: { id: true } })
  if (stale.length) {
    const ids = stale.map(c => c.id)
    await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
    const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
    await prisma.contractClause.deleteMany({ where: { versionId: { in: vs.map(v => v.id) } } }).catch(() => {})
    await prisma.contractVersion.deleteMany({ where: { id: { in: vs.map(v => v.id) } } })
    await prisma.contract.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.template.deleteMany({ where: { orgId, name: { startsWith: TAG } } }).catch(() => {})
  await prisma.workflowDefinition.deleteMany({ where: { orgId, name: { startsWith: TAG } } }).catch(() => {})
  // No orgId filter: the cross-tenant fixture lives in a different org, and
  // User.email is globally unique, so an org-scoped purge leaves a collision.
  await prisma.user.deleteMany({ where: { email: { contains: `${TAG}+` } } }).catch(() => {})
}

await purge()

// Two people called Alice, so "assign it to Alice" is genuinely ambiguous.
const alices = []
for (const [i, surname] of [[1, 'Nakamura'], [2, 'Okonkwo']]) {
  alices.push(await prisma.user.create({
    data: {
      orgId, name: `Alice ${surname}`, email: `${TAG}+alice${i}@example.test`,
      passwordHash: 'x', status: 'ACTIVE',
    },
    select: { id: true, name: true, email: true },
  }))
}
// One unambiguous person, for the happy path.
const bob = await prisma.user.create({
  data: {
    orgId, name: 'Bertrand Vasquez', email: `${TAG}+bertrand@example.test`,
    passwordHash: 'x', status: 'ACTIVE',
  },
  select: { id: true, name: true, email: true },
})

// A user in a DIFFERENT org, who must never appear in this org's results.
const otherOrg = await prisma.organization.findFirst({ where: { id: { not: orgId } }, select: { id: true } })
const foreigner = otherOrg
  ? await prisma.user.create({
      data: {
        orgId: otherOrg.id, name: 'Alice Trespasser', email: `${TAG}+foreign@example.test`,
        passwordHash: 'x', status: 'ACTIVE',
      },
      select: { id: true },
    })
  : null

const template = await prisma.template.create({
  data: {
    orgId, name: `${TAG} Mutual NDA`, description: 'Probe template',
    contractType: 'NDA', isPublished: true, createdById: userId,
    sections: { create: [{ title: 'Confidentiality', sortOrder: 0, content: '<p>'.concat('x'.repeat(4000), '</p>') }] },
  },
  select: { id: true },
})

const contract = await prisma.contract.create({
  data: {
    org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
    title: CONTRACT_TITLE, type: 'MSA', status: 'DRAFT', analysisStatus: 'DONE',
  },
  select: { id: true },
})

// A single-step workflow, so advanceWorkflow has something real to close.
const workflow = await prisma.workflowDefinition.create({
  data: {
    orgId, name: `${TAG} single-step review`, createdById: userId, isActive: true,
    steps: [{ order: 1, name: `${TAG} legal review`, approverRule: { type: 'user' } }],
  },
  select: { id: true },
})

// ─── 1. user_search — the name→id path that did not exist ───────────────────

section('1. user_search resolves a name to an id, org-scoped')
{
  const r = await tool('user_search', { orgId, query: 'Bertrand' })
  check('user_search answers', r.status === 200,
    `HTTP ${r.status} ${r.text.slice(0, 160)} — before this, no endpoint turned a name into a user id at all`)

  const items = r.json?.items ?? []
  check('it finds the user by partial name', items.some(u => u.id === bob.id),
    `${items.length} hits: ${items.map(u => u.name).join(', ') || '(none)'}`)

  // The redactor's email pattern would destroy exactly the field that
  // disambiguates two people with the same first name. This is internal
  // directory data, not counterparty document text -- the exemption is
  // deliberate, and pinned here so a future redaction sweep cannot quietly
  // break name resolution.
  const me = items.find(u => u.id === bob.id)
  check('the email comes back un-redacted', me?.email === bob.email,
    `got ${JSON.stringify(me?.email)} — a redacted email cannot disambiguate two people named Alice`)

  const foreign = await tool('user_search', { orgId, query: 'Trespasser' })
  const leaked = (foreign.json?.items ?? []).some(u => u.id === foreigner?.id)
  check('a user from another org never appears', !leaked,
    foreigner ? (leaked ? 'CROSS-TENANT LEAK' : 'org-scoped') : 'no second org in this workspace — assertion skipped')

  const capped = await tool('user_search', { orgId, limit: 2 })
  check('it takes a limit', (capped.json?.items ?? []).length <= 2,
    `returned ${(capped.json?.items ?? []).length} for limit=2 — GET /api/v1/users has no limit and returns every member`)
}

// ─── 2. Ambiguity is surfaced, not guessed ──────────────────────────────────
//
// A name-resolution tool that guesses is worse than none: it silently assigns
// the wrong person and reports success. The tool's job is to hand the model
// both candidates and say so.

section('2. Two people named Alice are reported as ambiguous')
{
  const r = await tool('user_search', { orgId, query: 'Alice' })
  const items = r.json?.items ?? []
  const ids = new Set(items.map(u => u.id))
  check('both Alices are returned', alices.every(a => ids.has(a.id)),
    `${items.length} hits: ${items.map(u => `${u.name} <${u.email}>`).join(', ')}`)
  check('the result flags the ambiguity explicitly', r.json?.ambiguous === true,
    'the model should be told to disambiguate rather than left to infer it from a count it may not read')

  const single = await tool('user_search', { orgId, query: 'Bertrand' })
  check('a single match is not flagged ambiguous', single.json?.ambiguous === false,
    `ambiguous=${single.json?.ambiguous} — flagging every search would train the model to ignore the flag`)
}

// ─── 3. template_list — without the HTML that would blow the budget ─────────

section('3. template_list answers "what can I draft from?"')
{
  const r = await tool('template_list', { orgId })
  check('template_list answers', r.status === 200,
    `HTTP ${r.status} ${r.text.slice(0, 160)} — no endpoint existed; /api/v1/templates is JWT-gated and unreachable from the agents service`)

  const items = r.json?.items ?? []
  check('it lists the org template', items.some(t => t.id === template.id),
    `${items.length} templates`)
  check('it reports a total', typeof r.json?.total === 'number', `total=${r.json?.total}`)

  // sections carry full section HTML. One template with a few sections is
  // tens of KB, and the 800-char stream cap would cut the JSON mid-token.
  check('no section HTML comes back', !/xxxxxxxxxx/.test(r.text) && !/"sections"/.test(r.text),
    `payload is ${r.text.length} chars — dropping sections is the difference between a listing and a budget blowout`)
}

// ─── 4. approval_decide — the assertion that matters ────────────────────────
//
// The REST twin requires approverId === the calling user. An internal twin that
// drops it turns this tool into an approval-forgery path: the agent could
// approve anything, on anyone's behalf, inside its own org.

section('4. approval_decide cannot forge someone else\'s approval')
{
  const instance = await prisma.approvalInstance.create({
    data: {
      orgId, contractId: contract.id, workflowDefinitionId: workflow.id,
      status: 'PENDING', submittedById: userId,
      steps: {
        create: [{
          orgId, stepOrder: 1, stepName: `${TAG} legal review`,
          approverId: alices[0].id, status: 'PENDING',
        }],
      },
    },
    select: { id: true, steps: { select: { id: true, approverId: true } } },
  }).catch(err => ({ _error: String(err.message).slice(0, 200) }))

  if (instance._error) {
    check('the approval fixture was created', false, instance._error)
  } else {
    const step = instance.steps[0]

    // The forgery attempt: the admin is NOT the assigned approver.
    const forged = await tool('approval_decide', {
      orgId, userId, instanceId: instance.id, stepId: step.id, decision: 'APPROVED',
    })
    check('deciding a step assigned to someone else is refused', forged.status === 403,
      `HTTP ${forged.status} ${forged.text.slice(0, 160)} — this is the assertion that stops approval_decide becoming a forgery path`)

    const stillPending = await prisma.approvalStep.findUnique({
      where: { id: step.id }, select: { status: true },
    })
    check('the step is untouched after the refusal', stillPending?.status === 'PENDING',
      `status=${stillPending?.status}`)

    // REJECTED with no comment — the REST twin 400s; the twin must match.
    const noComment = await tool('approval_decide', {
      orgId, userId: alices[0].id, instanceId: instance.id, stepId: step.id, decision: 'REJECTED',
    })
    check('REJECTED without a comment is a 400', noComment.status === 400,
      `HTTP ${noComment.status} ${noComment.text.slice(0, 160)} — matching approvals.ts, or the two paths disagree on the same rule`)

    // The happy path, as the actual assigned approver.
    const ok = await tool('approval_decide', {
      orgId, userId: alices[0].id, instanceId: instance.id, stepId: step.id,
      decision: 'APPROVED', comment: 'looks fine',
    })
    check('the assigned approver can decide', ok.status === 200,
      `HTTP ${ok.status} ${ok.text.slice(0, 200)}`)

    const decided = await prisma.approvalStep.findUnique({
      where: { id: step.id }, select: { status: true, decision: true, decidedAt: true },
    })
    check('the step is recorded as APPROVED', decided?.status === 'APPROVED' && decided?.decidedAt != null,
      `status=${decided?.status} decision=${decided?.decision} decidedAt=${decided?.decidedAt}`)

    const audit = await prisma.auditEvent.findFirst({
      where: { orgId, resourceType: 'approval_step', resourceId: step.id, action: 'APPROVAL_DECIDED' },
      select: { id: true, userId: true },
    })
    check('an APPROVAL_DECIDED audit event names the deciding user', audit?.userId === alices[0].id,
      `audit=${audit?.id ?? 'MISSING'} userId=${audit?.userId} — a write tool with no audit row is unattributable`)
  }
}

// ─── 5. "Assign it to <name>" end to end ────────────────────────────────────
//
// The headline claim. Before this, the agent knew assign_owner existed, had no
// way to turn a name into an id, and either asked the user to paste a CUID or
// gave up. The assertion is not "a tool ran" -- it is that the proposed
// ownerId is the RIGHT person's real CUID.

section('5. Assign-by-name reaches a valid ownerId')
{
  let frames = []
  let proposal = null
  for (let attempt = 1; attempt <= 3 && !proposal; attempt++) {
    const res = await fetch(`${API}/api/v1/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({
        message: `Assign the "${CONTRACT_TITLE}" contract to Bertrand.`,
        agentMode: true, sessionId: `l9-assign-probe-${Date.now()}-${attempt}`,
        pageContext: { type: 'contract', id: contract.id, label: CONTRACT_TITLE },
      }),
    })
    frames = (await res.text()).split('\n').filter(l => l.startsWith('data:'))
      .map(l => { try { return JSON.parse(l.slice(5).trim()) } catch { return null } })
      .filter(Boolean)
    proposal = frames.find(f => f.type === 'tool_call_awaiting_confirmation' && f.name === 'contract_update') ?? null
  }

  check('the agent proposed a contract_update', proposal != null,
    proposal ? 'proposed' : `frames: ${[...new Set(frames.map(f => f.name ?? f.type))].join(', ')} — no assign was proposed in 3 attempts`)

  const searched = frames.some(f => f.type === 'tool_call_result' && f.name === 'user_search')
  check('it resolved the name through user_search', searched,
    searched ? 'user_search ran' : 'the agent reached assign_owner without resolving a name — where did the id come from?')

  const args = proposal?.args ?? {}
  const ownerId = args.payload?.ownerId ?? args.ownerId
  check('the proposed ownerId is the real user CUID', ownerId === bob.id,
    `ownerId=${JSON.stringify(ownerId)} expected=${bob.id} — before this the flow dead-ended: no tool resolved a name, and assign_owner 404s on anything that is not a CUID`)
}

// ─── 6. The tools are actually reachable by the model ───────────────────────
//
// An endpoint nothing binds is not a capability. Three separate registries have
// to agree, and each has been the one that was forgotten before.

section('6. All three verbs are registered end to end')
{
  const initPy  = fs.readFileSync(`${REPO}/apps/agents/app/tools/__init__.py`, 'utf8')
  const threads = fs.readFileSync(`${REPO}/apps/api/src/routes/agent-threads.ts`, 'utf8')
  const prompt  = fs.readFileSync(`${REPO}/apps/agents/app/orchestrator.py`, 'utf8')

  for (const t of ['user_search', 'template_list', 'approval_decide']) {
    check(`${t} has a tool module`, fs.existsSync(`${REPO}/apps/agents/app/tools/${t}.py`))
    check(`${t} is in the tool registry`, initPy.includes(`build_${t}`),
      'a tool file nothing imports is dead code')
    check(`${t} is named in the system prompt`, prompt.includes(t),
      'L7 measured that the prompt outranks tool descriptions for routing; an unmentioned tool is rarely picked')
  }

  // approval_decide is a WRITE tool. agent-threads.ts is the ONLY layer that
  // sees the caller's role -- the internal endpoints downstream authenticate
  // the service, and a valid internal secret maps to roles:['ADMIN'].
  check('approval_decide is in the WRITE_TOOLS permission map',
    /\['approval_decide',\s*\['approve',\s*'workflow'\]\]/.test(threads),
    'without this entry a VIEWER could apply it: the map is the only place the caller role is checked')
  check('approval_decide maps its user field to userId',
    /body\.toolName === 'approval_decide'\s*\?\s*'userId'/.test(threads),
    'the wrong field name means orgId/userId are not injected and the downstream Zod schema rejects the call')
  check('approval_decide is not offered as reversible',
    !/REVERSIBLE[^\n]*approval_decide/.test(threads),
    'advanceWorkflow may already have closed the instance and fired notifications; that cannot unwind in a 15-minute window')
}

if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
report('L9 new verbs')
