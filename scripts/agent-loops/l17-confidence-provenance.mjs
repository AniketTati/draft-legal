#!/usr/bin/env node
/**
 * L17 — a human verdict never destroys the extractor's confidence.
 *
 * review-queue.ts recorded a review by OVERWRITING `confidence`: verify wrote
 * 1, reject wrote 0. That destroyed the only variable a human verdict could be
 * regressed against — and irrecoverably, the moment someone clicked. "Is the
 * extractor right when it says it is confident?" was unbuildable from this
 * table, retroactively and going forward.
 *
 * It also collided with a real extractor output. review_agent.py is instructed
 * to emit confidence 1.0 for "certain absence" when a field is genuinely not in
 * the document, so 1 never distinguished AI-certain from human-verified.
 *
 * Two further destruction paths, both fixed here:
 *   - review.py PATCHes the WHOLE fieldConfidence object, so a re-extraction
 *     wiped every review a human had recorded.
 *   - re-analyse?full=true reset the column to {} outright.
 *
 * And one measurement trap: reject stamped verifiedAt/verifiedBy TOO, so it
 * would be skipped by the queue — meaning any "agreement rate" joining on
 * verifiedBy counted every rejection as an agreement.
 *
 * Run BEFORE: verify writes confidence 1 and the original value is gone.
 * Run AFTER:  the extractor's confidence survives, with the verdict beside it.
 */
import { check, report, section, api, login, db } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId

const FIELD = 'governingLaw'
const EXTRACTOR_CONFIDENCE = 0.42

let contractId = null
try {
  const contract = await prisma.contract.create({
    data: {
      orgId, title: 'L17 confidence provenance fixture', type: 'MSA', status: 'DRAFT',
      ownerId: admin.user.id, createdBy: admin.user.id,
      fieldConfidence: {
        [FIELD]:      { confidence: EXTRACTOR_CONFIDENCE, quote: 'Governed by the laws of Delaware.', section: '12.1' },
        'paymentTerms': { confidence: 0.31, quote: 'Net 45.', section: '4.2' },
      },
    },
    select: { id: true },
  })
  contractId = contract.id

  // ─── 1. Verify keeps the extractor's number ──────────────────────────────
  section('1. A human verdict sits beside the confidence, not on top of it')
  {
    const r = await api(admin.accessToken, 'POST', `/review-queue/${contractId}/verify`, { field: FIELD })
    check('the verify endpoint accepts the call', r.status === 200, `status ${r.status}`)

    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { fieldConfidence: true } })
    const entry = (row?.fieldConfidence ?? {})[FIELD] ?? {}

    // THE ASSERTION. Before the fix this is 1.
    check('the extractor confidence survives a verify', entry.confidence === EXTRACTOR_CONFIDENCE,
      `got ${JSON.stringify(entry.confidence)} — a 1 here means the value a calibration curve needs was destroyed on click`)
    check('the verdict is recorded', entry.review?.verdict === 'verified', JSON.stringify(entry.review))
    check('…with who and when', !!entry.review?.by && !!entry.review?.at)
    check('the quote and section are untouched', entry.quote?.startsWith('Governed by') && entry.section === '12.1')
  }

  // ─── 2. Reject is distinguishable from verify ────────────────────────────
  section('2. A rejection does not impersonate a verification')
  {
    await api(admin.accessToken, 'POST', `/review-queue/${contractId}/reject`, { field: 'paymentTerms' })
    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { fieldConfidence: true } })
    const entry = (row?.fieldConfidence ?? {})['paymentTerms'] ?? {}

    check('the extractor confidence survives a reject', entry.confidence === 0.31,
      `got ${JSON.stringify(entry.confidence)} — a 0 here is the same data loss as a 1 on verify`)
    check('the verdict reads as rejected', entry.review?.verdict === 'rejected', JSON.stringify(entry.review))
    check('it does not also stamp verifiedBy', entry.verifiedBy === undefined,
      'reject used to stamp verifiedBy so the queue would skip it — which made every rejection look like an agreement to any join on that column')
  }

  // ─── 3. A re-extraction does not erase the verdicts ──────────────────────
  section('3. Re-extraction cannot forget what a human decided')
  {
    // Exactly what review.py sends: the whole object, no `review` in it.
    const r = await api(admin.accessToken, 'PATCH', `/contracts/${contractId}`, {
      fieldConfidence: {
        [FIELD]:        { confidence: 0.88, quote: 'Delaware law governs.', section: '12.1' },
        'paymentTerms': { confidence: 0.55, quote: 'Net 30.', section: '4.2' },
      },
    })
    check('the PATCH is accepted', r.status === 200, `status ${r.status}`)

    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { fieldConfidence: true } })
    const fc = row?.fieldConfidence ?? {}
    check('the human verdict survives a whole-object overwrite', fc[FIELD]?.review?.verdict === 'verified',
      'review.py PATCHes the entire column, so without a server-side merge every review is wiped by the next extraction')
    check('the rejection survives too', fc['paymentTerms']?.review?.verdict === 'rejected')
    check('the NEW extractor confidence is taken', fc[FIELD]?.confidence === 0.88,
      'the merge must keep the verdict without freezing the extraction')
  }

  // ─── 4. A field the new run stopped emitting keeps its verdict ───────────
  section('4. A dropped field does not drop its verdict')
  {
    await api(admin.accessToken, 'PATCH', `/contracts/${contractId}`, {
      fieldConfidence: { [FIELD]: { confidence: 0.9 } },   // paymentTerms omitted
    })
    const row = await prisma.contract.findUnique({ where: { id: contractId }, select: { fieldConfidence: true } })
    check('a review-bearing field the extraction omitted is kept',
      (row?.fieldConfidence ?? {})['paymentTerms']?.review?.verdict === 'rejected',
      'losing a human decision because a later run stopped finding the field is the same bug at another angle')
  }

  // ─── 5. The queue read ───────────────────────────────────────────────────
  section('5. The queue skips reviewed fields and still reports the real confidence')
  {
    const r = await api(admin.accessToken, 'GET', `/review-queue?threshold=0.7`)
    check('the queue responds', r.status === 200, `status ${r.status}`)
    const items = (r.body?.items ?? []).filter(i => i.contractId === contractId)
    check('reviewed fields are absent from the queue', items.length === 0,
      `got ${items.map(i => i.field).join(', ')} — a reviewed field must not resurface`)
  }

  // ─── 6. Old rows still read correctly, through the real boundary ────────
  section('6. Legacy rows fold to the new shape on read')
  {
    // Seed BOTH legacy shapes straight into the column, bypassing the API, so
    // this exercises the read boundary rather than a copy of its logic.
    // Note reject stamped verifiedAt/verifiedBy TOO, so rejectedAt is the only
    // reliable discriminator between the two.
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        fieldConfidence: {
          legacyVerified: { confidence: 1, verifiedAt: '2026-01-01T00:00:00Z', verifiedBy: 'u1', quote: 'q' },
          legacyRejected: {
            confidence: 0, rejectedAt: '2026-01-02T00:00:00Z', rejectedBy: 'u2',
            verifiedAt: '2026-01-02T00:00:00Z', verifiedBy: 'u2',
          },
          unreviewed:     { confidence: 0.5, quote: 'q' },
        },
      },
    })

    const r = await api(admin.accessToken, 'GET', `/contracts/${contractId}`)
    check('the contract reads back', r.status === 200, `status ${r.status}`)
    const fc = r.body?.fieldConfidence ?? {}

    check('a legacy verified row reads confidence null, not 1', fc.legacyVerified?.confidence === null,
      `got ${JSON.stringify(fc.legacyVerified?.confidence)} — keeping the 1 would make every verified field claim the extractor was certain, poisoning the curve this change exists to build`)
    check('…and reads as verified', fc.legacyVerified?.review?.verdict === 'verified')
    check('…marked migrated so it can be excluded', fc.legacyVerified?.review?.migrated === true)
    check('a legacy rejected row is not misread as verified', fc.legacyRejected?.review?.verdict === 'rejected',
      'reject stamped verifiedAt/verifiedBy too, so verifiedBy cannot discriminate — rejectedAt is the only reliable signal')
    check('an unreviewed row passes through untouched',
      fc.unreviewed?.confidence === 0.5 && fc.unreviewed?.review === undefined)
  }

} finally {
  if (contractId) await prisma.contract.delete({ where: { id: contractId } }).catch(() => {})
  await prisma.$disconnect()
}

report('L17 confidence provenance')
