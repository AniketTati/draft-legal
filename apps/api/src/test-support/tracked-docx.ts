/**
 * A Word file with tracked changes, for tests (docs/39 A9). Each paragraph is
 * written with its changes marked: `{+their words+}` inserted, `{-our words-}`
 * deleted, all by `author`.
 *
 *   trackedDocx(['Payment is due within {-thirty (30)-}{+sixty (60)+} days.'])
 */
import JSZip from 'jszip'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const run = (text: string, tag: 't' | 'delText' = 't') => `<w:r><w:${tag} xml:space="preserve">${esc(text)}</w:${tag}></w:r>`

export async function trackedDocx(paragraphs: string[], author = 'Priya Shah'): Promise<Buffer> {
  let id = 1
  const change = (kind: 'ins' | 'del', inner: string) => `<w:${kind} w:id="${id++}" w:author="${esc(author)}" w:date="2026-09-20T10:00:00Z">${inner}</w:${kind}>`
  const body = paragraphs.map(text => {
    let xml = '', last = 0
    for (const m of text.matchAll(/\{\+([\s\S]*?)\+\}|\{-([\s\S]*?)-\}/g)) {
      if (m.index! > last) xml += run(text.slice(last, m.index))
      xml += m[1] !== undefined ? change('ins', run(m[1])) : change('del', run(m[2], 'delText'))
      last = m.index! + m[0].length
    }
    if (last < text.length) xml += run(text.slice(last))
    return `<w:p>${xml}</w:p>`
  }).join('')

  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>')
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
