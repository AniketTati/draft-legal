/**
 * S3 — upload validation trusts the bytes, never the declared mimetype.
 */
import { describe, it, expect } from 'vitest'
import { checkUpload, detectFileType, servableContentType, MIME, CONTRACT_DOCUMENT_TYPES, PDF_OR_DOCX, ATTACHMENT_TYPES, EVIDENCE_TYPES } from './file-type.js'

/** A stored (uncompressed) zip with the given entries — enough structure for the central-directory reader. */
function makeZip(entries: Array<[name: string, data: string]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const n = Buffer.from(name), d = Buffer.from(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, d); centrals.push(central, n)
    offset += 30 + n.length + d.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const pdf  = Buffer.from('%PDF-1.7\n1 0 obj\n')
const docx = makeZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>']])
const xlsx = makeZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']])
const zip  = makeZip([['payload.exe', 'MZ']])
// Part names appearing only inside file DATA (as in compressed bytes) must not count.
const disguised = makeZip([['notes.txt', 'see word/document.xml and xl/workbook.xml']])
const doc  = Buffer.from('d0cf11e0a1b11ae1000000', 'hex')
const png  = Buffer.from('89504e470d0a1a0a0000', 'hex')
const html = Buffer.from('<html><script>alert(document.cookie)</script></html>')
const svg  = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
const bin  = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])

describe('detectFileType', () => {
  it('identifies documents and images by signature', () => {
    expect(detectFileType(pdf)).toBe(MIME.PDF)
    expect(detectFileType(docx)).toBe(MIME.DOCX)
    expect(detectFileType(xlsx)).toBe(MIME.XLSX)
    expect(detectFileType(doc)).toBe(MIME.DOC)
    expect(detectFileType(png)).toBe(MIME.PNG)
    expect(detectFileType(Buffer.from('ffd8ffe0', 'hex'))).toBe(MIME.JPEG)
  })

  it('does not treat an arbitrary zip or markup as a document', () => {
    expect(detectFileType(zip)).toBeNull()
    expect(detectFileType(disguised)).toBeNull()
    expect(detectFileType(html)).toBeNull()
  })

  it('tolerates leading bytes before a PDF header, as PDF readers do', () => {
    expect(detectFileType(Buffer.concat([Buffer.from('efbbbf0d0a', 'hex'), pdf]))).toBe(MIME.PDF)
  })

  it('identifies TIFF and HEIC evidence photos', () => {
    expect(detectFileType(Buffer.from('49492a0008000000', 'hex'))).toBe(MIME.TIFF)
    expect(detectFileType(Buffer.concat([Buffer.from('00000018', 'hex'), Buffer.from('ftypheic')]))).toBe(MIME.HEIC)
  })
})

describe('checkUpload', () => {
  it('replaces a spoofed declared type with the detected one', () => {
    expect(checkUpload(pdf, 'text/html', PDF_OR_DOCX)).toEqual({ ok: true, mimeType: MIME.PDF })
  })

  it('refuses HTML or SVG whatever the client declares', () => {
    for (const declared of [MIME.PDF, MIME.DOCX, 'text/html', 'image/svg+xml', MIME.TXT]) {
      expect(checkUpload(html, declared, PDF_OR_DOCX).ok).toBe(false)
      expect(checkUpload(svg, declared, PDF_OR_DOCX).ok).toBe(false)
    }
    // Where text is allowed, markup is stored as inert text/plain, never as HTML/SVG.
    expect(checkUpload(html, 'text/html', CONTRACT_DOCUMENT_TYPES).ok).toBe(false)
    expect(checkUpload(svg, 'image/svg+xml', EVIDENCE_TYPES).ok).toBe(false)
    expect(checkUpload(html, MIME.TXT, CONTRACT_DOCUMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.TXT })
  })

  it('refuses a detected type the path does not allow', () => {
    const r = checkUpload(png, MIME.PNG, CONTRACT_DOCUMENT_TYPES)
    expect(r).toMatchObject({ ok: false, status: 415 })
    expect(checkUpload(xlsx, MIME.XLSX, PDF_OR_DOCX).ok).toBe(false)
    expect(checkUpload(zip, MIME.DOCX, PDF_OR_DOCX).ok).toBe(false)
  })

  it('keeps the friendly legacy .doc refusal where .doc is not allowed, and accepts it where it is', () => {
    const r = checkUpload(doc, MIME.DOC, CONTRACT_DOCUMENT_TYPES)
    expect(r).toMatchObject({ ok: false, status: 415 })
    expect(!r.ok && r.detail).toMatch(/save it as \.docx/)
    expect(checkUpload(doc, MIME.DOC, ATTACHMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.DOC })
  })

  it('accepts text only where allowed, only when declared as text, and never binary', () => {
    expect(checkUpload(Buffer.from('plain terms'), MIME.TXT, CONTRACT_DOCUMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.TXT })
    expect(checkUpload(Buffer.from('plain terms'), '', CONTRACT_DOCUMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.TXT })
    expect(checkUpload(Buffer.from('a,b\n1,2'), 'text/csv; charset=utf-8', ATTACHMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.CSV })
    expect(checkUpload(Buffer.from('plain terms'), MIME.TXT, PDF_OR_DOCX).ok).toBe(false)
    expect(checkUpload(Buffer.from('plain terms'), MIME.PDF, CONTRACT_DOCUMENT_TYPES).ok).toBe(false)
    expect(checkUpload(bin, MIME.TXT, ATTACHMENT_TYPES).ok).toBe(false)
  })

  it('accepts CSV and text as browsers actually declare them', () => {
    // Windows with Excel installed declares .csv as vnd.ms-excel.
    expect(checkUpload(Buffer.from('a,b\n1,2'), 'application/vnd.ms-excel', ATTACHMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.CSV })
    expect(checkUpload(Buffer.from('notes'), 'application/octet-stream', ATTACHMENT_TYPES)).toEqual({ ok: true, mimeType: MIME.TXT })
    // …but never where text is not allowed.
    expect(checkUpload(Buffer.from('a,b\n1,2'), 'application/vnd.ms-excel', PDF_OR_DOCX).ok).toBe(false)
  })

  it('refuses an empty file', () => {
    expect(checkUpload(Buffer.alloc(0), MIME.PDF, PDF_OR_DOCX)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('servableContentType', () => {
  it('passes allowlisted types through and downgrades anything else to a download', () => {
    expect(servableContentType(MIME.PDF)).toBe(MIME.PDF)
    expect(servableContentType('text/html')).toBe('application/octet-stream')
    expect(servableContentType('image/svg+xml')).toBe('application/octet-stream')
    expect(servableContentType(null)).toBe('application/octet-stream')
  })
})
