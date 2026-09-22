/**
 * X12 — every DOCX extraction threw
 *   DOMParser.parseFromString: the provided mimeType "undefined" is not valid
 * because the root override forced @xmldom/xmldom 0.9 under mammoth, which
 * declares ^0.8 and calls the 0.8 API. So every DOCX upload failed parsing and
 * /templates/upload always 422'd. A DOCX the app itself writes must read back.
 */
import { describe, it, expect } from 'vitest'
import { extractDocument } from './document.js'
import { generatePlainDocx } from './docx-export.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('DOCX extraction', () => {
  it('reads back a DOCX the app generated', async () => {
    const bytes = await generatePlainDocx('<h1>Master Services Agreement</h1><p>The Supplier shall deliver the Services.</p>', { title: 'MSA' })
    const out = await extractDocument(Buffer.from(bytes), DOCX, 'msa.docx')
    expect(out.mimeType).toBe(DOCX)
    expect(out.plainText).toContain('The Supplier shall deliver the Services.')
    expect(out.htmlContent).toContain('Master Services Agreement')
  })
})
