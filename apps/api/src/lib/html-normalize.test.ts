import { describe, it, expect } from 'vitest'
import { normalizeTextBullets } from './html-normalize.js'

describe('normalizeTextBullets', () => {
  it('turns paragraphs that start with a bullet glyph back into a list', () => {
    const html = '<p>A. ORGANIZATION</p><p>\t•\t1. Describe the structure.</p><p>\t•\t2. Good standing.</p><p>B. FINANCE</p><p>• 3. Audited accounts.</p>'
    expect(normalizeTextBullets(html)).toBe(
      '<p>A. ORGANIZATION</p><ul><li>1. Describe the structure.</li><li>2. Good standing.</li></ul><p>B. FINANCE</p><ul><li>3. Audited accounts.</li></ul>')
  })

  it('leaves ordinary paragraphs, and bullets inside a sentence, alone', () => {
    const html = '<p>Price: 5 • 10 units</p><p>- a dash is not a bullet</p><ul><li>already a list</li></ul>'
    expect(normalizeTextBullets(html)).toBe(html)
  })
})

describe('a Word file whose list was saved as text', () => {
  it('is read back as a list', async () => {
    const { Document, Packer, Paragraph } = await import('docx')
    const { extractDocument } = await import('./document.js')
    const file = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph('A. ORGANIZATION'),
      new Paragraph('\t•\t1. Describe the corporate structure.'),
      new Paragraph('\t•\t2. Certificate of good standing.'),
    ] }] }))
    const { htmlContent } = await extractDocument(Buffer.from(file), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'return.docx')
    expect(htmlContent).toContain('<ul><li>1. Describe the corporate structure.</li><li>2. Certificate of good standing.</li></ul>')
    expect(htmlContent).not.toContain('•')
  })
})
