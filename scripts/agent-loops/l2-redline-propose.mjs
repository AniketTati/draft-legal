#!/usr/bin/env node
/**
 * L2 — `redline_propose` fails on essentially every call.
 *
 * apps/agents/app/tools/redline_propose.py builds its payload unconditionally,
 * so an unset `clause_id` or `instructions` goes over the wire as JSON null.
 * `RedlineProposeSchema` declares them `z.string().optional()`, and Zod's
 * `.optional()` REJECTS explicit null — so the endpoint 400s.
 *
 * `clause_id` and `clause_type` are documented as alternatives to each other,
 * so the model supplying both is not the normal case; the tool therefore fails
 * whenever it is used the way its own description tells the model to use it.
 *
 * The important assertion here runs the REAL Python tool rather than posting a
 * hand-built payload. Posting JSON myself would test my idea of what the tool
 * sends, which is precisely the thing in question — every other tool in that
 * directory builds its payload conditionally, and this check exists because one
 * did not.
 *
 * Run BEFORE: the realistic shapes come back as redline_propose_failed / 400.
 * Run AFTER:  they return variants.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { login, internal, db, check, report, section } from '../week-zero/lib/harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id
const TITLE = 'L2 redline propose probe'

const CLAUSE = 'The parties accept unlimited liability for all direct and indirect losses.'

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (!stale.length) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  const vIds = vs.map(v => v.id)
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vIds } } })
  await prisma.contractVersion.deleteMany({ where: { id: { in: vIds } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

await purge()
const contract = await prisma.contract.create({
  data: {
    org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
    title: TITLE, type: 'MSA', status: 'DRAFT', analysisStatus: 'DONE',
  },
  select: { id: true },
})
const version = await prisma.contractVersion.create({
  data: {
    contractId: contract.id, versionNumber: 1,
    htmlContent: `<p>${CLAUSE}</p>`, plainText: CLAUSE, createdById: userId,
  },
  select: { id: true },
})
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })
const clause = await prisma.contractClause.create({
  data: {
    versionId: version.id, clauseType: 'limitation_of_liability',
    content: CLAUSE, sectionRef: 'Section 9', sortOrder: 0,
  },
  select: { id: true },
})

/**
 * Run the actual LangChain tool the agent is given, in the agents venv.
 * Returns the raw string the tool hands back to the model.
 */
function runToolOnce(kwargs) {
  const py = `
import asyncio, json, traceback
from app.tools.redline_propose import build_redline_propose
tool = build_redline_propose(${JSON.stringify(orgId)})
try:
    out = asyncio.run(tool.coroutine(**json.loads(${JSON.stringify(JSON.stringify(kwargs))})))
    print("<<<RESULT>>>" + (out if isinstance(out, str) else json.dumps(out)))
except Exception as e:
    # Name the exception type — a ReadTimeout and a 400 are different problems
    # and the traceback tail alone does not distinguish them.
    print("<<<RESULT>>>TOOL_THREW: " + type(e).__name__ + ": " + str(e)[:300])
`
  try {
    const stdout = execFileSync(`${REPO}/apps/agents/.venv/bin/python`, ['-c', py],
      { cwd: `${REPO}/apps/agents`, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return stdout.split('<<<RESULT>>>')[1]?.trim() ?? stdout.trim()
  } catch (e) {
    return `TOOL_THREW: ${(e.stderr ?? e.stdout ?? e.message ?? '').toString().slice(-300)}`
  }
}

/**
 * The tool holds a 45s httpx timeout and each call is a reasoning-tier LLM run
 * producing three variants, so a cold or loaded run can exceed it. Retry once on
 * a TRANSPORT failure only — a 400 from the schema is the defect under test and
 * must never be retried away.
 */
function runTool(kwargs) {
  const first = runToolOnce(kwargs)
  if (!/TOOL_THREW|ReadTimeout|Timeout/.test(first)) return first
  console.log(`        (retrying after transient: ${first.slice(0, 90)})`)
  return runToolOnce(kwargs)
}

/**
 * Sections 1-3 spend minutes in python subprocesses, which is long enough for
 * Node's pooled keep-alive connection to this API to go stale — the next reuse
 * fails with ECONNRESET before the request is even sent. Retry once rather than
 * letting the check report a transport hiccup as a product defect.
 */
async function retrying(fn) {
  try { return await fn() } catch (e) {
    if (!/ECONNRESET|fetch failed/i.test(String(e?.cause ?? e))) throw e
    return fn()
  }
}

const failed = s => /redline_propose_failed|TOOL_THREW/.test(s)
const variantCount = s => {
  try {
    const j = JSON.parse(s)
    const v = j.variants ?? j.proposals ?? j.alternatives ?? []
    return Array.isArray(v) ? v.length : 0
  } catch { return 0 }
}

// ─── 1. The shape the tool's own description tells the model to use ─────────

section('1. Targeting a clause by TYPE — the documented shape')
{
  const out = runTool({ contract_id: contract.id, clause_type: 'limitation_of_liability' })
  check('redline_propose succeeds with only clause_type set', !failed(out),
    failed(out) ? out.slice(0, 220) : `returned ${out.length} chars`)
  check('it returns rewrite variants', variantCount(out) > 0,
    `${variantCount(out)} variants`)
}

// ─── 2. The documented alternative ──────────────────────────────────────────

section('2. Targeting a clause by ID — the other documented shape')
{
  const out = runTool({ contract_id: contract.id, clause_id: clause.id })
  check('redline_propose succeeds with only clause_id set', !failed(out),
    failed(out) ? out.slice(0, 220) : `returned ${out.length} chars`)
}

// ─── 3. The one shape that works today must keep working ────────────────────

section('3. All three supplied — the shape that already worked')
{
  const out = runTool({
    contract_id: contract.id, clause_id: clause.id,
    clause_type: 'limitation_of_liability', instructions: 'Cap it at 12 months of fees.',
  })
  check('supplying everything still works', !failed(out),
    failed(out) ? out.slice(0, 220) : 'ok — the fix did not regress the working shape')
}

// ─── 4. The endpoint contract itself ────────────────────────────────────────

section('4. The Node endpoint accepts an omitted optional, and rejects null')
{
  // This is the asymmetry the tool tripped over. Both assertions are true
  // before and after the Python fix — they document WHY the fix is what it is,
  // and would catch someone "fixing" it by making the tool send empty strings.
  // orgId goes in the BODY — the schema requires it there. The harness also
  // sends an x-org-id header, which is not the same thing and does not satisfy
  // RedlineProposeSchema.
  //
  // Both probes use a contractId that cannot exist, so schema validation is the
  // only thing under test. A 404 means the body was accepted and the lookup
  // failed; a 400 means the schema rejected it. Pointing these at the real
  // fixture would run the rewrite model a fourth time for no extra assurance.
  const bogus = 'contract-that-does-not-exist'

  const omitted = await retrying(() => internal('/tools/redline_propose',
    { orgId, contractId: bogus, clauseType: 'limitation_of_liability' }, orgId))
  check('omitting an optional field is accepted by the schema', omitted.status === 404,
    `status ${omitted.status} — 400 would mean .optional() rejected an absent key`)

  const explicitNull = await retrying(() => internal('/tools/redline_propose',
    { orgId, contractId: bogus, clauseType: 'limitation_of_liability', clauseId: null, instructions: null }, orgId))
  check('an explicit null is still rejected — .optional() is not .nullish()',
    explicitNull.status === 400,
    `status ${explicitNull.status}; a 404 here would mean the schema was loosened, which is a separate decision`)
}

// ─── 5. The review drawer was never on this path ────────────────────────────

section('5. The user-facing suggest path is unaffected')
{
  // contracts.ts:826 calls proposeClauseAlternatives directly and never touches
  // RedlineProposeSchema, so it must be green both before and after.
  const res = await retrying(() => fetch(
    `${process.env.API_BASE ?? 'http://localhost:3001'}/api/v1/contracts/${contract.id}/clauses/${clause.id}/suggest`,
    { method: 'POST', headers: { Authorization: `Bearer ${admin.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}) },
  ))
  check('POST /contracts/:id/clauses/:clauseId/suggest still returns variants',
    res.status === 200, `status ${res.status} — this path bypasses the broken schema`)
}

if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
report('L2 redline_propose')
