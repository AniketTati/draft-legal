#!/usr/bin/env node
/**
 * Phase 1 — proposing rewrites for a whole document has to be one round-trip,
 * not one per clause.
 *
 * Today `proposeClauseAlternatives` handles exactly one clause and asks for
 * three aggression variants, of which a batch pipeline keeps one. So a
 * 12-deviation contract costs 12 reasoning-tier calls producing 36 variants to
 * throw 24 away — and nothing bounds the fan-out, which is the same mistake
 * Phase 0 found in the judge branch.
 *
 * Three things this asserts, in order of how badly they'd hurt:
 *
 *   1. GROUNDING. Each clause must be rewritten against ITS OWN playbook
 *      position. A batch that hands the model twelve clauses and one playbook
 *      produces twelve plausible rewrites aimed at the wrong targets — and
 *      nothing in the output would say so.
 *   2. PARTIAL FAILURE. One clause the model chokes on must not discard the
 *      other eleven. A dropped batch is a redline that silently misses
 *      deviations, which is the failure mode this whole feature exists to fix.
 *   3. COST. One HTTP call, one variant per clause, bounded concurrency.
 *
 * Run BEFORE the fix: sections 1–3 fail (no batch endpoint exists).
 * Run AFTER:          all pass.
 */
import { login, internal, check, report, section, db, AGENTS, INTERNAL_SECRET } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id

const TITLE = 'P1 batch propose probe'

// Two clause types with DIFFERENT playbook positions. If the batch grounds
// every clause in one shared playbook, the liability rewrite will talk about
// governing law or vice versa — which is the failure we most need to catch.
const FIXTURES = [
  {
    clauseType: 'limitation_of_liability',
    categoryName: 'Limitation of Liability',
    // A distinctive token that can only come from THIS position.
    preferred: 'Liability shall be capped at two times (2x) the fees paid in the preceding twelve months.',
    // Accepted phrasings of the SAME position. Demanding one literal token
    // makes the check fail on ordinary model variance — "two times" is as
    // faithful to the playbook as "2x" — while still catching a rewrite that
    // ignored the position entirely (it would say none of these).
    markers: ['2x', 'two times', 'twice'],
    content: 'The parties accept unlimited liability for all direct and indirect losses.',
  },
  {
    clauseType: 'governing_law',
    categoryName: 'Governing Law',
    preferred: 'This Agreement shall be governed by the laws of the State of Delaware.',
    markers: ['delaware'],
    content: 'This Agreement shall be governed by the laws of the State of New York.',
  },
]

async function purge() {
  const stale = await prisma.contract.findMany({ where: { orgId, title: TITLE }, select: { id: true } })
  if (stale.length === 0) return
  const ids = stale.map(c => c.id)
  await prisma.contract.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } })
  const versions = await prisma.contractVersion.findMany({ where: { contractId: { in: ids } }, select: { id: true } })
  const vIds = versions.map(v => v.id)
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
  const version = await prisma.contractVersion.create({
    data: {
      contractId: contract.id, versionNumber: 1,
      htmlContent: '<p>seed</p>', plainText: 'seed', createdById: userId,
    },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

  const clauseIds = []
  for (const [i, f] of FIXTURES.entries()) {
    let cat = await prisma.clauseCategory.findFirst({ where: { orgId, name: f.categoryName } })
    cat ??= await prisma.clauseCategory.create({
      data: { org: { connect: { id: orgId } }, name: f.categoryName },
    })
    await prisma.playbookPosition.deleteMany({ where: { orgId, clauseCategoryId: cat.id } })
    await prisma.playbookPosition.create({
      data: {
        org: { connect: { id: orgId } },
        clauseCategory: { connect: { id: cat.id } },
        createdById: userId,
        positionType: 'preferred',
        content: f.preferred,
      },
    })
    // A fallback position too — the rewriter should see more than "preferred",
    // because aiming at "acceptable" when "preferred" is unreachable is what a
    // negotiator actually does.
    await prisma.playbookPosition.create({
      data: {
        org: { connect: { id: orgId } },
        clauseCategory: { connect: { id: cat.id } },
        createdById: userId,
        positionType: 'fallback',
        content: `Fallback for ${f.categoryName}: accept a narrower carve-out if pressed.`,
      },
    })
    const cl = await prisma.contractClause.create({
      data: {
        versionId: version.id, clauseType: f.clauseType,
        content: f.content, sectionRef: `Section ${i + 1}.1`, sortOrder: i,
      },
      select: { id: true },
    })
    clauseIds.push(cl.id)
  }
  return { contractId: contract.id, clauseIds }
}

const fx = await seed()

// ─── 1. A batch endpoint exists and grounds each clause separately ──────────

section('1. One call rewrites many clauses, each against its own playbook')
let batch
{
  const res = await internal('/tools/redline_propose_batch', {
    orgId,
    contractId: fx.contractId,
    clauseIds: fx.clauseIds,
    aggression: 'moderate',
  }, orgId)

  check(
    'a batch endpoint exists',
    res.status === 200,
    res.status === 404
      ? '404 — no batch route; a 12-deviation contract still costs 12 reasoning calls'
      : `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
  )

  if (res.status === 200) {
    batch = res.body
    const props = batch.proposals ?? []
    check('one proposal per requested clause', props.length === fx.clauseIds.length,
      `${props.length} proposals for ${fx.clauseIds.length} clauses`)
    check('every proposal names the clause it belongs to',
      props.every(p => fx.clauseIds.includes(p.clauseId)),
      `ids=${props.map(p => p.clauseId).join(',').slice(0, 80)}`)

    // The real test: each rewrite must reflect ITS OWN position, not a
    // neighbour's. A shared-playbook batch scores plausibly and aims wrong.
    for (const [i, f] of FIXTURES.entries()) {
      const p = props.find(x => x.clauseId === fx.clauseIds[i])
      const text = `${p?.proposedText ?? ''} ${p?.rationale ?? ''}`.toLowerCase()
      check(
        `${f.clauseType} was rewritten against its own position`,
        f.markers.some(m => text.includes(m)),
        `expected one of [${f.markers.join(', ')}]; got: ${(p?.proposedText ?? '(none)').slice(0, 140)}`,
      )
      const others = FIXTURES.filter((_, j) => j !== i)
      const leaked = others.filter(o => o.markers.some(m => text.includes(m)))
      check(
        `${f.clauseType} did not borrow another clause's playbook`,
        leaked.length === 0,
        `leaked from: ${leaked.map(o => o.clauseType).join(',') || 'none'}`,
      )
    }

    check(
      'one variant per clause, not three',
      props.every(p => typeof p.proposedText === 'string' && !Array.isArray(p.variants)),
      'batching three aggressions triples cost for output the pipeline discards',
    )
  }
}

// ─── 2. Partial failure degrades per clause ─────────────────────────────────

section('2. One bad clause does not discard the batch')
{
  // An empty clause cannot be rewritten. The batch must return the others and
  // mark this one, rather than 4xx-ing the whole request.
  const empty = await prisma.contractClause.create({
    data: {
      versionId: (await prisma.contract.findUnique({
        where: { id: fx.contractId }, select: { currentVersionId: true },
      })).currentVersionId,
      clauseType: 'unrewritable', content: '   ', sectionRef: 'Section 99', sortOrder: 99,
    },
    select: { id: true },
  })

  const res = await internal('/tools/redline_propose_batch', {
    orgId, contractId: fx.contractId,
    clauseIds: [...fx.clauseIds, empty.id],
    aggression: 'moderate',
  }, orgId)

  if (res.status !== 200) {
    check('batch survives an unrewritable clause', false,
      `status=${res.status} — the whole batch was rejected for one bad clause`)
  } else {
    const props = res.body.proposals ?? []
    check('the good clauses still came back',
      fx.clauseIds.every(id => props.some(p => p.clauseId === id && p.proposedText)),
      `${props.filter(p => p.proposedText).length} usable of ${props.length}`)
    const bad = props.find(p => p.clauseId === empty.id)
    check('the failing clause is reported, not silently omitted',
      !!bad && (bad.error || bad.skipped),
      `entry=${JSON.stringify(bad ?? null).slice(0, 140)} — omitting it makes a missed deviation look like a clean clause`)
  }
  await prisma.contractClause.delete({ where: { id: empty.id } }).catch(() => {})
}

// ─── 3. Cost and fan-out ────────────────────────────────────────────────────

section('3. The batch is bounded, in calls and in concurrency')
{
  const { readFileSync } = await import('node:fs')
  const REPO = new URL('../../', import.meta.url).pathname
  const py = readFileSync(REPO + 'apps/agents/app/routes/assist.py', 'utf8')
  const node = readFileSync(REPO + 'apps/api/src/lib/clause-propose.ts', 'utf8')

  check(
    'the Python service exposes a batch route',
    /redline_propose_batch/.test(py),
    'without it the Node side can only loop, which is what we are removing',
  )
  check(
    'the fan-out is bounded, not an unbounded Promise.all',
    /CONCURRENCY|concurrency/i.test(node) || /semaphore|Semaphore|gather.*limit/i.test(py),
    'Phase 0 found exactly this in the judge branch — 43 clauses must not open 43 model calls',
  )
  check(
    'rewrites are grounded in all position types, not only "preferred"',
    !/positionType:\s*'preferred'\s*\}/.test(node) || /positionType:\s*\{\s*in:/.test(node),
    "clause-propose loaded only positionType:'preferred', so fallback language never reached the rewriter",
  )
}

await purge()
await prisma.$disconnect()
report('P1 batch clause proposal')
