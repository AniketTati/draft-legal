#!/usr/bin/env node
/**
 * W0-2 — applying a clause proposal must do what the user confirmed, or say
 * plainly that it couldn't.
 *
 * Three defects in lib/clause-apply.ts, reachable from both callers (the
 * review drawer's POST /contracts/:id/clauses/:clauseId/apply and the agent's
 * redline_apply):
 *
 *   (a) On a match miss the proposed text is APPENDED as an amendment block
 *       instead of replacing the clause. The user confirmed a replacement and
 *       gets a different legal instrument, with ok:true.
 *   (b) plainText runs its own match with its own append fallback, and its
 *       outcome never feeds `spliced` — so the flag can report a document
 *       state that does not exist, and the two stored representations of the
 *       same contract diverge.
 *   (c) The exact-match branch splices proposedText UNESCAPED into HTML while
 *       the other two insertion sites escape it. "fees < $50,000" corrupts the
 *       document.
 *
 * Run BEFORE the fix: checks 2, 3, 5 and 6 fail.
 * Run AFTER:          all pass.
 */
import { login, api, check, report, section, db } from './lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id

/**
 * Build a contract whose current version holds `html`/`plain`, with one clause
 * row whose `content` is `clauseText`. Returns { contractId, clauseId }.
 */
async function fixture(title, html, plain, clauseText) {
  await prisma.contract.deleteMany({ where: { orgId, title } }).catch(() => {})
  const r = await api(admin.accessToken, 'POST', '/contracts', { title, type: 'NDA' })
  if (r.status >= 300) throw new Error(`create → ${r.status} ${JSON.stringify(r.body)}`)
  const contractId = r.body.id ?? r.body.contract?.id

  const version = await prisma.contractVersion.create({
    data: {
      contractId, versionNumber: 1,
      htmlContent: html, plainText: plain,
      createdById: userId,
    },
    select: { id: true },
  })
  await prisma.contract.update({
    where: { id: contractId },
    data: { currentVersionId: version.id },
  })
  const clause = await prisma.contractClause.create({
    data: {
      versionId: version.id,
      clauseType: 'limitation_of_liability',
      content: clauseText,
      sectionRef: 'Section 5.2',
    },
    select: { id: true },
  })
  return { contractId, clauseId: clause.id }
}

/** Apply through the user-facing route (the review drawer's path). */
function apply(contractId, clauseId, proposedText, extra = {}) {
  return api(admin.accessToken, 'POST', `/contracts/${contractId}/clauses/${clauseId}/apply`, {
    proposedText, ...extra,
  })
}

async function currentBody(contractId) {
  const c = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { currentVersionId: true },
  })
  return prisma.contractVersion.findUnique({
    where: { id: c.currentVersionId },
    select: { versionNumber: true, htmlContent: true, plainText: true },
  })
}

const CLAUSE = 'Liability is capped at the fees paid in the prior twelve months.'
const PROPOSED = 'Liability is capped at two times the fees paid in the prior twelve months.'

// ─── 1. Happy path — exact match splices (true before and after) ──────────────

section('1. Exact match splices cleanly')
{
  const html = `<p>Intro.</p><p>${CLAUSE}</p><p>Tail.</p>`
  const { contractId, clauseId } = await fixture('W0-2 exact', html, `Intro.\n${CLAUSE}\nTail.`, CLAUSE)
  const res = await apply(contractId, clauseId, PROPOSED)
  const body = await currentBody(contractId)
  check('exact-match apply returns 200', res.status === 200, `got ${res.status}`)
  check('response reports spliced', res.body?.spliced === true, `spliced=${res.body?.spliced}`)
  check('clause replaced in html', body.htmlContent.includes(PROPOSED) && !body.htmlContent.includes(CLAUSE))
  check('no amendment block appended', !body.htmlContent.includes('Amendment'))
}

// ─── 2. Whitespace / entity drift — should splice, not append ─────────────────

section('2. Normalized match — reflowed HTML and &nbsp; must still splice')
{
  // Exactly the clause text, but with the reflow the editor's autosave
  // introduces: a newline mid-sentence and a non-breaking space.
  const drifted = CLAUSE.replace('capped at the fees', 'capped at\n  the&nbsp;fees')
  const html = `<p>Intro.</p><p>${drifted}</p><p>Tail.</p>`
  const { contractId, clauseId } = await fixture('W0-2 drift', html, `Intro.\n${drifted}\nTail.`, CLAUSE)
  const res = await apply(contractId, clauseId, PROPOSED)
  const body = await currentBody(contractId)
  check(
    'drifted text still splices (no amendment block)',
    res.status === 200 && !body.htmlContent.includes('Amendment'),
    `status=${res.status} spliced=${res.body?.spliced} appended=${body.htmlContent.includes('Amendment')}`,
  )
  check(
    'proposed text is present exactly once',
    (body.htmlContent.split(PROPOSED).length - 1) === 1,
    `occurrences=${body.htmlContent.split(PROPOSED).length - 1}`,
  )
}

// ─── 3. Genuine miss — must refuse, not silently append ──────────────────────

section('3. Genuine miss refuses instead of appending an amendment')
{
  const html = '<p>This document was rewritten and no longer contains that clause.</p>'
  const { contractId, clauseId } = await fixture('W0-2 miss', html, 'This document was rewritten.', CLAUSE)
  const before = await currentBody(contractId)
  const res = await apply(contractId, clauseId, PROPOSED)
  const after = await currentBody(contractId)
  check(
    'apply refuses with a 409',
    res.status === 409,
    `got ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`,
  )
  check(
    'refusal carries a machine-readable code',
    res.body?.code === 'CLAUSE_TEXT_NOT_FOUND',
    `code=${res.body?.code}`,
  )
  check(
    'no new version was created on refusal',
    after.versionNumber === before.versionNumber,
    `v${before.versionNumber} → v${after.versionNumber}`,
  )
}

// ─── 4. Explicit opt-in append still available ───────────────────────────────

section('4. Append happens only when the caller asks for it')
{
  const html = '<p>This document was rewritten and no longer contains that clause.</p>'
  const { contractId, clauseId } = await fixture('W0-2 optin', html, 'This document was rewritten.', CLAUSE)
  const res = await apply(contractId, clauseId, PROPOSED, { allowAppendFallback: true })
  const body = await currentBody(contractId)
  check('opt-in append returns 200', res.status === 200, `got ${res.status}`)
  check('response says it did NOT splice', res.body?.spliced === false, `spliced=${res.body?.spliced}`)
  check('amendment block is present', body.htmlContent.includes('Amendment'))
}

// ─── 5. HTML escaping on every insertion site ────────────────────────────────

section('5. Proposed text is escaped on every insertion path')
{
  const html = `<p>Intro.</p><p>${CLAUSE}</p>`
  const { contractId, clauseId } = await fixture('W0-2 escape', html, CLAUSE, CLAUSE)
  const risky = 'Fees < $50,000 & costs > $1,000 are excluded.'
  const res = await apply(contractId, clauseId, risky)
  const body = await currentBody(contractId)
  check('apply succeeded', res.status === 200, `got ${res.status}`)
  check(
    'raw "<" was not spliced into stored html',
    !body.htmlContent.includes('< $50,000'),
    `html contains raw "<": ${body.htmlContent.includes('< $50,000')}`,
  )
  check(
    'escaped entities are present instead',
    body.htmlContent.includes('&lt; $50,000') && body.htmlContent.includes('&amp; costs'),
  )
}

// ─── 6. html and plainText must not diverge ──────────────────────────────────

section('6. Both stored representations agree after an apply')
{
  // HTML holds the clause verbatim; plainText does NOT (it was re-extracted
  // and reflowed). Before the fix, HTML splices, plainText appends, and
  // `spliced: true` certifies a state that only half exists.
  const html = `<p>${CLAUSE}</p>`
  const { contractId, clauseId } = await fixture(
    'W0-2 divergence', html, 'Liability is capped  at the fees paid in the  prior twelve months.', CLAUSE,
  )
  const res = await apply(contractId, clauseId, PROPOSED, { allowAppendFallback: true })
  const body = await currentBody(contractId)
  const htmlHasAmendment  = body.htmlContent.includes('Amendment')
  const plainHasAmendment = body.plainText.includes('Amendment')
  check(
    'html and plainText took the same path (both spliced or both appended)',
    htmlHasAmendment === plainHasAmendment,
    `html appended=${htmlHasAmendment} plain appended=${plainHasAmendment}`,
  )
  check(
    '`spliced` reflects both bodies, not just the html one',
    res.body?.spliced === (!htmlHasAmendment && !plainHasAmendment),
    `spliced=${res.body?.spliced} htmlAppended=${htmlHasAmendment} plainAppended=${plainHasAmendment}`,
  )
}

await prisma.$disconnect()
report('W0-2 clause apply integrity')
