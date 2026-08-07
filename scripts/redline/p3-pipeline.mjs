#!/usr/bin/env node
/**
 * Phase 3 — the pipeline. Upload the other side's paper, get back a complete
 * first-pass markup against our playbook, review it change by change.
 *
 * Phases 0-2 built the parts: a checker that reports honestly, a batch
 * rewriter, and an apply that lands N clauses as one version. Nothing chains
 * them. This does — and it STAGES rather than applies, because the whole point
 * is that a lawyer reviews the markup before it touches the document.
 *
 * What matters most, in order:
 *
 *   1. STAGED, NOT APPLIED. A pipeline that writes to the contract before a
 *      human looks is not a redline, it is an unreviewed edit.
 *   2. THE STAGED SET MATCHES THE DEVIATIONS. If the checker flags three
 *      clauses and the pipeline stages two, the missing one is invisible —
 *      exactly the silent miss Phase 0 existed to remove.
 *   3. ACCEPTING A SUBSET APPLIES EXACTLY THAT SUBSET. Rejecting a change must
 *      leave the clause alone, not "mostly" alone.
 *   4. THE RUN SURVIVES A RELOAD. It takes minutes; a user will navigate away.
 *
 * Run BEFORE: no pipeline route — everything fails.
 * Run AFTER:  all pass.
 */
import { login, api, internal, check, report, section, db } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id

const TITLE = 'P3 pipeline probe'

// Two clauses that DEVIATE from the playbook, and one that complies. The
// compliant one is the control: a pipeline that stages all three is not
// reading the checker, it is rewriting everything.
const FIXTURES = [
  {
    clauseType: 'limitation_of_liability',
    categoryName: 'Limitation of Liability',
    preferred: 'Liability shall be capped at two times (2x) the fees paid in the preceding twelve months.',
    rules: { must_have: [{ id: 'cap', description: 'A liability cap must be present', check: 'contains', value: 'capped', severity: 'high' }] },
    content: 'The parties accept unlimited liability for all direct and indirect losses.',
    deviates: true,
  },
  {
    clauseType: 'governing_law',
    categoryName: 'Governing Law',
    preferred: 'This Agreement shall be governed by the laws of the State of Delaware.',
    rules: { must_have: [{ id: 'de', description: 'Delaware law', check: 'contains', value: 'delaware', severity: 'high' }] },
    content: 'This Agreement shall be governed by the laws of the State of New York.',
    deviates: true,
  },
  {
    clauseType: 'confidentiality',
    categoryName: 'Confidentiality',
    preferred: 'Confidential information shall be protected for three years.',
    rules: { must_have: [{ id: 'conf', description: 'Mentions confidentiality', check: 'contains', value: 'confidential', severity: 'medium' }] },
    // Satisfies the rule — must NOT be staged.
    content: 'Each party shall keep all confidential information secret for three years from disclosure.',
    deviates: false,
  },
]

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: { startsWith: TITLE } }, select: { id: true } })
  if (stale.length === 0) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const vs = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  const vIds = vs.map(v => v.id)
  await prisma.contractClause.deleteMany({ where: { versionId: { in: vIds } } })
  await prisma.contractVersion.deleteMany({ where: { id: { in: vIds } } })
  await prisma.contract.deleteMany({ where: { id: { in: ids } } })
}

async function seed() {
  await purge()
  const contract = await prisma.contract.create({
    data: {
      org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
      title: TITLE, type: 'NDA', status: 'DRAFT', analysisStatus: 'DONE',
    },
    select: { id: true },
  })
  const html = FIXTURES.map(f => `<p>${f.content}</p>`).join('\n')
  const plain = FIXTURES.map(f => f.content).join('\n\n')
  const version = await prisma.contractVersion.create({
    data: { contractId: contract.id, versionNumber: 1, htmlContent: html, plainText: plain, createdById: userId },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

  const byType = {}
  for (const [i, f] of FIXTURES.entries()) {
    let cat = await prisma.clauseCategory.findFirst({ where: { orgId, name: f.categoryName } })
    cat ??= await prisma.clauseCategory.create({ data: { org: { connect: { id: orgId } }, name: f.categoryName } })
    await prisma.playbookPosition.deleteMany({ where: { orgId, clauseCategoryId: cat.id } })
    await prisma.playbookPosition.create({
      data: {
        org: { connect: { id: orgId } }, clauseCategory: { connect: { id: cat.id } },
        createdById: userId, positionType: 'preferred', content: f.preferred, rules: f.rules,
      },
    })
    const cl = await prisma.contractClause.create({
      data: { versionId: version.id, clauseType: f.clauseType, content: f.content, sectionRef: `Section ${i + 1}`, sortOrder: i },
      select: { id: true },
    })
    byType[f.clauseType] = cl.id
  }
  return { contractId: contract.id, versionId: version.id, byType }
}

const versionCount = contractId => prisma.contractVersion.count({ where: { contractId } })

const contractMeta = async id =>
  (await prisma.contract.findUnique({ where: { id }, select: { metadata: true } }))?.metadata ?? {}

/** Poll the way the page does — status lives in contract.metadata. */
async function waitForRun(contractId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const meta = await contractMeta(contractId)
    const status = meta._playbookRedlineStatus
    if (status && status !== 'RUNNING' && status !== 'QUEUED') return { status, meta }
    await new Promise(r => setTimeout(r, 2000))
  }
  return { status: 'TIMEOUT', meta: await contractMeta(contractId) }
}

const fx = await seed()

// ─── 1. The pipeline runs and stages, without touching the document ─────────

section('1. The run stages a markup and leaves the document alone')
let staged
{
  const versionsBefore = await versionCount(fx.contractId)

  const start = await api(admin.accessToken, 'POST', `/contracts/${fx.contractId}/redline-against-playbook`, {
    aggression: 'moderate',
  })
  check('the pipeline accepts the request',
    start.status === 202,
    start.status === 404
      ? '404 — no pipeline route; the parts exist but nothing chains them'
      : `status=${start.status} ${JSON.stringify(start.body).slice(0, 180)}`)

  if (start.status !== 202) {
    await purge(); await prisma.$disconnect(); report('P3 redline pipeline'); process.exit(1)
  }

  check('it reports a status the page can poll',
    ['QUEUED', 'RUNNING'].includes((await contractMeta(fx.contractId))._playbookRedlineStatus),
    `status=${(await contractMeta(fx.contractId))._playbookRedlineStatus}`)

  const { status, meta } = await waitForRun(fx.contractId)
  check('the run completes', status === 'DONE', `final status=${status}`)

  staged = meta._playbookRedline
  check('a staged markup was produced', !!staged && Array.isArray(staged.proposals),
    `staged=${JSON.stringify(staged ?? null).slice(0, 160)}`)

  check(
    'NO new version was written — the markup is staged, not applied',
    (await versionCount(fx.contractId)) === versionsBefore,
    'writing to the contract before a human reviews is an unreviewed edit, not a redline',
  )
}

// ─── 2. The staged set matches what the checker found ───────────────────────

section('2. Every deviation is staged, and only the deviations')
{
  const proposals = staged?.proposals ?? []
  const stagedIds = new Set(proposals.map(p => p.clauseId))

  for (const f of FIXTURES.filter(x => x.deviates)) {
    check(`${f.clauseType} (deviating) was staged`,
      stagedIds.has(fx.byType[f.clauseType]),
      'a deviation the checker found but the pipeline skipped is invisible to the reviewer')
  }
  const compliant = FIXTURES.find(x => !x.deviates)
  check(`${compliant.clauseType} (compliant) was NOT staged`,
    !stagedIds.has(fx.byType[compliant.clauseType]),
    'rewriting a compliant clause means the pipeline is not reading the checker')

  check('the summary reports how many clauses deviated',
    typeof staged?.deviationCount === 'number' && staged.deviationCount >= 2,
    `deviationCount=${staged?.deviationCount}`)
  check('each staged proposal carries the text a reviewer needs',
    proposals.every(p => p.clauseId && p.originalText && p.proposedText),
    JSON.stringify(proposals[0] ?? null).slice(0, 180))
}

// ─── 3. Accepting a subset applies exactly that subset ──────────────────────

section('3. Accepting some changes applies those and only those')
{
  const proposals = staged?.proposals ?? []
  const accept = proposals.find(p => p.clauseId === fx.byType.limitation_of_liability)
  const reject = proposals.find(p => p.clauseId === fx.byType.governing_law)
  const before = await versionCount(fx.contractId)

  const res = await api(admin.accessToken, 'POST', `/contracts/${fx.contractId}/redline-against-playbook/apply`, {
    acceptedClauseIds: [accept?.clauseId].filter(Boolean),
  })
  check('the accept call succeeds', res.status === 200,
    `status=${res.status} ${JSON.stringify(res.body).slice(0, 180)}`)

  if (res.status === 200) {
    check('exactly one new version was created for the accepted subset',
      (await versionCount(fx.contractId)) === before + 1,
      `${before} → ${await versionCount(fx.contractId)}`)

    const c = await prisma.contract.findUnique({ where: { id: fx.contractId }, select: { currentVersionId: true } })
    const body = await prisma.contractVersion.findUnique({
      where: { id: c.currentVersionId }, select: { plainText: true },
    })
    check('the accepted clause was rewritten',
      !body.plainText.includes(FIXTURES[0].content),
      'the liability clause should no longer say "unlimited liability"')
    check('the REJECTED clause is untouched',
      body.plainText.includes(FIXTURES[1].content),
      'a change the reviewer did not accept must not reach the document')
    check('the compliant clause is untouched',
      body.plainText.includes(FIXTURES[2].content),
      'nothing staged it, so nothing should have changed it')
  }
}

// ─── 4. The run survives a reload ───────────────────────────────────────────

section('4. State is durable — a reload mid-run recovers')
{
  // Everything the page needs is in contract.metadata, which is exactly why a
  // reload is safe. Re-read it fresh, as a new page load would.
  const meta = await contractMeta(fx.contractId)
  check('the staged markup is still readable after the run',
    !!meta._playbookRedline,
    'holding it in memory would lose the run whenever the user navigates away')
  check('the status says the run finished',
    meta._playbookRedlineStatus === 'DONE' || meta._playbookRedlineStatus === 'APPLIED',
    `status=${meta._playbookRedlineStatus}`)
}

// ─── 5. The existing auto-review result is finally readable ─────────────────

section('5. metadata._playbookReview is exposed, not written into the void')
{
  // The 647e3e7 worker has been writing this since it shipped; a repo-wide grep
  // found no reader. A pipeline that ignores it re-does work the org paid for.
  const res = await api(admin.accessToken, 'GET', `/contracts/${fx.contractId}/playbook-review`)
  check('there is a route to read the stored playbook review',
    res.status === 200 || res.status === 404,
    `status=${res.status} — a 501/500 means the route exists but is broken`)
  if (res.status === 200) {
    check('it returns a shape the UI can render',
      typeof res.body === 'object' && res.body !== null,
      JSON.stringify(res.body).slice(0, 140))
  } else {
    check('no stored review for this fixture (it was never queued) — reported as 404, not an error',
      res.status === 404, `status=${res.status}`)
  }
}

// ─── 6. Version churn between staging and accepting ─────────────────────────

section('6. Accepting still works after the editor has saved')
{
  // Opening a contract makes the editor autosave, and autosave creates
  // versions WITHOUT re-running clause extraction. So by the time a reviewer
  // presses Apply — minutes after staging — the clause ids they were shown can
  // belong to an older version and the current one can have no clause rows at
  // all. Observed in the browser: two "Edited in-place" versions appeared just
  // from loading the page, and the apply failed with "none of the requested
  // clauses could be located" while the clauses were visible on screen.
  const churn = await seed()
  const start = await api(admin.accessToken, 'POST', `/contracts/${churn.contractId}/redline-against-playbook`, {})
  if (start.status !== 202) {
    check('churn probe could start a run', false, `status=${start.status}`)
  } else {
    const { status, meta } = await waitForRun(churn.contractId)
    const proposals = (meta._playbookRedline?.proposals ?? []).filter(p => p.proposedText)
    check('churn probe staged something to accept', status === 'DONE' && proposals.length > 0,
      `status=${status} proposals=${proposals.length}`)

    if (proposals.length > 0) {
      // Simulate exactly what the editor does: a new version carrying the same
      // body, with NO clause rows copied onto it.
      const cur = await prisma.contractVersion.findUnique({
        where: { id: (await prisma.contract.findUnique({
          where: { id: churn.contractId }, select: { currentVersionId: true },
        })).currentVersionId },
        select: { htmlContent: true, plainText: true, versionNumber: true },
      })
      const autosaved = await prisma.contractVersion.create({
        data: {
          contractId: churn.contractId, versionNumber: cur.versionNumber + 1,
          htmlContent: cur.htmlContent, plainText: cur.plainText,
          changeNote: 'Edited in-place', createdById: userId,
        },
        select: { id: true },
      })
      await prisma.contract.update({
        where: { id: churn.contractId }, data: { currentVersionId: autosaved.id },
      })

      const res = await api(admin.accessToken, 'POST',
        `/contracts/${churn.contractId}/redline-against-playbook/apply`,
        { acceptedClauseIds: [proposals[0].clauseId] })

      check(
        'the accepted change still applies after an autosave version',
        res.status === 200,
        `status=${res.status} ${JSON.stringify(res.body).slice(0, 160)} — ` +
        'a 409 here means a reviewer who simply opened the document cannot accept anything',
      )
      if (res.status === 200) {
        const c = await prisma.contract.findUnique({
          where: { id: churn.contractId }, select: { currentVersionId: true },
        })
        const body = await prisma.contractVersion.findUnique({
          where: { id: c.currentVersionId }, select: { plainText: true },
        })
        check('and the clause actually changed',
          !body.plainText.includes(FIXTURES[0].content),
          'resolving the clause is not enough — the splice has to land')
      }
    }
  }
}

await purge()
await prisma.$disconnect()
report('P3 redline pipeline')
