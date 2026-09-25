/**
 * BB1 — the Word redline engine. Every case checks the three things a
 * counterparty's lawyer relies on: accepting all changes reads as our
 * version, rejecting all gives their file back, and paragraphs we didn't
 * change are untouched.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import {
  AlignmentType, Document, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, LevelFormat, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import { redlineDocx, readDocxReview, docxParagraphs, DocxError } from './docx-redline.js'
import { htmlBlocks, type TextBlock } from './html-blocks.js'
import { fold } from './sequence-diff.js'
import { extractDocument } from '../document.js'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const AUTHOR = 'Neelam Dalwani'
const DATE = new Date('2026-09-25T10:00:00Z')

// ─── Fixtures ───────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`
const p = (text: string) => para(run(text))

/** A minimal Word package around `body`. */
async function makeDocx(body: string, extra: { settings?: string; comments?: string; commentsExtended?: string } = {}): Promise<Buffer> {
  const zip = new JSZip()
  const over = (part: string, type: string) => `<Override PartName="/word/${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + over('document.xml', 'document.main')
    + (extra.settings !== undefined ? over('settings.xml', 'settings') : '')
    + (extra.comments ? over('comments.xml', 'comments') : '')
    + (extra.commentsExtended ? over('commentsExtended.xml', 'commentsExtended') : '')
    + '</Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>')
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + (extra.settings !== undefined ? rel('rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml') : '')
    + (extra.comments ? rel('rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', 'comments.xml') : '')
    + (extra.commentsExtended ? rel('rId4', 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'commentsExtended.xml') : '')
    + '</Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document xmlns:w="${W_NS}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`)
  if (extra.settings !== undefined) {
    zip.file('word/settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}">${extra.settings}</w:settings>`)
  }
  if (extra.comments) zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">${extra.comments}</w:comments>`)
  if (extra.commentsExtended) zip.file('word/commentsExtended.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">${extra.commentsExtended}</w15:commentsEx>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

const blocks = (...texts: string[]): TextBlock[] => texts.map(text => ({ text, kind: 'p', inTable: false }))

async function part(file: Buffer, name = 'word/document.xml') {
  return (await JSZip.loadAsync(file)).file(name)!.async('string')
}

/** Each body paragraph's XML, as xmldom writes it. */
async function paragraphXml(file: Buffer): Promise<string[]> {
  const doc = new DOMParser().parseFromString(await part(file), 'text/xml')
  const list = doc.getElementsByTagNameNS(W_NS, 'p')
  const out: string[] = []
  for (let i = 0; i < list.length; i++) out.push(new XMLSerializer().serializeToString(list[i]))
  return out
}

const keys = (xs: string[]) => xs.map(s => fold(s)).filter(Boolean)

/** The three properties, for a redline expected to make every change. */
async function expectFaithful(original: Buffer, target: TextBlock[], out: Buffer) {
  expect(keys(await docxParagraphs(out, 'accepted'))).toEqual(keys(target.map(b => b.text)))
  expect(keys(await docxParagraphs(out, 'original'))).toEqual(keys(await docxParagraphs(original, 'accepted')))
  // Paragraphs with no revision in them are byte-for-byte those of the original.
  const before = new Set(await paragraphXml(original))
  for (const x of await paragraphXml(out)) {
    if (!/<w:(ins|del)\b/.test(x)) expect(before.has(x), x).toBe(true)
  }
}

// ─── The engine ─────────────────────────────────────────────────────────────

describe('redlineDocx', () => {
  it('writes a changed number as a deletion and an insertion, by the user, and leaves the rest alone', async () => {
    const original = await makeDocx(p('1. Payment') + p('Customer shall pay within thirty (30) days of receipt.') + p('2. Term'))
    const target = blocks('1. Payment', 'Customer shall pay within sixty (60) days of receipt.', '2. Term')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })

    expect(stats).toMatchObject({ modified: 1, inserted: 0, deleted: 0, skipped: [], verified: true })
    await expectFaithful(original, target, docx)
    const xml = await part(docx)
    expect(xml).toContain(`w:author="${AUTHOR}"`)
    expect(xml).toContain('w:date="2026-09-25T10:00:00Z"')
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:delText xml:space="preserve">thirty \(30<\/w:delText><\/w:r><\/w:del>|<w:delText xml:space="preserve">thirty<\/w:delText>/)
    // Whole words, not letters: "thirty" goes as a word.
    expect(xml).not.toMatch(/<w:delText[^>]*>t<\/w:delText>/)
  })

  it('keeps the formatting of the text it edits: a bold term replaced stays bold, new words after it do not', async () => {
    const original = await makeDocx(para(run('The ') + run('Supplier', '<w:b/>') + run(' shall deliver the Services.')))
    const target = blocks('The Vendor and its Affiliates shall deliver the Services.')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats.verified).toBe(true)
    await expectFaithful(original, target, docx)
    const xml = await part(docx)
    expect(xml).toMatch(/<w:ins [^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Vendor<\/w:t><\/w:r><w:r><w:t xml:space="preserve"> and its Affiliates<\/w:t><\/w:r><\/w:ins>/)
  })

  it('adds and removes whole paragraphs with their paragraph marks, in order', async () => {
    const original = await makeDocx(p('Clause A.') + p('Clause B, to be removed.') + p('Clause C.'))
    const target = blocks('New opening clause.', 'Clause A.', 'Clause C.', 'First new closing clause.', 'Second new closing clause.')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 0, inserted: 3, deleted: 1, verified: true })
    await expectFaithful(original, target, docx)
    const xml = await part(docx)
    // The removed paragraph's mark is deleted too (it joins the next); the new ones' marks are inserted.
    expect(xml).toMatch(/<w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText xml:space="preserve">Clause B, to be removed\.<\/w:delText>/)
    expect((xml.match(/<w:rPr><w:ins /g) ?? []).length).toBe(3)
  })

  it('does not delete the mark of the last paragraph, or of one that ends a section', async () => {
    const original = await makeDocx(
      para(run('Section one ends here.'), '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>') + p('Middle.') + p('Last paragraph.'))
    const target = blocks('Middle.')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ deleted: 2, verified: true })
    await expectFaithful(original, target, docx)
    const xml = await part(docx)
    expect(xml).not.toMatch(/<w:rPr><w:del [^>]*\/><\/w:rPr><w:sectPr>/)
    expect(xml).toContain('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>')
  })

  it('makes no change for curly quotes, non-breaking or doubled spaces, and says nothing changed', async () => {
    const original = await makeDocx(p('The “Agreement” means this\u00a0agreement.') + p('Supplier’s duties.'))
    const target = blocks('The "Agreement"  means this agreement.', "Supplier's duties.")
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 0, inserted: 0, deleted: 0, verified: true })
    const xml = await part(docx)
    expect(xml).not.toMatch(/<w:(ins|del)\b/)
  })

  it('leaves a paragraph with their own tracked changes or a field as it is, and says so; edits around a footnote', async () => {
    const theirIns = para(run('Fees are ') + `<w:ins w:id="7" w:author="Their Counsel" w:date="2026-09-01T00:00:00Z">${run('not ')}</w:ins>` + run('refundable.'))
    const field = para(run('See clause ') + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF _Ref1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('4') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>' + run(' for fees.'))
    const note = para(run('Governed by English law.') + '<w:r><w:footnoteReference w:id="1"/></w:r>')
    const original = await makeDocx(theirIns + field + note + p('Plain clause.'))
    const target = blocks('Fees are not refundable in any case.', 'See clause 4 for all fees.', 'Governed by English and Welsh law.', 'Plain clause, edited.')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })

    expect(stats.modified).toBe(2)
    expect(stats.skipped.map(s => s.reason)).toEqual(['it contains tracked changes', 'it contains a field'])
    expect(stats.verified).toBe(true)
    const xml = await part(docx)
    // Their revision is still theirs, untouched; ours is only on the plain clause.
    expect(xml).toContain('w:author="Their Counsel"')
    expect((xml.match(new RegExp(`w:author="${AUTHOR}"`, 'g')) ?? []).length).toBeGreaterThan(0)
    const [theirsXml] = await paragraphXml(original)
    expect((await paragraphXml(docx))[0]).toBe(theirsXml)
    // Rejecting ours still leaves their insertion in place (it's theirs to reject).
    expect(keys(await docxParagraphs(docx, 'accepted'))[0]).toBe('Fees are not refundable.')
    // The footnote's marker is still there, after the edited sentence.
    expect(xml).toContain('Welsh ')
    expect(xml).toMatch(/law\.<\/w:t><\/w:r><w:r><w:footnoteReference w:id="1"\/><\/w:r>/)
  })

  it('can take their returned redline as it reads: their changes accepted, ours marked against the result', async () => {
    const theirs = para(run('Fees are ') + `<w:ins w:id="7" w:author="Their Counsel" w:date="2026-09-01T00:00:00Z">${run('not ')}</w:ins>` + run('refundable')
      + `<w:del w:id="8" w:author="Their Counsel" w:date="2026-09-01T00:00:00Z"><w:r><w:delText> in part</w:delText></w:r></w:del>` + run('.'))
      + para(run('A clause they removed.'), '<w:rPr><w:del w:id="9" w:author="Their Counsel" w:date="2026-09-01T00:00:00Z"/></w:rPr>')
      + p('Kept clause.')
    const original = await makeDocx(theirs)
    const target = blocks('Fees are not refundable, save for fraud.', 'A clause they removed.Kept clause, edited.')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE, acceptExisting: true })
    expect(stats).toMatchObject({ acceptedExisting: 3, skipped: [], verified: true })
    const xml = await part(docx)
    expect(xml).not.toContain('Their Counsel')
    expect(keys(await docxParagraphs(docx, 'original'))).toEqual(['Fees are not refundable.', 'A clause they removed.Kept clause.'])
    expect(keys(await docxParagraphs(docx, 'accepted'))).toEqual(keys(target.map(b => b.text)))
  })

  it('keeps a bullet typed as text, which our copy of the file shows as a list', async () => {
    const original = await makeDocx(p('\t•\tCustomer may terminate for convenience.') + p('Other terms.'))
    // The version's HTML came through normalizeTextBullets: the bullet is list markup there.
    const target = htmlBlocks('<ul><li>Customer may terminate for convenience on 30 days’ notice.</li></ul><p>Other terms.</p>')
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 1, verified: true })
    const accepted = await docxParagraphs(docx, 'accepted')
    expect(accepted[0]).toBe('\t•\tCustomer may terminate for convenience on 30 days’ notice.')
    const xml = await part(docx)
    expect(xml).not.toMatch(/<w:delText[^>]*>[^<]*•/)
  })

  it('edits a table cell in place, and puts a new clause after the table rather than inside it', async () => {
    const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
    const table = `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>`
      + `<w:tr>${cell('Service')}${cell('Fee')}</w:tr><w:tr>${cell('Support')}${cell('$1,000 per month')}</w:tr></w:tbl>`
    const original = await makeDocx(p('Fees are set out below.') + table + p('Signed by the parties.'))
    const target: TextBlock[] = [
      { text: 'Fees are set out below.', kind: 'p', inTable: false },
      { text: 'Service', kind: 'cell', inTable: true }, { text: 'Fee', kind: 'cell', inTable: true },
      { text: 'Support', kind: 'cell', inTable: true }, { text: '$900 per month', kind: 'cell', inTable: true },
      { text: 'Fees may not rise more than once a year.', kind: 'p', inTable: false },
      { text: 'Signed by the parties.', kind: 'p', inTable: false },
    ]
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 1, inserted: 1, verified: true })
    await expectFaithful(original, target, docx)
    const xml = await part(docx)
    // A number is one word: "$1,000" goes whole, not "1" then ",000".
    expect(xml).toContain('<w:delText xml:space="preserve">1,000</w:delText>')
    expect(xml).toMatch(/<\/w:tbl><w:p><w:pPr><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">Fees may not rise/)
  })

  it('formats a new list item like the list it joins, and a new paragraph like its neighbours', async () => {
    const li = (text: string) => para(run(text), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>')
    const original = await makeDocx(p('The Supplier shall:') + li('deliver the Services;') + li('keep records.') + p('Nothing else applies.'))
    const target: TextBlock[] = [
      { text: 'The Supplier shall:', kind: 'p', inTable: false },
      { text: 'deliver the Services;', kind: 'li', inTable: false },
      { text: 'keep records; and', kind: 'li', inTable: false },
      { text: 'comply with the Security Policy.', kind: 'li', inTable: false },
      { text: 'Nothing else applies.', kind: 'p', inTable: false },
    ]
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 1, inserted: 1, verified: true })
    const xml = await part(docx)
    expect(xml).toMatch(/<w:p><w:pPr><w:pStyle w:val="ListParagraph"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="3"\/><\/w:numPr><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">comply with the Security Policy\./)
  })

  it('numbers its revisions past every id already in the file, each once', async () => {
    const original = await makeDocx(para('<w:bookmarkStart w:id="40" w:name="_Ref1"/>' + run('Clause one.') + '<w:bookmarkEnd w:id="40"/>') + p('Clause two.'))
    const { docx } = await redlineDocx(original, blocks('Clause one, edited.', 'Clause three.'), { author: AUTHOR, date: DATE })
    const ids = [...(await part(docx)).matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map(m => Number(m[1]))
    expect(ids.length).toBeGreaterThan(2)
    expect(Math.min(...ids)).toBeGreaterThan(40)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('opens with Track Changes on, in the place the settings schema puts it', async () => {
    const original = await makeDocx(p('Clause.'), { settings: '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat/>' })
    const { docx } = await redlineDocx(original, blocks('Clause, edited.'), { author: AUTHOR })
    expect(await part(docx, 'word/settings.xml')).toContain('<w:zoom w:percent="100"/><w:trackRevisions/><w:defaultTabStop w:val="720"/>')
    // Nothing to mark: the file is left as it was.
    const same = await redlineDocx(original, blocks('Clause.'), { author: AUTHOR })
    expect(await part(same.docx, 'word/settings.xml')).not.toContain('trackRevisions')
  })

  it('stays faithful when every paragraph changes, and when a long contract changes in a few places', async () => {
    const original = await makeDocx(p('Alpha clause text.') + p('Beta clause text.'))
    const all = blocks('Something else entirely.', 'And a different ending.', 'Plus one more.')
    const r1 = await redlineDocx(original, all, { author: AUTHOR })
    expect(r1.stats.verified).toBe(true)
    await expectFaithful(original, all, r1.docx)

    const texts = Array.from({ length: 1500 }, (_, i) => `Clause ${i + 1}. The parties agree to term number ${i + 1} as set out in schedule ${i % 7}.`)
    const long = await makeDocx(texts.map(p).join(''))
    const edited = texts.map((t, i) => (i % 50 === 7 ? t.replace('agree to', 'shall comply with') : t)).filter((_, i) => i !== 900)
    edited.splice(400, 0, 'A new clause about audit rights.')
    const t0 = performance.now()
    const r2 = await redlineDocx(long, blocks(...edited), { author: AUTHOR })
    expect(performance.now() - t0).toBeLessThan(15_000)
    expect(r2.stats).toMatchObject({ modified: 30, inserted: 1, deleted: 1, verified: true })
    await expectFaithful(long, blocks(...edited), r2.docx)
  })

  it('refuses what is not a Word document, with a reason a person can read', async () => {
    await expect(redlineDocx(Buffer.from('%PDF-1.7 not a zip'), blocks('x'), { author: AUTHOR })).rejects.toBeInstanceOf(DocxError)
    const noBody = new JSZip(); noBody.file('hello.txt', 'hi')
    await expect(redlineDocx(await noBody.generateAsync({ type: 'nodebuffer' }), blocks('x'), { author: AUTHOR })).rejects.toThrow(/not a Word document/)
    const dtd = new JSZip()
    dtd.file('word/document.xml', `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:document xmlns:w="${W_NS}"><w:body>${p('&a;')}</w:body></w:document>`)
    await expect(redlineDocx(await dtd.generateAsync({ type: 'nodebuffer' }), blocks('x'), { author: AUTHOR })).rejects.toThrow(/document type/)
  })
})

// ─── Their file, through our pipeline, and back ─────────────────────────────

describe('a counterparty contract, read into DraftLegal, edited, and redlined back into their file', () => {
  async function theirContract(): Promise<Buffer> {
    const doc = new Document({
      numbering: { config: [
        { reference: 'defs', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] },
        { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.START }] },
      ] },
      footnotes: { 1: { children: [new Paragraph('Including its conflict of laws rules.')] } },
      sections: [{ children: [
        new Paragraph({ text: 'MASTER SERVICES AGREEMENT', heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [
          new TextRun('This Agreement is made between Acme Corp (“'), new TextRun({ text: 'Customer', bold: true }),
          new TextRun('”) and '), new TextRun({ text: 'Vendor Ltd', bold: true }), new TextRun(' (“Supplier”).'),
        ] }),
        new Paragraph({ text: '1. DEFINITIONS', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: '“Affiliate” means an entity that controls a party.', numbering: { reference: 'defs', level: 0 } }),
        new Paragraph({ text: '“Services” means the services in Schedule 1.', numbering: { reference: 'defs', level: 0 } }),
        new Paragraph({ text: '2. PAYMENT', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [
          new TextRun('Customer shall pay each invoice within '), new TextRun({ text: 'thirty (30)', italics: true }), new TextRun(' days of receipt.'),
        ] }),
        new Paragraph({ text: '3. LIABILITY', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('Supplier’s aggregate liability shall be unlimited.'),
        new Table({ width: { size: 9000, type: WidthType.DXA }, rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph('Service')] }), new TableCell({ children: [new Paragraph('Fee')] })] }),
          new TableRow({ children: [new TableCell({ children: [new Paragraph('Support')] }), new TableCell({ children: [new Paragraph('$1,000 per month')] })] }),
        ] }),
        new Paragraph({ children: [
          new TextRun('Notices go to '), new ExternalHyperlink({ link: 'mailto:legal@vendor.example', children: [new TextRun({ text: 'legal@vendor.example', style: 'Hyperlink' })] }), new TextRun('.'),
        ] }),
        new Paragraph({ text: 'Term: 12 months', numbering: { reference: 'bullets', level: 0 } }),
        new Paragraph({ text: 'Renewal: automatic', numbering: { reference: 'bullets', level: 0 } }),
        new Paragraph('\t•\tCustomer may terminate for convenience.'),
        new Paragraph({ children: [new TextRun('This Agreement is governed by the laws of England.'), new FootnoteReferenceRun(1)] }),
        new Paragraph('Signed by the parties.'),
      ] }],
    })
    return Buffer.from(await Packer.toBuffer(doc))
  }

  it('comes back as their file with our changes tracked, and reads as our version when accepted', async () => {
    const original = await theirContract()
    const { htmlContent } = await extractDocument(original, DOCX, 'msa.docx')

    // What a user did in DraftLegal, as edits to the version's HTML.
    const edit = (html: string, from: string | RegExp, to: string) => {
      const next = html.replace(from, to)
      expect(next, `the fixture's HTML should contain ${from}`).not.toBe(html)
      return next
    }
    let html = htmlContent
    html = edit(html, 'thirty (30)', 'sixty (60)')
    html = edit(html, 'shall be unlimited.', 'shall not exceed the fees paid in the twelve (12) months before the claim.')
    html = edit(html, /(twelve \(12\) months before the claim\.<\/p>)/, '$1<p>Neither party excludes liability for fraud.</p>')
    html = edit(html, '$1,000 per month', '$900 per month')
    html = edit(html, 'Vendor Ltd', 'Vendor Limited')
    html = edit(html, '<li>Renewal: automatic</li>', '')
    html = edit(html, 'terminate for convenience.', 'terminate for convenience on 30 days’ notice.')
    html = edit(html, 'the laws of England.', 'the laws of England and Wales.')
    html = edit(html, /(Signed by the parties\.<\/p>)/, '$1<p>Schedule 1 applies.</p>')

    const target = htmlBlocks(html)
    const { docx, stats } = await redlineDocx(original, target, { author: AUTHOR, date: DATE })
    expect(stats).toMatchObject({ modified: 6, inserted: 2, deleted: 1, skipped: [], verified: true })

    // Read back through the same pipeline a returned file goes through.
    const back = await extractDocument(docx, DOCX, 'msa-redline.docx')
    for (const s of ['sixty (60)', 'Vendor Limited', '$900 per month', 'Neither party excludes liability for fraud.', 'Schedule 1 applies.', 'on 30 days’ notice', 'the laws of England and Wales']) {
      expect(back.plainText).toContain(s)
    }
    expect(back.plainText).not.toContain('Renewal: automatic')
    expect(back.plainText).not.toContain('thirty (30)')

    // Rejecting everything gives their contract back.
    expect(keys(await docxParagraphs(docx, 'original'))).toEqual(keys(await docxParagraphs(original, 'accepted')))
    // Their numbering, styles and footnotes are all still there.
    const zip = await JSZip.loadAsync(docx)
    for (const name of ['word/numbering.xml', 'word/styles.xml', 'word/footnotes.xml']) expect(zip.file(name), name).not.toBeNull()
    const xml = await part(docx)
    // "sixty" replaces "thirty" in its italics; the brackets around the number stay theirs.
    expect(xml).toMatch(/<w:ins [^>]*><w:r><w:rPr><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">sixty<\/w:t>/)
  })
})

// ─── Reading a returned file ────────────────────────────────────────────────

describe('readDocxReview', () => {
  it('reads each comment with the text it is on, its thread and whether it is resolved, and counts changes by author', async () => {
    const body = para(run('Payment is due in ') + '<w:commentRangeStart w:id="0"/>' + run('sixty (60) days') + '<w:commentRangeEnd w:id="0"/>' + '<w:r><w:commentReference w:id="0"/></w:r>'
      + `<w:ins w:id="5" w:author="Priya (Acme Legal)" w:date="2026-09-25T12:00:00Z">${run(' net')}</w:ins>`)
      + para(`<w:del w:id="6" w:author="Priya (Acme Legal)" w:date="2026-09-25T12:00:00Z"><w:r><w:delText>Old text.</w:delText></w:r></w:del>`)
      + para(`<w:ins w:id="8" w:author="Neelam Dalwani" w:date="2026-09-25T12:00:00Z">${run('Our clause.')}</w:ins>`)
    const comments = '<w:comment w:id="0" w:author="Priya (Acme Legal)" w:date="2026-09-25T12:00:00Z"><w:p w14:paraId="0A000001">' + run('Can we live with 60?') + '</w:p></w:comment>'
      + '<w:comment w:id="1" w:author="Neelam Dalwani" w:date="2026-09-25T13:00:00Z"><w:p w14:paraId="0A000002">' + run('Yes, CFO agreed.') + '</w:p></w:comment>'
    const commentsExtended = '<w15:commentEx w15:paraId="0A000001" w15:done="1"/><w15:commentEx w15:paraId="0A000002" w15:paraIdParent="0A000001" w15:done="0"/>'
    const file = await makeDocx(body, { comments, commentsExtended })

    const review = await readDocxReview(file)
    expect(review.comments).toEqual([
      { id: '0', author: 'Priya (Acme Legal)', date: '2026-09-25T12:00:00Z', text: 'Can we live with 60?', anchor: 'sixty (60) days', parentId: null, resolved: true },
      { id: '1', author: 'Neelam Dalwani', date: '2026-09-25T13:00:00Z', text: 'Yes, CFO agreed.', anchor: '', parentId: '0', resolved: false },
    ])
    expect(review.revisions).toEqual({ insertions: 2, deletions: 1, byAuthor: { 'Priya (Acme Legal)': 2, 'Neelam Dalwani': 1 } })
  })

  it('reads a file with no comments', async () => {
    expect(await readDocxReview(await makeDocx(p('Clause.')))).toEqual({ comments: [], revisions: { insertions: 0, deletions: 0, byAuthor: {} } })
  })
})
