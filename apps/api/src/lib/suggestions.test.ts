/**
 * docs/41 Part 16 (C4) — the analysis reads a document as if its pending
 * suggestions were accepted; plain <ins>/<del> are not suggestions.
 */
import { describe, it, expect } from 'vitest'
import { acceptedHtml, countSuggestions } from './suggestions.js'

const doc = '<p>The fee is <del data-change-id="a" data-author="Asha">ten</del><ins data-change-id="b" data-author="Asha">twenty</ins> dollars.</p>'

describe('acceptedHtml', () => {
  it('drops suggested deletions and unwraps suggested insertions', () => {
    expect(acceptedHtml(doc)).toBe('<p>The fee is twenty dollars.</p>')
  })

  it('keeps formatting inside a suggestion, and plain <ins>/<del>', () => {
    expect(acceptedHtml('<p><ins data-change-id="x"><strong>new</strong></ins> <del>struck</del> <del data-change-id="y"><em>old</em> words</del>end</p>'))
      .toBe('<p><strong>new</strong> <del>struck</del> end</p>')
  })

  it('leaves HTML without suggestions untouched', () => {
    const plain = '<p>Nothing <ins>here</ins>.</p>'
    expect(acceptedHtml(plain)).toBe(plain)
  })

  it('an unclosed suggested deletion drops to the end rather than leaking its words', () => {
    expect(acceptedHtml('<p>Keep <del data-change-id="z">gone')).toBe('<p>Keep ')
  })

  it('stays fast on a pathological input', () => {
    const html = '<del data-change-id="q">'.repeat(20000) + 'x'
    const t = Date.now()
    acceptedHtml(html)
    expect(Date.now() - t).toBeLessThan(500)
  })
})

describe('countSuggestions', () => {
  it('counts each change once, by kind', () => {
    const split = doc + '<p><ins data-change-id="b">more</ins><ins>diff</ins></p>'
    expect(countSuggestions(split)).toEqual({ insertions: 1, deletions: 1, total: 2 })
    expect(countSuggestions('<p>none</p>')).toEqual({ insertions: 0, deletions: 0, total: 0 })
  })
})
