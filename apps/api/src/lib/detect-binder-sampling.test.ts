/**
 * X16 tripwire (no Python test runner in CI — same approach as
 * agents-internal-headers.test.ts). Binder detection sent the model only
 * plainText[:10_000], so an agreement starting deeper in a long binder was
 * never seen and the binder was analysed as one document. Long texts must be
 * sampled — the beginning plus offset-marked excerpts at likely agreement
 * boundaries — and the prompt must say how to read the markers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), '..', 'agents', 'app', 'routes', 'detect_binder.py'), 'utf8')

describe('detect_binder.py samples long binders', () => {
  it('the handler samples instead of truncating', () => {
    expect(src).toMatch(/text_sample = _sample\(req\.plainText\)/)
    expect(src).not.toMatch(/req\.plainText\[:MAX_CHARS\]/)
  })

  it('excerpts target agreement boundaries and carry their absolute offset', () => {
    expect(src).toMatch(/_BOUNDARY = re\.compile\(/)
    expect(src).toMatch(/IN WITNESS WHEREOF/)
    expect(src).toMatch(/\[\[EXCERPT starting at character \{start\} of \{n\}/)
  })

  it('the prompt explains the markers so charStart stays absolute', () => {
    expect(src).toMatch(/charStart\s+must be its offset in the FULL document/)
  })
})
