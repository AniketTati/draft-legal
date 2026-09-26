/**
 * X11 tripwire for the Python PDF extractor (no Python test runner in CI —
 * same approach as agents-internal-headers.test.ts). extract.py built its HTML
 * from PDF text unescaped, so a PDF whose text reads `<iframe src=…>` became
 * live HTML in htmlContent. Every text → HTML site must escape, and the
 * section-tree reader must decode it back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'routes', 'extract.py'), 'utf8')
const fn = (name: string) => {
  const start = src.indexOf(`def ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = src.indexOf('\ndef ', start + 1)
  return src.slice(start, next === -1 ? undefined : next)
}

describe('extract.py escapes PDF text in the HTML it builds', () => {
  it('span text is escaped before markup wraps it', () => {
    expect(fn('_join_spans')).toMatch(/t = _escape_html\(raw, quote=False\)/)
  })

  it('headings use the escaped text, never the raw line', () => {
    expect(src).not.toMatch(/<h\{heading_level\}>\{plain\}|<h[1-6]>\{plain\}/)
    expect(src).toMatch(/heading_html = _escape_html\(plain, quote=False\)/)
  })

  it('OCR lines are escaped', () => {
    expect(src).toMatch(/join\(_escape_html\(l, quote=False\) for l in page_lines\)/)
  })

  it('the section-tree reader decodes entities back to text', () => {
    expect(fn('_strip_tags')).toMatch(/_unescape_html\(/)
  })
})
