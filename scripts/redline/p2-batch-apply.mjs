#!/usr/bin/env node
/**
 * Phase 2 — applying a whole document's redline must land as ONE version, and
 * must never splice the wrong span.
 *
 * `applyClauseProposal` creates a new ContractVersion per call, so a
 * 12-deviation redline would produce 12 versions, 12 `currentVersionId` flips,
 * 12 audit events, and an undo that has to unwind a chain in order.
 *
 * Looping it is also unsafe, and the reason is subtle. `findNormalizedSpan`
 * deliberately refuses when the clause text appears more than once — picking
 * the first occurrence would edit an arbitrary clause. But each apply rewrites
 * the document, so an earlier replacement can *introduce* a second copy of a
 * later clause's language. Splice #1 succeeds; splice #2 then sees two
 * occurrences and refuses. The redline silently drops a change it had already
 * shown the user as accepted.
 *
 * So the batch must compute every span against ONE immutable body before any
 * mutation, then apply them back-to-front by offset.
 *
 * Run BEFORE: no batch apply exists — sections 1-4 fail.
 * Run AFTER:  all pass.
 */
import { login, internal, check, report, section, db } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id

const TITLE = 'P2 batch apply probe'

// Eight distinct clauses. Deliberately worded so each is unambiguous on its
// own, so any ambiguity we observe is one the APPLY introduced.
const CLAUSES = [
  ['limitation_of_liability', 'The parties accept unlimited liability for all direct and indirect losses under this Agreement.'],
  ['governing_law',           'This Agreement shall be governed by the laws of the State of New York without regard to conflicts.'],
  ['confidentiality',         'Each party shall keep the other information confidential for a period of two years from disclosure.'],
  ['termination',             'Either party may terminate this Agreement immediately upon written notice to the other party.'],
  ['payment_terms',           'Customer shall pay all undisputed invoices within ninety (90) days of the invoice date.'],
  ['warranty',                'Provider disclaims all warranties of any kind, whether express, implied, or statutory.'],
  ['assignment',              'Neither party may assign this Agreement without the prior written consent of the other.'],
  ['notices',                 'All notices under this Agreement shall be delivered by certified mail to the addresses below.'],
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

/** Build a contract whose v1 body contains each clause verbatim. */
async function seed(title, clauses) {
  const contract = await prisma.contract.create({
    data: {
      org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
      title, type: 'NDA', status: 'DRAFT', analysisStatus: 'DONE',
    },
    select: { id: true },
  })
  const html = clauses.map(([, text]) => `<p>${text}</p>`).join('\n')
  const plain = clauses.map(([, text]) => text).join('\n\n')
  const version = await prisma.contractVersion.create({
    data: { contractId: contract.id, versionNumber: 1, htmlContent: html, plainText: plain, createdById: userId },
    select: { id: true },
  })
  await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } })

  const ids = []
  for (const [i, [clauseType, text]] of clauses.entries()) {
    const cl = await prisma.contractClause.create({
      data: { versionId: version.id, clauseType, content: text, sectionRef: `Section ${i + 1}`, sortOrder: i },
      select: { id: true },
    })
    ids.push(cl.id)
  }
  return { contractId: contract.id, versionId: version.id, clauseIds: ids }
}

async function currentBody(contractId) {
  const c = await prisma.contract.findUnique({ where: { id: contractId }, select: { currentVersionId: true } })
  return prisma.contractVersion.findUnique({
    where: { id: c.currentVersionId },
    select: { id: true, versionNumber: true, htmlContent: true, plainText: true, metadata: true },
  })
}

const versionCount = contractId =>
  prisma.contractVersion.count({ where: { contractId } })

await purge()

// ─── 1. Eight clauses, ONE version ──────────────────────────────────────────

section('1. A batch apply lands as a single version')
let fx
{
  fx = await seed(TITLE, CLAUSES)
  const before = await versionCount(fx.contractId)

  const res = await internal('/tools/redline_apply_batch', {
    orgId, userId,
    contractId: fx.contractId,
    changes: fx.clauseIds.map((clauseId, i) => ({
      clauseId,
      proposedText: `REVISED CLAUSE ${i + 1}: the parties agree to the amended terms set out in this section.`,
    })),
    rationale: 'P2 probe',
  }, orgId)

  check('a batch apply endpoint exists', res.status === 200,
    res.status === 404
      ? '404 — no batch apply; 8 clauses would mean 8 versions and a chained undo'
      : `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)

  if (res.status === 200) {
    const after = await versionCount(fx.contractId)
    check('exactly ONE new version was created, not eight',
      after === before + 1, `${before} → ${after} versions`)

    const body = await currentBody(fx.contractId)
    const missing = CLAUSES
      .map((_, i) => `REVISED CLAUSE ${i + 1}`)
      .filter(marker => !body.htmlContent.includes(marker))
    check('every clause was replaced', missing.length === 0,
      missing.length ? `not applied: ${missing.join(', ')}` : 'all 8 present')

    const originalsLeft = CLAUSES.filter(([, t]) => body.htmlContent.includes(t))
    check('no original clause text survived', originalsLeft.length === 0,
      originalsLeft.map(([t]) => t).join(', ') || 'none')

    check('html and plainText agree on what happened',
      CLAUSES.every((_, i) => body.plainText.includes(`REVISED CLAUSE ${i + 1}`)),
      'the two stored representations must not describe different agreements')

    check('the response reports per-clause outcomes',
      Array.isArray(res.body.applied) && res.body.applied.length === CLAUSES.length,
      `applied=${res.body.applied?.length}`)
  }
}

// ─── 2. metadata records every clause, not just one ─────────────────────────

section('2. The version records all of its changes')
{
  const body = await currentBody(fx.contractId)
  const redline = body?.metadata?.redline
  check('metadata.redline holds an entry per clause',
    Array.isArray(redline) && redline.length === CLAUSES.length,
    `redline=${Array.isArray(redline) ? `array(${redline.length})` : typeof redline} — a single object can only record one clause of a batch`)
  check('each entry carries its source clause and original text',
    Array.isArray(redline) && redline.every(r => r.sourceClauseId && r.originalText),
    'without the original text a future OOXML serializer cannot emit tracked changes')
}

// ─── 3. Undo returns to the single pre-batch version ────────────────────────

section('3. Undo reverses the whole batch in one step')
{
  const beforeUndo = await currentBody(fx.contractId)
  const res = await internal('/tools/redline_apply_batch/undo', {
    orgId, userId, contractId: fx.contractId, versionId: beforeUndo.id,
  }, orgId)

  if (res.status !== 200) {
    check('a batch undo exists', false, `status=${res.status} ${JSON.stringify(res.body).slice(0, 160)}`)
  } else {
    const after = await currentBody(fx.contractId)
    check('undo restored the pre-batch version',
      after.id === fx.versionId,
      `current=${after.versionNumber} expected v1`)
    check('the original clause text is back',
      CLAUSES.every(([, t]) => after.plainText.includes(t)),
      'a batch undo must not leave the document half-reverted')
  }
}

// ─── 4. The ambiguity trap ──────────────────────────────────────────────────

section('4. A replacement that duplicates a later clause cannot mis-splice')
{
  // Clause A's replacement text CONTAINS clause B verbatim. Applied
  // sequentially, splice A succeeds and then clause B appears twice, so
  // findNormalizedSpan refuses and B is silently dropped. Computing both spans
  // against the original body first avoids that entirely.
  const B_TEXT = 'This Agreement shall be governed by the laws of the State of New York without regard to conflicts.'
  const trap = await seed(`${TITLE} — ambiguity`, [
    ['limitation_of_liability', 'The parties accept unlimited liability for all direct and indirect losses under this Agreement.'],
    ['governing_law',           B_TEXT],
  ])

  const res = await internal('/tools/redline_apply_batch', {
    orgId, userId,
    contractId: trap.contractId,
    changes: [
      // A's replacement embeds B's exact wording.
      { clauseId: trap.clauseIds[0], proposedText: `Liability is capped at 2x fees. ${B_TEXT}` },
      { clauseId: trap.clauseIds[1], proposedText: 'This Agreement shall be governed by the laws of the State of Delaware.' },
    ],
    rationale: 'P2 ambiguity probe',
  }, orgId)

  if (res.status !== 200) {
    check('the ambiguity case still applies cleanly', false,
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)
  } else {
    const body = await currentBody(trap.contractId)
    check('both clauses were applied despite the overlap',
      (res.body.applied ?? []).filter(a => a.spliced).length === 2,
      `applied=${JSON.stringify(res.body.applied ?? []).slice(0, 200)}`)
    check('the governing-law clause became Delaware, not a duplicate of New York',
      body.plainText.includes('State of Delaware'),
      `body: ${body.plainText.slice(0, 200)}`)
    check('clause A kept the New York sentence it was given',
      body.plainText.includes(`Liability is capped at 2x fees. ${B_TEXT}`),
      'the embedded copy belongs to A and must survive verbatim')
  }
}

// ─── 5. The single-clause path inherits the guard ───────────────────────────

section('5. A duplicated clause refuses instead of editing an arbitrary copy')
{
  // The ambiguity guard now covers the exact and escaped tiers too, so this
  // changes SINGLE-clause behaviour, not just the batch. Contracts legitimately
  // repeat an obligation in two sections; before, the splice silently took the
  // first copy. It must now refuse with the structured code the review drawer
  // already renders (with its "add as an amendment instead" escape hatch).
  const DUP = 'Each party shall keep the other information confidential for two years from disclosure.'
  const dup = await seed(`${TITLE} — duplicate`, [['confidentiality', DUP]])
  // Put a second identical copy in the body.
  await prisma.contractVersion.update({
    where: { id: dup.versionId },
    data: {
      htmlContent: `<p>${DUP}</p>\n<p>Other terms.</p>\n<p>${DUP}</p>`,
      plainText:   `${DUP}\n\nOther terms.\n\n${DUP}`,
    },
  })

  const before = await versionCount(dup.contractId)
  const res = await internal('/tools/redline_apply', {
    orgId, userId, contractId: dup.contractId,
    clauseId: dup.clauseIds[0],
    proposedText: 'Confidentiality survives for five years.',
  }, orgId)

  check('a duplicated clause is refused, not silently mis-spliced',
    res.status === 409, `status=${res.status} — 200 here means an arbitrary copy was edited`)
  check('the refusal uses the code the drawer already handles',
    res.body?.code === 'CLAUSE_TEXT_NOT_FOUND', `code=${res.body?.code}`)
  check('no version was created by the refusal',
    (await versionCount(dup.contractId)) === before, 'a refused apply must leave the document alone')
}

await purge()
await prisma.$disconnect()
report('P2 multi-clause apply')
