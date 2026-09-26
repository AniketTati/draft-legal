/**
 * Upload content validation — trust the bytes, not the client (S3).
 *
 * The client-declared multipart mimetype is spoofable, and whatever we store
 * becomes the S3 ContentType that presigned download URLs serve back. So a
 * file declared `text/html` / `image/svg+xml` (or HTML labelled as a PDF)
 * would be stored XSS on the storage origin, and mislabelled bytes would reach
 * the parse pipeline. Every upload path runs `checkUpload` before storing
 * anything; the detected type replaces the declared one.
 */
import { inflateRawSync } from 'node:zlib'

export const MIME = {
  PDF:  'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOC:  'application/msword',
  PNG:  'image/png',
  JPEG: 'image/jpeg',
  GIF:  'image/gif',
  WEBP: 'image/webp',
  TIFF: 'image/tiff',
  HEIC: 'image/heic',
  TXT:  'text/plain',
  CSV:  'text/csv',
} as const

// Allowlists per upload path, matching what each path (or its UI) accepts.
/** Documents the parse pipeline can extract (lib/document.ts: PDF/DOCX/TXT). */
export const CONTRACT_DOCUMENT_TYPES = [MIME.PDF, MIME.DOCX, MIME.TXT] as const
/** Counterparty-facing paths that only take a signed/redlined document. */
export const PDF_OR_DOCX = [MIME.PDF, MIME.DOCX] as const
/** Contract attachments (exhibits, schedules) — stored, never parsed. */
export const ATTACHMENT_TYPES = [MIME.PDF, MIME.DOCX, MIME.DOC, MIME.XLSX, MIME.TXT, MIME.CSV] as const
/** Obligation completion evidence (invoices, receipts, screenshots). */
export const EVIDENCE_TYPES = [...ATTACHMENT_TYPES, MIME.PNG, MIME.JPEG, MIME.GIF, MIME.WEBP, MIME.TIFF, MIME.HEIC] as const

/** Every type an upload path can store — the only types a download may be served as. */
const SERVABLE = new Set<string>(Object.values(MIME))

/**
 * Content type to serve a stored object as. Objects stored before upload
 * validation existed may carry a client-declared type (text/html, SVG…);
 * anything off the allowlist is served as an opaque download instead.
 */
export function servableContentType(stored: string | null | undefined): string {
  return stored && SERVABLE.has(stored) ? stored : 'application/octet-stream'
}

/**
 * Entry names from a zip's central directory. OOXML parts are identified by
 * name; searching the raw bytes would also match inside compressed data.
 */
function zipEntryNames(b: Buffer): string[] {
  // End-of-central-directory record: last 22 bytes + up to 64KB of comment.
  const floor = Math.max(0, b.length - 22 - 0xffff)
  let eocd = -1
  for (let i = b.length - 22; i >= floor; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return []
  const count = b.readUInt16LE(eocd + 10)
  let at = b.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let n = 0; n < count && at + 46 <= b.length; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) break
    const nameLen = b.readUInt16LE(at + 28)
    const extraLen = b.readUInt16LE(at + 30)
    const commentLen = b.readUInt16LE(at + 32)
    names.push(b.subarray(at + 46, at + 46 + nameLen).toString('utf8'))
    at += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/**
 * X13 — the bytes a zip's entries really inflate to, or null once past
 * `limit` (or if the zip can't be read). The central directory's declared
 * sizes can lie, so each entry is inflated with a hard output cap: a zip bomb
 * is refused without ever being expanded. (A 714KB DOCX inflated to ~960MB
 * inside mammoth's JSZip before this.)
 */
export function zipInflatedSize(b: Buffer, limit: number): number | null {
  const floor = Math.max(0, b.length - 22 - 0xffff)
  let eocd = -1
  for (let i = b.length - 22; i >= floor; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = b.readUInt16LE(eocd + 10)
  let at = b.readUInt32LE(eocd + 16)
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || b.readUInt32LE(at) !== 0x02014b50) return null
    const method = b.readUInt16LE(at + 10)
    const compressedSize = b.readUInt32LE(at + 20)
    const local = b.readUInt32LE(at + 42)
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) return null
    const dataAt = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28)
    const data = b.subarray(dataAt, dataAt + compressedSize)
    if (method === 0) total += data.length
    else if (method === 8) {
      try { total += inflateRawSync(data, { maxOutputLength: Math.max(1, limit - total + 1) }).length }
      catch { return null }
    } else return null
    if (total > limit) return null
    at += 46 + b.readUInt16LE(at + 28) + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32)
  }
  return total
}

/** Most an Office document may expand to when opened. */
export const MAX_OFFICE_INFLATED_BYTES = 100 * 1024 * 1024

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])

/** Identify a binary format by its signature. Null when there is none. */
export function detectFileType(b: Buffer): string | null {
  // Readers accept junk (a BOM, whitespace, a mail header) before the header
  // as long as it starts within the first 1KB.
  if (b.subarray(0, 1024).includes('%PDF-') || b.subarray(0, 4).toString('latin1') === '%PDF') return MIME.PDF
  if (b.subarray(0, 4).toString('hex') === '504b0304') {
    // OOXML is a zip; its main part names DOCX vs XLSX. Any other zip is not a document.
    const names = zipEntryNames(b)
    if (names.includes('word/document.xml')) return MIME.DOCX
    if (names.includes('xl/workbook.xml')) return MIME.XLSX
    return null
  }
  if (b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return MIME.DOC // legacy OLE
  if (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return MIME.PNG
  if (b.subarray(0, 3).toString('hex') === 'ffd8ff') return MIME.JPEG
  if (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') return MIME.GIF
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return MIME.WEBP
  if (['49492a00', '4d4d002a'].includes(b.subarray(0, 4).toString('hex'))) return MIME.TIFF
  if (b.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.has(b.subarray(8, 12).toString('latin1'))) return MIME.HEIC
  return null
}

const LABELS: Record<string, string> = {
  [MIME.PDF]: 'PDF', [MIME.DOCX]: 'DOCX', [MIME.XLSX]: 'XLSX', [MIME.DOC]: 'DOC',
  [MIME.PNG]: 'PNG', [MIME.JPEG]: 'JPEG', [MIME.GIF]: 'GIF', [MIME.WEBP]: 'WEBP',
  [MIME.TIFF]: 'TIFF', [MIME.HEIC]: 'HEIC',
  [MIME.TXT]: 'TXT', [MIME.CSV]: 'CSV',
}

// What browsers declare for CSV (Windows with Excel installed says
// vnd.ms-excel) and for text of unknown extension.
const CSV_DECLARED = new Set([MIME.CSV, 'application/csv', 'text/x-csv', 'text/comma-separated-values', 'application/vnd.ms-excel'])
const TEXT_DECLARED = new Set([MIME.TXT, '', 'application/octet-stream'])

export type UploadCheck =
  | { ok: true; mimeType: string }
  | { ok: false; status: 400 | 413 | 415; detail: string }

/**
 * Validate an upload's bytes against a path's allowlist. On success returns
 * the type to store — the detected one, never the client's.
 */
export function checkUpload(buf: Buffer, declared: string | undefined, allowed: readonly string[]): UploadCheck {
  if (buf.length === 0) return { ok: false, status: 400, detail: 'The uploaded file is empty.' }
  const allowedLabel = allowed.map(t => LABELS[t] ?? t).join(', ')
  const detected = detectFileType(buf)

  if (detected) {
    if ((detected === MIME.DOCX || detected === MIME.XLSX) && allowed.includes(detected)
      && zipInflatedSize(buf, MAX_OFFICE_INFLATED_BYTES) === null) {
      return {
        ok: false, status: 413,
        detail: `This ${LABELS[detected]} expands to more than ${MAX_OFFICE_INFLATED_BYTES / 1024 / 1024} MB when opened, or is damaged, so it can't be processed.`,
      }
    }
    if (allowed.includes(detected)) return { ok: true, mimeType: detected }
    // Legacy .doc is detectable, but the extraction pipeline has no OLE reader.
    // Refuse with the fix rather than failing analysis opaquely later.
    if (detected === MIME.DOC) {
      return {
        ok: false, status: 415,
        detail: 'Legacy .doc files are not supported. Open the file in Word, save it as .docx, and upload again.',
      }
    }
    return { ok: false, status: 415, detail: `This file type is not accepted here. Allowed: ${allowedLabel}.` }
  }

  // No binary signature: accept only as plain text / CSV, only where text is
  // allowed, only when the client called it text (or gave no real type), and
  // only if it really is text (no NUL bytes). Stored as text/plain or
  // text/csv — never HTML/SVG, whatever was declared.
  const d = (declared ?? '').split(';')[0].trim().toLowerCase()
  const looksBinary = buf.subarray(0, 8192).includes(0)
  if (!looksBinary) {
    if (CSV_DECLARED.has(d) && allowed.includes(MIME.CSV)) return { ok: true, mimeType: MIME.CSV }
    if (TEXT_DECLARED.has(d) && allowed.includes(MIME.TXT)) return { ok: true, mimeType: MIME.TXT }
  }
  return { ok: false, status: 415, detail: `Unsupported or mismatched file type. Allowed: ${allowedLabel}.` }
}
