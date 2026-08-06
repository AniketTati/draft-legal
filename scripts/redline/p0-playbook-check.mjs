#!/usr/bin/env node
/**
 * Phase 0 — the playbook checker has to tell the truth before a redlining
 * pipeline can be built on it.
 *
 * `playbook_check` is the input to the whole feature: it decides which clauses
 * deviate, and therefore which clauses get rewritten. Every defect below makes
 * it under-report — a contract looks cleaner than it is, and the redline that
 * follows silently skips real problems. That is worse than no feature.
 *
 * Six defects, each with its own section:
 *   1. checks[] carries no clause id, so nothing can chain into a rewrite
 *      (redline_propose and redline_apply both key on clauseId).
 *   2. No document-level rollup, and `totalClauses` reports the CAPPED count,
 *      so a caller can't tell a 40-clause contract was cut to 30.
 *   3. A clause whose category has no positions is dropped silently — absent
 *      from checks[] AND from unmapped[]. Half-covered reads as fully covered.
 *   4. `critical` is missing from SEVERITY_ORDER, so indexOf returns -1 and
 *      any later `low` violation overwrites it. Silent severity inversion.
 *   5. Three different clauseType→category matchers disagree, so a hyphenated
 *      type resolves in the checker and misses in the rewriter.
 *   6. `passed` is a COUNT, not a boolean — trivially truthy.
 *
 * Run BEFORE the fix: sections 1-6 fail. Run AFTER: all pass.
 */
import { login, internal, check, report, section, db } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id

const TITLE = 'P0 playbook probe'

// ─── Fixture ─────────────────────────────────────────────────────────────────
// One contract exercising every defect at once:
//   - `limitation_of_liability` → category WITH positions and a `critical`
//     rule followed by a `low` one (severity inversion)
//   - `indemnification`         → category WITH NO positions (silent drop)
//   - `governing-law`           → HYPHENATED type, category exists (matcher skew)
//   - 40 filler clauses         → exceeds the maxClauses cap (invisible truncation)

async function seed() {
  await prisma.contract.deleteMany({ where: { orgId, title: TITLE } }).catch(() => {})

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
  await prisma.contract.update({
    where: { id: contract.id }, data: { currentVersionId: version.id },
  })

  const category = async (name) => {
    const found = await prisma.clauseCategory.findFirst({ where: { orgId, name } })
    return found ?? prisma.clauseCategory.create({ data: { org: { connect: { id: orgId } }, name } })
  }
  const liability = await category('Limitation of Liability')
  const governing = await category('Governing Law')
  // A category this probe fully controls, guaranteed to have ZERO positions.
  // The org seed ships positions for the common categories (Indemnification
  // already has four), so reusing one of those would make the silent-drop
  // assertion pass without ever exercising the case.
  const orphan = await category('P0 Probe — Category With No Positions')
  await prisma.playbookPosition.deleteMany({ where: { orgId, clauseCategoryId: orphan.id } }).catch(() => {})

  // Positions ONLY for liability and governing law. Indemnification gets a
  // category but no positions — the silent-drop case.
  await prisma.playbookPosition.deleteMany({
    where: { orgId, clauseCategoryId: { in: [liability.id, governing.id] } },
  }).catch(() => {})

  await prisma.playbookPosition.create({
    data: {
      org: { connect: { id: orgId } },
      clauseCategory: { connect: { id: liability.id } },
      createdById: userId,
      positionType: 'preferred',
      content: 'Liability shall be capped at two times the fees paid.',
      rules: {
        // Ordering matters: `critical` first, `low` second. If the severity
        // rollup is order-dependent (it is), the low one wins and the
        // critical breach is reported as trivial.
        must_have: [
          { id: 'cap-present', description: 'A liability cap must be present',
            check: 'contains', value: 'capped', severity: 'critical' },
          { id: 'mutual', description: 'Cap should be mutual',
            check: 'contains', value: 'mutual', severity: 'low' },
        ],
      },
    },
  })
  await prisma.playbookPosition.create({
    data: {
      org: { connect: { id: orgId } },
      clauseCategory: { connect: { id: governing.id } },
      createdById: userId,
      positionType: 'preferred',
      content: 'Governed by the laws of Delaware.',
      rules: { must_have: [{ id: 'delaware', description: 'Delaware law',
        check: 'contains', value: 'delaware', severity: 'high' }] },
    },
  })

  const clauses = [
    // Neither rule matches → the critical must_have fails.
    { clauseType: 'limitation_of_liability', sectionRef: 'Section 5.2',
      content: 'The parties accept unlimited liability for all direct and indirect losses arising under this Agreement.' },
    { clauseType: 'p0 probe — category with no positions', sectionRef: 'Section 6.1',
      content: 'Each party shall indemnify the other against third-party claims arising from its own negligence.' },
    // Hyphenated on purpose — normalisedKey handles it, other matchers do not.
    { clauseType: 'governing-law', sectionRef: 'Section 12.1',
      content: 'This Agreement shall be governed by the laws of the State of New York.' },
  ]
  for (let i = 0; i < 40; i++) {
    clauses.push({
      clauseType: `filler_clause_${i}`, sectionRef: `Section ${20 + i}`,
      content: `Filler clause ${i}: the parties agree to the terms set out in this section in full.`,
    })
  }
  await prisma.contractClause.createMany({
    data: clauses.map((c, i) => ({ ...c, versionId: version.id, sortOrder: i })),
  })

  return { contractId: contract.id, versionId: version.id, totalClauses: clauses.length }
}

const fx = await seed()
const findCheck = (body, type) => (body?.checks ?? []).find(c => c.clauseType === type)

// Ask to cover the whole document. `maxClauses` is capped at 30 by the schema
// today, and the cap is a hard 400 rather than a clamp — so a 41-clause
// contract cannot be checked at all, in one call or otherwise. That is the
// defect; assert it here, then fall back so the remaining sections can run.
section('0. A whole document can be checked')
let body
{
  const full = await internal('/tools/playbook_check', {
    orgId, contractId: fx.contractId, maxClauses: fx.totalClauses,
  }, orgId)
  check(
    `all ${fx.totalClauses} clauses can be requested in one call`,
    full.status === 200,
    full.status === 400
      ? `400 — maxClauses is hard-capped, so a document this size cannot be fully checked: ${JSON.stringify(full.body?.issues ?? full.body).slice(0, 140)}`
      : `status=${full.status}`,
  )

  const usable = full.status === 200
    ? full
    : await internal('/tools/playbook_check', { orgId, contractId: fx.contractId, maxClauses: 30 }, orgId)

  if (usable.status !== 200) {
    check('playbook_check responds at all', false, `status=${usable.status} ${JSON.stringify(usable.body).slice(0, 160)}`)
    await prisma.$disconnect()
    report('P0 playbook checker integrity')
    process.exit(1)
  }
  body = usable.body
}

// ─── 1. Chaining ─────────────────────────────────────────────────────────────

section('1. Output can be chained into a rewrite')
{
  const liability = findCheck(body, 'limitation_of_liability')
  check('the liability clause is reported at all', !!liability,
    `checks=${(body.checks ?? []).map(c => c.clauseType).join(',').slice(0, 120)}`)
  check(
    'each check carries a clauseId',
    !!liability?.clauseId,
    'redline_propose and redline_apply both key on clauseId — without it nothing can chain',
  )
  if (liability?.clauseId) {
    const row = await prisma.contractClause.findUnique({
      where: { id: liability.clauseId }, select: { versionId: true, clauseType: true },
    })
    check('the clauseId resolves to a real clause on this version',
      row?.versionId === fx.versionId && row?.clauseType === 'limitation_of_liability',
      `resolved=${row?.clauseType ?? 'null'}`)
  }
}

// ─── 2. Rollup + truncation ─────────────────────────────────────────────────

section('2. The caller can see the document-level picture, and any truncation')
{
  check('a document-level worstSeverity is reported',
    body.summary?.worstSeverity !== undefined,
    `summary=${JSON.stringify(body.summary ?? null).slice(0, 140)}`)
  check('a deviation count is reported', typeof body.summary?.deviationCount === 'number')
  // checks[] holds only the clauses that could be EVALUATED, so its length is
  // not the coverage figure — the question is whether every clause is
  // accounted for somewhere, and whether any were cut off entirely.
  const s = body.summary ?? {}
  const accountedFor = (s.checkedClauses ?? 0) + (s.uncoveredClauses ?? 0)
  check(
    'every clause is accounted for as checked or uncovered',
    accountedFor === fx.totalClauses,
    `checked=${s.checkedClauses} + uncovered=${s.uncoveredClauses} = ${accountedFor}, total=${fx.totalClauses}`,
  )
  check(
    'truncation is reported honestly',
    s.truncated === (fx.totalClauses > accountedFor),
    `truncated=${s.truncated} with ${accountedFor}/${fx.totalClauses} examined`,
  )
  check(
    'totalClauses reports the REAL count, not the capped one',
    body.contract?.totalClauses === fx.totalClauses,
    `reported=${body.contract?.totalClauses} actual=${fx.totalClauses}`,
  )
}

// ─── 3. Nothing disappears ──────────────────────────────────────────────────

section('3. No clause is dropped without saying so')
{
  const ORPHAN = 'p0 probe — category with no positions'
  const indem = findCheck(body, ORPHAN)
  const listedUncovered =
    (body.uncovered ?? []).some(u => (u.clauseType ?? u) === ORPHAN) ||
    (body.unmapped ?? []).includes(ORPHAN)
  check(
    'a clause whose category has no positions is accounted for',
    !!indem || listedUncovered,
    'today it is dropped from checks[] AND unmapped[] — a half-covered contract reads as fully covered',
  )
  const seen = new Set([
    ...(body.checks ?? []).map(c => c.clauseType),
    ...(body.unmapped ?? []),
    ...(body.uncovered ?? []).map(u => u.clauseType ?? u),
  ])
  const missing = ['limitation_of_liability', ORPHAN, 'governing-law']
    .filter(t => !seen.has(t))
  check('every seeded clause type is accounted for somewhere', missing.length === 0,
    missing.length ? `unaccounted: ${missing.join(', ')}` : 'all accounted for')
}

// ─── 4. Severity ────────────────────────────────────────────────────────────

section('4. A critical violation is not overwritten by a trivial one')
{
  const liability = findCheck(body, 'limitation_of_liability')
  const failedRules = (liability?.violations ?? []).filter(v => v.passed === false)
  check('the failing rules are reported', failedRules.length >= 1,
    `${failedRules.length} failed of ${(liability?.violations ?? []).length}`)
  check(
    'worstSeverity reflects the critical rule, not the low one',
    liability?.worstSeverity === 'critical' || liability?.worstSeverity === 'walkaway',
    `worstSeverity=${liability?.worstSeverity} — SEVERITY_ORDER has no 'critical', so indexOf is -1 and any later 'low' wins`,
  )
}

// ─── 5. Matcher consistency ─────────────────────────────────────────────────

section('5. The checker and the rewriter agree on clauseType→category')
{
  const gov = findCheck(body, 'governing-law')
  check('the hyphenated clause type matches a category in the checker',
    !!gov?.category, `category=${gov?.category?.name ?? 'none'}`)

  if (gov?.clauseId) {
    // The rewriter must resolve the SAME category. It uses a different
    // normalisation today (underscores only), so a hyphenated type misses and
    // the rewrite loses its playbook grounding without any error.
    const proposal = await internal('/tools/redline_propose', {
      orgId, contractId: fx.contractId, clauseId: gov.clauseId,
    }, orgId)
    if (proposal.status === 200) {
      check(
        'the rewriter resolves the same category (hasPlaybook)',
        proposal.body?.hasPlaybook === true,
        `hasPlaybook=${proposal.body?.hasPlaybook} category=${JSON.stringify(proposal.body?.category)} — ` +
        'a false here means the rewrite ran with no playbook grounding and said nothing',
      )
    } else {
      check('redline_propose responded', false, `status=${proposal.status}`)
    }
  } else {
    check('cannot test matcher skew without a clauseId', false, 'blocked by section 1')
  }
}

// ─── 6. Field semantics ─────────────────────────────────────────────────────

section('6. Result fields mean what their names suggest')
{
  const liability = findCheck(body, 'limitation_of_liability')
  check(
    '`passed` is a boolean verdict, not a count of passing rules',
    typeof liability?.passed === 'boolean',
    `passed=${JSON.stringify(liability?.passed)} (${typeof liability?.passed}) — ` +
    'a count is truthy for one passing rule, so `if (check.passed)` reads backwards',
  )
}

await prisma.$disconnect()
report('P0 playbook checker integrity')
