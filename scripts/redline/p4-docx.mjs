#!/usr/bin/env node
/**
 * Phase 4 — tracked-changes DOCX export.
 *
 * The deliverable is a .docx a lawyer opens in Word, reviews with the native
 * Accept/Reject controls, and sends to the counterparty. Everything here is in
 * service of that one artifact being trustworthy.
 *
 * What matters most, in order:
 *
 *   1. IT IS ACTUALLY A DOCX. Two endpoints in this repo already claim to
 *      export DOCX and return PDF bytes with a Word content-type (see W0-7 /
 *      docs/35). A file Word refuses to open is the most basic way to fail, and
 *      it has already shipped here, so the very first assertion is the ZIP
 *      magic number rather than the status code.
 *   2. THE REVISIONS ARE REAL. <w:ins>/<w:del> present, deletions carrying
 *      <w:delText> rather than <w:t> — Word ignores a deletion whose text is in
 *      the wrong element, so it renders as ordinary text and the reviewer never
 *      sees the change.
 *   3. THE METADATA IS VALID. Word silently DROPS revisions with duplicate
 *      w:id, so uniqueness is not cosmetic. w:date must be xsd:dateTime.
 *   4. ACCEPT ALL REPRODUCES v2, REJECT ALL REPRODUCES v1. This is the whole
 *      contract of a redline, asserted on the generated OOXML rather than on
 *      the HTML diff it came from.
 *   5. THE AUTHOR IS A PERSON. createdById is a bare String that is sometimes
 *      `portal:<id>` or `email:<addr>`; emitting that raw into w:author puts a
 *      database identifier in the counterparty's review pane.
 *
 * Run BEFORE: no export route — everything fails.
 * Run AFTER:  all pass.
 *
 * NOT covered here, and no assertion substitutes for it: opening the file in
 * Word and in Google Docs and driving Accept/Reject by hand.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { login, check, report, section, db, API } from '../week-zero/lib/harness.mjs'

const prisma = db()
const admin = await login()
const orgId = admin.user.orgId
const userId = admin.user.id
const TITLE = 'P4 docx export probe'
const TMP = '/private/tmp/claude-501/-Users-temp-Documents-Code-draft-legal/6e3930ba-b18b-4214-9388-1e0e6c9cf636/scratchpad'

// v1 -> v2 covers the shapes the mapper has to survive: an inline figure
// change, a whole paragraph added, a list item removed, and a table row. The
// list/paragraph pair is deliberately worded so htmldiff CANNOT align tokens
// across the block boundary — the one shape measured to break the round trip.
const V1 = [
  '<h2>9. Limitation of Liability</h2>',
  '<p>Liability is capped at <strong>12</strong> months of fees.</p>',
  '<ul><li>Carve-out: fraud.</li><li>Carve-out: wilful misconduct.</li></ul>',
  '<table><tbody><tr><td>Tier</td><td>Cap</td></tr><tr><td>Standard</td><td>12x</td></tr></tbody></table>',
].join('')

const V2 = [
  '<h2>9. Limitation of Liability</h2>',
  '<p>Liability is capped at <strong>24</strong> months of fees.</p>',
  '<ul><li>Carve-out: fraud.</li></ul>',
  '<table><tbody><tr><td>Tier</td><td>Cap</td></tr></tbody></table>',
  '<p>Nothing in this section limits liability for death or personal injury.</p>',
].join('')

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
const mkVersion = (n, html, createdById) => prisma.contractVersion.create({
  data: { contractId: contract.id, versionNumber: n, htmlContent: html,
    plainText: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), createdById },
  select: { id: true },
})
const v1 = await mkVersion(1, V1, userId)
// v2 is authored through the counterparty portal, so createdById is NOT a user
// id. This is the case a naive user lookup returns null for — and it is exactly
// the version a redline is about.
const v2 = await mkVersion(2, V2, `portal:${contract.id}`)
await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: v2.id } })

/** Binary-safe request — harness `api()` reads text and would corrupt the zip. */
async function getBytes(path) {
  const r = await fetch(`${API}/api/v1${path}`, { headers: { Authorization: `Bearer ${admin.accessToken}` } })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, type: r.headers.get('content-type') ?? '', buf }
}

const res = await getBytes(`/contracts/${contract.id}/versions/${v1.id}/redline-docx/${v2.id}`)

// ─── 1. It is a DOCX, not a PDF wearing a DOCX content-type ─────────────────

section('1. The response is a real Word document')
{
  check('the export route responds 200', res.status === 200, `status ${res.status}`)

  const isZip = res.buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const isPdf = res.buf.subarray(0, 4).toString() === '%PDF'
  check('the bytes are a ZIP container, not a PDF', isZip && !isPdf,
    isPdf ? 'PDF bytes served as DOCX — the bug already live in POST /contracts/export'
          : `first bytes ${res.buf.subarray(0, 4).toString('hex') || '(empty)'}`)

  check('the content-type is wordprocessingml',
    res.type.includes('wordprocessingml.document'), `got "${res.type}"`)
}

let xml = ''
if (res.status === 200 && res.buf.length) {
  fs.writeFileSync(`${TMP}/p4-out.docx`, res.buf)
  const part = name => {
    try { return execFileSync('unzip', ['-p', `${TMP}/p4-out.docx`, name], { encoding: 'utf8', maxBuffer: 64e6 }) }
    catch { return '' }
  }

  // ─── 2. The package is well formed ────────────────────────────────────────

  section('2. The archive is a valid OOXML package')
  {
    const listing = (() => {
      try { return execFileSync('unzip', ['-Z1', `${TMP}/p4-out.docx`], { encoding: 'utf8' }) } catch { return '' }
    })()
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      check(`the archive contains ${required}`, listing.includes(required),
        listing.split('\n').filter(Boolean).slice(0, 8).join(', ') || 'unreadable archive')
    }
    xml = part('word/document.xml')
    check('word/document.xml is non-empty and well-formed enough to read',
      xml.includes('<w:document') && xml.includes('</w:document>'), `${xml.length} bytes`)
  }

  // ─── 3. The revisions are real and correctly shaped ───────────────────────

  section('3. The tracked changes are real')
  {
    const ins = xml.match(/<w:ins\b[^>]*>/g) ?? []
    const del = xml.match(/<w:del\b[^>]*>/g) ?? []
    check('insertions are present', ins.length > 0, `${ins.length} <w:ins>`)
    check('deletions are present',  del.length > 0, `${del.length} <w:del>`)

    // A deletion whose text sits in <w:t> renders as ordinary text in Word —
    // the reviewer sees the deleted words as if they were still part of the
    // contract, with no strikethrough and nothing to reject.
    const delBodies = xml.match(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g) ?? []
    const strayT = delBodies.filter(d => /<w:t[\s>]/.test(d))
    check('deleted text uses <w:delText>, never <w:t>',
      delBodies.length > 0 && strayT.length === 0,
      strayT.length ? `${strayT.length} deletion(s) carry <w:t>` : `${delBodies.length} deletions checked`)

    const ids = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:id="([^"]*)"/g)].map(m => m[1])
    check('every revision carries a numeric w:id',
      ids.length > 0 && ids.every(i => /^\d+$/.test(i)),
      ids.length ? `${ids.length} ids, e.g. ${ids.slice(0, 4).join(',')}` : 'no w:id found')
    // Word silently drops the second of two revisions sharing an id.
    check('every w:id is unique', ids.length > 0 && new Set(ids).size === ids.length,
      `${new Set(ids).size} unique of ${ids.length}`)

    const dates = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:date="([^"]*)"/g)].map(m => m[1])
    check('every w:date is ISO-8601 ending in Z',
      dates.length > 0 && dates.every(d => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(d)),
      dates.length ? `e.g. "${dates[0]}"` : 'no w:date found')

    const authors = [...xml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:author="([^"]*)"/g)].map(m => m[1])
    check('every w:author is non-empty', authors.length > 0 && authors.every(a => a.trim()),
      authors.length ? `e.g. "${authors[0]}"` : 'no w:author found')
  }

  // ─── 4. Accept and reject reproduce the two versions ──────────────────────

  section('4. Accept All gives v2, Reject All gives v1')
  {
    const squash = s => s.replace(/\s+/g, '')
    const textOf = x => [...x.matchAll(/<w:(?:t|delText)\b[^>]*>([\s\S]*?)<\/w:(?:t|delText)>/g)]
      .map(m => m[1]).join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

    // Accept: deletions vanish, insertions become ordinary content.
    const accepted = xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
    // Reject: insertions vanish, deletions come back as ordinary content.
    const rejected = xml.replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, '')

    const wantV2 = squash(V2.replace(/<[^>]+>/g, ''))
    const wantV1 = squash(V1.replace(/<[^>]+>/g, ''))

    check('Accept All reproduces v2 exactly', squash(textOf(accepted)) === wantV2,
      `got "${squash(textOf(accepted)).slice(0, 90)}…"`)
    check('Reject All reproduces v1 exactly', squash(textOf(rejected)) === wantV1,
      `got "${squash(textOf(rejected)).slice(0, 90)}…"`)
  }

  // ─── 5. The author is a person, not a database identifier ─────────────────

  section('5. w:author names someone a reviewer recognises')
  {
    const authors = [...new Set([...xml.matchAll(/\bw:author="([^"]*)"/g)].map(m => m[1]))]
    check('no raw portal:/email: prefix reaches w:author',
      authors.length > 0 && !authors.some(a => /^(portal|email):/.test(a)),
      `authors: ${authors.map(a => `"${a}"`).join(', ') || 'none'}`)
  }
} else {
  section('2-5. Skipped — no document to inspect')
  check('an exportable document was returned', false,
    `status ${res.status}; ${typeof res.buf === 'object' ? res.buf.subarray(0, 120).toString() : ''}`)
}

// ─── 6. The two shapes that fail SILENTLY ───────────────────────────────────
//
// Both of these produce a valid .docx that opens cleanly and passes every
// assertion above, while losing content. They get their own fixture because
// the happy-path document contains neither.

section('6. Hyperlinks and <pre> survive')
{
  // The link fixture changes the HREF, not the link text. That is deliberate:
  // htmldiff does not track a change to the visible text of an existing link
  // at all (measured — see docs/35), so a text-change fixture would assert
  // nothing and quietly pass forever. A changed target IS tracked, and it is
  // the case that catches a mapper nesting the hyperlink inside the run.
  //
  // A .txt upload becomes ONE <pre> holding the whole contract, so a mapper
  // that flattens <pre> to text drops every tracked change in those documents.
  const L1 = '<p>See <a href="https://example.com/terms">our terms</a> for detail.</p>'
            + '<pre>SCHEDULE A\nFee: 12 units\nTerm: annual</pre>'
  const L2 = '<p>See <a href="https://example.com/revised-terms">our terms</a> for detail.</p>'
            + '<pre>SCHEDULE A\nFee: 24 units\nTerm: annual</pre>'

  const c2 = await prisma.contract.create({
    data: { org: { connect: { id: orgId } }, owner: { connect: { id: userId } },
      title: TITLE, type: 'MSA', status: 'DRAFT', analysisStatus: 'DONE' },
    select: { id: true },
  })
  const a = await prisma.contractVersion.create({
    data: { contractId: c2.id, versionNumber: 1, htmlContent: L1, plainText: 'a', createdById: userId },
    select: { id: true } })
  const b = await prisma.contractVersion.create({
    data: { contractId: c2.id, versionNumber: 2, htmlContent: L2, plainText: 'b', createdById: userId },
    select: { id: true } })
  await prisma.contract.update({ where: { id: c2.id }, data: { currentVersionId: b.id } })

  const r2 = await getBytes(`/contracts/${c2.id}/versions/${a.id}/redline-docx/${b.id}`)
  let x = ''
  if (r2.status === 200 && r2.buf.length) {
    fs.writeFileSync(`${TMP}/p4-links.docx`, r2.buf)
    try { x = execFileSync('unzip', ['-p', `${TMP}/p4-links.docx`, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64e6 }) } catch {}
  }
  check('the link fixture exports', r2.status === 200 && x.length > 0, `status ${r2.status}`)

  check('the hyperlink is a real w:hyperlink with an r:id',
    /<w:hyperlink[^>]*r:id="/.test(x), 'a link with no relationship is not clickable in Word')

  // BOTH targets must survive: the old one inside the deletion so it can be
  // restored on reject, the new one inside the insertion. Nesting the
  // hyperlink inside the run instead of around it drops one of them, and
  // nothing else in this file would notice.
  check('both link targets are present', /<w:hyperlink/.test(x)
    && (x.match(/<w:hyperlink/g) ?? []).length >= 2,
    `${(x.match(/<w:hyperlink/g) ?? []).length} w:hyperlink element(s) — expected the old and the new`)
  check('the replaced link is inside a deletion',
    /<w:del\b[\s\S]*?<w:hyperlink[\s\S]*?<\/w:del>/.test(x),
    'rejecting the change must restore the original target')

  const rels = (() => {
    try { return execFileSync('unzip', ['-p', `${TMP}/p4-links.docx`, 'word/_rels/document.xml.rels'], { encoding: 'utf8' }) } catch { return '' }
  })()
  check('both link targets are in document.xml.rels',
    rels.includes('example.com/terms') && rels.includes('example.com/revised-terms'),
    'Word resolves r:id through the rels part; without it the link goes nowhere')

  // The <pre> body must still carry its revision. If it were flattened, the
  // figures would both be present as plain text with nothing to accept.
  check('the <pre> change is tracked, not flattened',
    /<w:delText[^>]*>12<\/w:delText>|<w:delText[^>]*>[^<]*12[^<]*<\/w:delText>/.test(x)
    && /<w:ins\b[\s\S]*?24[\s\S]*?<\/w:ins>/.test(x),
    'a flattened <pre> loses every change in .txt-sourced contracts')
  check('the <pre> newlines survive as breaks', (x.match(/<w:br\/>|<w:br \/>/g) ?? []).length > 0,
    'SCHEDULE A / Fee / Term must not collapse onto one line')
}

if (!process.env.KEEP_FIXTURE) await purge()
await prisma.$disconnect()
report('P4 tracked-changes DOCX')
