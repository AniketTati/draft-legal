/**
 * docs/39 A16 — a small Excel workbook for tests, as Excel writes one: text in
 * the shared strings, numbers as numbers, a date as a day number with a date
 * format, TRUE/FALSE as booleans. `{ inline }` writes a string in the cell
 * itself, as some exporters do.
 */
import JSZip from 'jszip'

export type XlsxCell = string | number | boolean | null | { date: string } | { inline: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const col = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : col(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))
const serial = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000)

export async function buildXlsx(rows: XlsxCell[][], opts: { sheetName?: string; startRow?: number } = {}): Promise<Buffer> {
  const shared: string[] = []
  const sharedIndex = (s: string) => {
    const at = shared.indexOf(s)
    return at >= 0 ? at : shared.push(s) - 1
  }
  const start = opts.startRow ?? 1
  const body = rows.map((row, r) => {
    const n = r + start
    const cells = row.map((v, c) => {
      const ref = `${col(c)}${n}`
      if (v === null || v === '') return ''
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
      if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`
      if (typeof v === 'object' && 'inline' in v) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`
      return `<c r="${ref}" t="s"><v>${sharedIndex(v)}</v></c>`
    }).join('')
    return `<row r="${n}">${cells}</row>`
  }).join('')

  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(opts.sheetName ?? 'Contracts')}" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="30"/></cols><sheetData>${body}</sheetData></worksheet>`)
  zip.file('xl/worksheets/sheet2.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>not this one</t></is></c></row></sheetData></worksheet>')
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`)
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts><cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"/></cellXfs></styleSheet>')
  return zip.generateAsync({ type: 'nodebuffer' })
}
