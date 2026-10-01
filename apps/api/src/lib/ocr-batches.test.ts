/**
 * docs/39 A7 — a scan read a few pages at a time: in order, each batch its
 * place in the whole, the pages a batch couldn't read said so, and the scan
 * past the limit said so.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { ocrInBatches, type BatchReply } from './ocr-batches.js'
import { scanPagesOf, poorPages, poorPageReader, POOR_SCAN } from './scan-quality.js'

async function scan(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return doc.save()
}

/** What the agents service reads from a batch: each page's text, page 5 of the whole a hard one. */
async function reader(chunk: Uint8Array, from: number): Promise<BatchReply> {
  const n = (await PDFDocument.load(chunk)).getPageCount()
  const texts = Array.from({ length: n }, (_, i) => `Page ${from + i + 1} of the scan.`)
  let at = 0
  const pageStarts = texts.map((t, i) => { const s = { page: from + i + 1, start: at }; at += t.length + 2; return s })
  return {
    plainText: texts.join('\n\n'),
    htmlContent: texts.map((t, i) => `<!-- page ${from + i + 1} --><p>${t}</p>`).join('\n'),
    ocrApplied: true, ocrPages: n, ocrBackend: 'tesseract', pageStarts,
    ocrQuality: texts.map((_, i) => ({ page: from + i + 1, confidence: from + i + 1 === 5 ? 0.42 : 0.95 })),
  }
}

describe('a scan read in batches', () => {
  it('reads every page in order, a batch at a time, and says how far it has got', async () => {
    const seen: number[] = []
    const progress: string[] = []
    const out = await ocrInBatches(await scan(20), 20, {
      read: async (chunk, from) => { seen.push(from); return reader(chunk, from) },
      progress: (done, of) => { progress.push(`${done}/${of}`) },
      batchPages: 8,
    })
    expect(seen).toEqual([0, 8, 16])
    expect(progress).toEqual(['0/20', '8/20', '16/20', '20/20'])
    expect(out.ocrPages).toBe(20)
    expect(out.plainText.indexOf('Page 1 ')).toBeLessThan(out.plainText.indexOf('Page 20 '))
    // Each page's start is where its text is in the whole.
    for (const s of out.pageStarts) expect(out.plainText.slice(s.start)).toMatch(new RegExp(`^Page ${s.page} of`))
    expect(out.quality.find(q => q.page === 5)?.confidence).toBe(0.42)
    expect(out).toMatchObject({ unread: [], truncated: false })
  })

  it('tries a batch again, and says which pages it couldn’t read', async () => {
    let tries = 0
    const out = await ocrInBatches(await scan(12), 12, {
      read: async (chunk, from) => {
        if (from === 4) { tries++; throw new Error('timeout') }
        return reader(chunk, from)
      },
      batchPages: 4,
    })
    expect(tries).toBe(2)
    expect(out.unread).toEqual([5, 6, 7, 8])
    expect(out.plainText).toContain('Page 4 of the scan.')
    expect(out.plainText).toContain('Page 9 of the scan.')
    expect(out.plainText).not.toContain('Page 5 of')
  })

  it('stops at the limit and says the rest weren’t read', async () => {
    const out = await ocrInBatches(await scan(10), 10, { read: reader, batchPages: 4, maxPages: 6 })
    expect(out.ocrPages).toBe(6)
    expect(out.truncated).toBe(true)
  })
})

describe('how well each page was read', () => {
  it('finds the page a quote is on, when the engine was unsure of it', async () => {
    const out = await ocrInBatches(await scan(8), 8, { read: reader, batchPages: 3 })
    const pages = scanPagesOf({ extraction: { ocrApplied: true, pageStarts: out.pageStarts, ocrQuality: out.quality } })!
    expect(poorPages(pages)).toEqual([5])
    const poorPageOf = poorPageReader(out.plainText, pages)
    expect(poorPageOf('Page 5 of the scan')).toBe(5)
    expect(poorPageOf('Page 6 of the scan')).toBeNull()
    expect(poorPageOf('words on no page')).toBeNull()
    expect(POOR_SCAN).toBeGreaterThan(0.42)
  })

  it('is nothing for a digital file, or a scan read before pages were kept', () => {
    expect(scanPagesOf({ extraction: { ocrApplied: false, pageCount: 3 } })).toBeNull()
    expect(scanPagesOf({ extraction: { ocrApplied: true, ocrPages: 40 } })).toBeNull()
    expect(scanPagesOf(null)).toBeNull()
  })
})
