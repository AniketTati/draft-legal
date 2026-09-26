/**
 * X13 — a DOCX is a zip, and the content check read only its directory. A
 * 714KB DOCX inflated to ~960MB inside mammoth's JSZip: a memory DoS on the
 * parse worker, reachable from the external portal. The real inflated size is
 * now bounded at upload and again before mammoth runs.
 */
import { describe, it, expect } from 'vitest'
import { deflateRawSync, crc32 } from 'node:zlib'
import { checkUpload, zipInflatedSize, CONTRACT_DOCUMENT_TYPES, MAX_OFFICE_INFLATED_BYTES } from './file-type.js'
import { extractDocument } from './document.js'
import { generatePlainDocx } from './docx-export.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** A zip whose entries are the given sizes of repeated bytes (deflated). */
function zipOf(entries: Array<{ name: string; size: number }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.alloc(e.size, 0x41)
    const comp = deflateRawSync(raw, { level: 9 })
    const name = Buffer.from(e.name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, comp); centrals.push(ch, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const bomb = zipOf([{ name: '[Content_Types].xml', size: 100 }, { name: 'word/document.xml', size: MAX_OFFICE_INFLATED_BYTES + 20 * 1024 * 1024 }])

describe('DOCX zip bombs', () => {
  it('the upload check refuses one, quickly, without inflating it', () => {
    expect(bomb.length).toBeLessThan(1024 * 1024)
    const t0 = performance.now()
    const checked = checkUpload(bomb, DOCX, CONTRACT_DOCUMENT_TYPES)
    expect(checked).toMatchObject({ ok: false, status: 413 })
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  it('extraction refuses one before mammoth expands it', async () => {
    await expect(extractDocument(bomb, DOCX, 'bomb.docx')).rejects.toThrow(/expands to more than/)
  })

  it('a real DOCX passes, and its size is measured, not guessed', async () => {
    const real = Buffer.from(await generatePlainDocx('<p>Terms.</p>', { title: 'T' }))
    expect(checkUpload(real, DOCX, CONTRACT_DOCUMENT_TYPES)).toMatchObject({ ok: true, mimeType: DOCX })
    expect(zipInflatedSize(real, MAX_OFFICE_INFLATED_BYTES)).toBeGreaterThan(real.length)
  })
})
