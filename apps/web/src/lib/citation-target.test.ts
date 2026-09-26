import { describe, it, expect } from 'vitest'
import { citationHref, parseCitationTarget, highlightRect } from './citation-target'

describe('citation links (X1)', () => {
  it('carry the section, and the page and box when the extractor recorded them', () => {
    const href = citationHref('c1', { sectionRef: '9.2', page: 3, bbox: [72, 100.123, 540, 160] })
    expect(href).toBe('/contracts/c1?section=9.2&page=3&bbox=72%2C100.12%2C540%2C160')
    const target = parseCitationTarget(new URL(href, 'http://x').searchParams)
    expect(target).toEqual({ page: 3, bbox: [72, 100.12, 540, 160] })
  })

  it('fall back to the section alone without a page', () => {
    expect(citationHref('c1', { sectionRef: '9.2', page: null, bbox: [1, 2, 3, 4] })).toBe('/contracts/c1?section=9.2')
    expect(citationHref('c1', { sectionRef: null, page: null, bbox: null })).toBe('/contracts/c1')
  })

  it('ignore a malformed page or box', () => {
    const parse = (q: string) => parseCitationTarget(new URLSearchParams(q))
    expect(parse('page=0')).toEqual({ page: null, bbox: null })
    expect(parse('page=2.5&bbox=1,2,3,4')).toEqual({ page: null, bbox: null })
    expect(parse('page=2&bbox=1,2,3')).toEqual({ page: 2, bbox: null })
    expect(parse('page=2&bbox=5,5,1,1')).toEqual({ page: 2, bbox: null })
    expect(parse('page=2&bbox=a,b,c,d')).toEqual({ page: 2, bbox: null })
    expect(parse('bbox=1,2,3,4')).toEqual({ page: null, bbox: null })
  })

  it('scale the box to the rendered page', () => {
    expect(highlightRect([100, 200, 300, 250], 1.5)).toEqual({ left: 148, top: 298, width: 304, height: 79 })
  })
})
