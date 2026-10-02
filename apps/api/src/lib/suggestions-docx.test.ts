/**
 * docs/41 Part 16 (C4) — pending suggestions go to Word as tracked changes by
 * the person who made them, at the time they made them (w:ins / w:del with
 * w:author and w:date), in the plain export (download for the counterparty,
 * the Google Docs copy) and in the two-version redline's mapping.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { Document, Packer, type Paragraph, type Table } from 'docx'
import { generatePlainDocx } from './docx-export.js'
import { DocxMapper } from './html-to-docx.js'
import { readDocxReview } from './ooxml/docx-redline.js'
import { htmlBlocks } from './ooxml/html-blocks.js'

const html = '<p>The fee is '
  + '<del data-change-id="a" data-author-id="u1" data-author="Asha Rao" data-time="2026-10-01T09:00:00.000Z" class="suggestion suggestion-del">ten</del>'
  + '<ins data-change-id="b" data-author-id="u1" data-author="Asha Rao" data-time="2026-10-01T09:00:00.000Z" class="suggestion suggestion-ins">twenty</ins>'
  + ' dollars, <ins data-change-id="c" data-author-id="portal:l1" data-author="Acme legal (counterparty)" data-time="2026-10-02T10:30:00.000Z">payable monthly</ins>.</p>'

const documentXml = async (bytes: Uint8Array) => (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')

describe('suggestions in a Word export', () => {
  it('each suggestion is a w:ins / w:del by its author, dated when it was made', async () => {
    const xml = await documentXml(await generatePlainDocx(html, { title: 'MSA', author: 'Org' }))
    expect(xml).toMatch(/<w:del [^>]*w:author="Asha Rao"[^>]*w:date="2026-10-01T09:00:00Z"[^>]*>[\s\S]*?<w:delText[^>]*>ten<\/w:delText>/)
    expect(xml).toMatch(/<w:ins [^>]*w:author="Asha Rao"[^>]*w:date="2026-10-01T09:00:00Z"[^>]*>[\s\S]*?twenty/)
    expect(xml).toMatch(/<w:ins [^>]*w:author="Acme legal \(counterparty\)"[^>]*w:date="2026-10-02T10:30:00Z"[^>]*>[\s\S]*?payable monthly/)
    expect(xml).not.toContain('w:author="Org"')
  })

  it('Word reads them back by author', async () => {
    const bytes = await generatePlainDocx(html, { title: 'MSA' })
    const review = await readDocxReview(Buffer.from(bytes))
    expect(review.revisions.byAuthor).toEqual({ 'Asha Rao': 2, 'Acme legal (counterparty)': 1 })
  })

  it('in a redline, a diff’s change inside a suggestion is the suggestion author’s; other changes the version’s', async () => {
    // node-htmldiff keeps a suggestion's <ins> and nests its own inside it.
    const diff = '<p>The fee is <ins data-change-id="b" data-author="Asha Rao" data-time="2026-10-01T09:00:00.000Z" data-diff-node="ins"><ins>twenty</ins></ins> dollars <ins>now</ins>.</p>'
    const body = new DocxMapper({ author: 'Ben (v3)', date: '2026-10-02T00:00:00Z' }).map(diff) as (Paragraph | Table)[]
    const xml = await documentXml(await Packer.toBuffer(new Document({ sections: [{ children: body }] })))
    expect(xml).toMatch(/<w:ins [^>]*w:author="Asha Rao"[^>]*>[\s\S]*?twenty/)
    expect(xml).toMatch(/<w:ins [^>]*w:author="Ben \(v3\)"[^>]*>[\s\S]*?now/)
  })

  it('a missing or odd author or time falls back to the export’s', async () => {
    const odd = '<p><ins data-change-id="x" data-time="not a time">new</ins></p>'
    const body = new DocxMapper({ author: 'Org', date: '2026-01-01T00:00:00Z' }).map(odd) as (Paragraph | Table)[]
    const xml = await documentXml(await Packer.toBuffer(new Document({ sections: [{ children: body }] })))
    expect(xml).toMatch(/<w:ins [^>]*w:author="Org"[^>]*w:date="2026-01-01T00:00:00Z"/)
  })

  it('the text blocks written into their paper read as if the suggestions were accepted', () => {
    expect(htmlBlocks(html).map(b => b.text)).toEqual(['The fee is twenty dollars, payable monthly.'])
  })
})

describe('a Word file’s tracked changes, read back as suggestions', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  it('round trip: exported suggestions come back with their authors and dates', async () => {
    const { extractDocument } = await import('./document.js')
    const bytes = Buffer.from(await generatePlainDocx('<h1>Fees</h1>' + html, { title: 'MSA' }))
    const out = await extractDocument(bytes, DOCX, 'msa.docx', { suggestions: true })
    expect(out.htmlContent).toMatch(/<del data-change-id="w\d+-\w+" data-author-id="word:Asha Rao" data-author="Asha Rao" data-time="2026-10-01T09:00:00.000Z">ten<\/del>/)
    expect(out.htmlContent).toMatch(/<ins [^>]*data-author="Asha Rao"[^>]*>twenty<\/ins>/)
    expect(out.htmlContent).toMatch(/<ins [^>]*data-author="Acme legal \(counterparty\)"[^>]*>payable monthly<\/ins>/)
    // The text read for analysis is the accepted one, as before.
    expect(out.plainText).toContain('The fee is twenty dollars, payable monthly.')
    const { acceptedHtml } = await import('./suggestions.js')
    expect(acceptedHtml(out.htmlContent)).toContain('<p>The fee is twenty dollars, payable monthly.</p>')
  })

  it('without the option, or with no tracked changes, mammoth’s HTML as before', async () => {
    const { extractDocument } = await import('./document.js')
    const bytes = Buffer.from(await generatePlainDocx(html, { title: 'MSA' }))
    expect((await extractDocument(bytes, DOCX, 'msa.docx')).htmlContent).not.toContain('data-change-id')
    const plain = Buffer.from(await generatePlainDocx('<p>Plain words.</p>', { title: 'MSA' }))
    expect((await extractDocument(plain, DOCX, 'p.docx', { suggestions: true })).htmlContent).toBe('<p>Plain words.</p>')
  })

  it('a paragraph whose text mammoth reads differently keeps the changes accepted', async () => {
    const { withSuggestions } = await import('./ooxml/docx-suggestions.js')
    const para = { accepted: 'Pay twenty.', segments: [{ text: 'Pay ', kind: null, author: '', date: '', id: '' }, { text: 'twenty', kind: 'ins' as const, author: 'A', date: '', id: '1' }, { text: '.', kind: null, author: '', date: '', id: '' }] }
    expect(withSuggestions('<p>Pay twenty<br>.</p>', [para])).toMatchObject({ marked: 0, skipped: 1, html: '<p>Pay twenty<br>.</p>' })
    expect(withSuggestions('<p>Pay <strong>twenty</strong>.</p>', [para]).html).toMatch(/<p>Pay <strong><ins [^>]*data-author="A"[^>]*>twenty<\/ins><\/strong>.<\/p>/)
  })
})
