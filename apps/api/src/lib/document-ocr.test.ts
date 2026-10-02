/**
 * docs/39 A7 — reading a PDF: the digital text first; a scan's pages then a
 * batch at a time, however many; an agents service from before (which reads
 * a scan's first 40 pages itself) still works.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { extractDocument } from './document.js'

async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return Buffer.from(await doc.save())
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** The agents service's /extract, reading a scan the way A7 asks it to. */
function agents(opts: { old?: boolean; digital?: boolean } = {}) {
  const calls: Array<{ ocr: string | null; pageOffset: string | null; pages: number }> = []
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const form = init.body as FormData
    const pages = (await PDFDocument.load(await (form.get('file') as Blob).arrayBuffer())).getPageCount()
    const ocr = form.get('ocr') as string | null, offset = Number(form.get('pageOffset') ?? 0)
    calls.push({ ocr, pageOffset: form.get('pageOffset') as string | null, pages })
    if (opts.digital) return json({ plainText: 'A digital agreement.', htmlContent: '<p>A digital agreement.</p>', pageCount: pages, scanned: false, ocrApplied: false })
    // An older service reads a scan's first 40 pages itself, whatever it's asked.
    if (ocr === 'none' && !opts.old) return json({ plainText: '', htmlContent: '', pageCount: pages, scanned: true, ocrApplied: false })
    const n = opts.old ? Math.min(pages, 40) : pages
    const texts = Array.from({ length: n }, (_, i) => `Scanned page ${offset + i + 1}.`)
    let at = 0
    return json({
      plainText: texts.join('\n\n'), htmlContent: texts.map(t => `<p>${t}</p>`).join('\n'), pageCount: pages,
      ocrApplied: true, ocrPages: n, ocrBackend: 'tesseract', scanned: true,
      ...(!opts.old && {
        ocrQuality: texts.map((_, i) => ({ page: offset + i + 1, confidence: 0.9 })),
        pageStarts: texts.map((t, i) => { const s = { page: offset + i + 1, start: at }; at += t.length + 2; return s }),
      }),
    })
  })
  vi.stubGlobal('fetch', fetch)
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('reading a PDF', () => {
  it('reads a long scan a batch at a time, every page, saying how far it has got', async () => {
    const calls = agents()
    const progress: string[] = []
    const out = await extractDocument(await pdf(45), 'application/pdf', 'scan.pdf', { onOcrProgress: (d, of) => { progress.push(`${d}/${of}`) } })
    expect(calls[0]).toMatchObject({ ocr: 'none', pages: 45 })
    expect(calls.slice(1).every(c => c.ocr === 'auto' && c.pages <= 8)).toBe(true)
    expect(calls.slice(1).map(c => c.pageOffset)).toEqual(['0', '8', '16', '24', '32', '40'])
    expect(progress.at(-1)).toBe('45/45')
    expect(out).toMatchObject({ ocrApplied: true, ocrPages: 45, pageCount: 45 })
    // Past the old limit of 40.
    expect(out.plainText).toContain('Scanned page 45.')
    expect(out.ocr?.pageStarts).toHaveLength(45)
  })

  it('reads a digital file once', async () => {
    const calls = agents({ digital: true })
    const out = await extractDocument(await pdf(3), 'application/pdf', 'agreement.pdf')
    expect(calls).toHaveLength(1)
    expect(out).toMatchObject({ plainText: 'A digital agreement.', ocrApplied: false })
    expect(out.ocr).toBeUndefined()
  })

  it('takes what an agents service from before read, as before', async () => {
    const calls = agents({ old: true })
    const out = await extractDocument(await pdf(45), 'application/pdf', 'scan.pdf')
    expect(calls).toHaveLength(1)
    expect(out).toMatchObject({ ocrApplied: true, ocrPages: 40 })
  })
})

// A 1×1 PNG: a scan kept as an image, as far as the pipeline cares.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('reading what isn’t a PDF (docs/39 A12)', () => {
  it('reads a scan kept as an image as the one-page PDF it is made into, through OCR', async () => {
    const calls = agents()
    const out = await extractDocument(PNG, 'image/png', 'signed-page.png')
    expect(calls[0]).toMatchObject({ ocr: 'none', pages: 1 })
    expect(out).toMatchObject({ ocrApplied: true, ocrPages: 1, mimeType: 'image/png' })
    expect(out.plainText).toContain('Scanned page 1.')
    expect(out.convertedPdf?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('reads a legacy .doc as the PDF LibreOffice makes of it', async () => {
    const converted = await pdf(2)
    const sent: string[] = []
    const inner = agents({ digital: true })
    const agentsFetch = globalThis.fetch as unknown as (u: string, i: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/forms/libreoffice/convert')) {
        sent.push(((init.body as FormData).get('files') as File).name)
        return new Response(new Uint8Array(converted), { status: 200, headers: { 'content-type': 'application/pdf' } })
      }
      return agentsFetch(url, init)
    }))
    const out = await extractDocument(Buffer.from('d0cf11e0a1b11ae1000000', 'hex'), 'application/msword', 'Old MSA.doc')
    expect(sent).toEqual(['contract.doc'])
    expect(inner[0]).toMatchObject({ pages: 2 })
    expect(out).toMatchObject({ plainText: 'A digital agreement.', mimeType: 'application/msword' })
    expect(out.convertedPdf?.length).toBe(converted.length)
  })
})
