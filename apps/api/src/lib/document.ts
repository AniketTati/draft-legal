import { createRequire } from 'module'
import mammoth from 'mammoth'

const require = createRequire(import.meta.url)
// pdf-parse v1 is CJS — require() returns the function directly
const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>

// P2.4 — each section + paragraph carries {page, bbox} so downstream
// (citations, PDF highlight, section-scoped redlines) can anchor the
// exact region. bbox = [x0, y0, x1, y1] in PDF points (origin top-left).
export interface ExtractedParagraph {
  text:  string
  page?: number | null
  bbox?: number[] | null
}
export interface ExtractedSection {
  id:         string
  ref:        string           // '9.2' / 'Article IX' / ''
  title:      string
  level:      number           // 1-6, matches <h*> depth
  page?:      number | null
  bbox?:      number[] | null
  paragraphs: ExtractedParagraph[]
  children:   ExtractedSection[]
}
export interface ExtractedNav {
  id:    string
  ref:   string
  title: string
  level: number
  depth: number
  paragraphCount: number
  page?: number | null
  bbox?: number[] | null
}

export type ExtractResult = {
  plainText: string
  htmlContent: string
  mimeType: string
  // P2.1 — populated only by the PyMuPDF+OCR Python path. Null on the
  // pdf-parse fallback (we don't have OCR there). The upload worker
  // persists these onto ContractVersion.metadata so the HITL queue,
  // trust badges, and re-index decisions can see them.
  pageCount?:   number
  ocrApplied?:  boolean
  ocrPages?:    number
  ocrBackend?:  string | null
  // P2.2 — nested section tree + flat nav list. Persisted on
  // ContractVersion.metadata.structure so TOC / section-anchored UIs
  // don't re-parse the HTML.
  structure?: {
    sections: ExtractedSection[]
    nav:      ExtractedNav[]
  }
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractResult> {
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    return extractPdf(buffer)
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename.endsWith('.docx')
  ) {
    return extractDocx(buffer)
  }

  if (mimeType === 'text/plain' || filename.endsWith('.txt')) {
    const text = buffer.toString('utf-8')
    return { plainText: text, htmlContent: `<pre>${text}</pre>`, mimeType: 'text/plain' }
  }

  throw new Error(`Unsupported file type: ${mimeType} (${filename})`)
}

async function extractPdf(buffer: Buffer): Promise<ExtractResult> {
  // Primary: pdfplumber via Python agents service (layout-aware, structure-preserving)
  const agentsUrl = process.env.AGENTS_URL ?? 'http://localhost:8002'
  try {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), 'contract.pdf')
    const res = await fetch(`${agentsUrl}/extract`, {
      method: 'POST',
      body: form,
      headers: { 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      signal: AbortSignal.timeout(60_000),
    })
    if (res.ok) {
      const data = await res.json() as {
        htmlContent: string
        plainText:   string
        pageCount?:  number
        ocrApplied?: boolean
        ocrPages?:   number
        ocrBackend?: string | null
        structure?: {
          sections: ExtractedSection[]
          nav:      ExtractedNav[]
        }
      }
      if (data.htmlContent && data.plainText) {
        console.info(
          '[document] pdfplumber extraction OK htmlLen=%d pages=%d ocr=%s sections=%d',
          data.htmlContent.length,
          data.pageCount ?? -1,
          data.ocrApplied ? (data.ocrBackend ?? 'yes') : 'no',
          data.structure?.nav?.length ?? -1,
        )
        return {
          plainText:   data.plainText,
          htmlContent: data.htmlContent,
          mimeType:    'application/pdf',
          pageCount:   data.pageCount,
          ocrApplied:  data.ocrApplied,
          ocrPages:    data.ocrPages,
          ocrBackend:  data.ocrBackend ?? null,
          structure:   data.structure,
        }
      }
    } else {
      console.warn('[document] pdfplumber service returned %d, falling back to pdf-parse', res.status)
    }
  } catch (err) {
    console.warn('[document] pdfplumber unreachable (%s), falling back to pdf-parse', (err as Error).message)
  }

  // Fallback: pdf-parse (always available, no structure)
  let data: { text: string }
  try {
    data = await pdfParse(buffer)
  } catch (err) {
    throw new Error(`PDF parse failed: ${(err as Error).message} — file may be corrupted or password-protected`)
  }
  const rawText = data.text
  const plainText = rawText.replace(/\s+/g, ' ').trim()
  const htmlContent = rawText
    .split(/\n{2,}|\f/)
    .map(block => block.replace(/\n/g, ' ').trim())
    .filter(block => block.length > 2)
    .map(block => `<p>${block}</p>`)
    .join('\n')
  return { plainText, htmlContent, mimeType: 'application/pdf' }
}

async function extractDocx(buffer: Buffer): Promise<ExtractResult> {
  const result = await mammoth.convertToHtml({ buffer })
  const plainText = await mammoth.extractRawText({ buffer })
  return {
    plainText: plainText.value.replace(/\s+/g, ' ').trim(),
    htmlContent: result.value,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
}
