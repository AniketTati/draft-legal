import { describe, it, expect } from 'vitest'
import { parseCommentAnchor, resolveCommentAnchor } from '@clm/types'

const text = 'Fees are due in 30 days. Late fees accrue. Fees are due in 30 days.'

describe('resolveCommentAnchor (docs/41 Part 16)', () => {
  it('keeps the place in the version it was left on', () => {
    const a = { quote: 'Late fees', start: 25, end: 34, versionId: 'v1' }
    expect(resolveCommentAnchor(a, 'anything at all', 'v1')).toEqual({ state: 'anchored', start: 25, end: 34 })
  })

  it('of several matches in a later version, takes the one nearest where it was', () => {
    const a = { quote: 'Fees are due in 30 days.', start: 40, end: 64, versionId: 'v1' }
    expect(resolveCommentAnchor(a, text, 'v2')).toMatchObject({ state: 'moved', start: 43 })
    expect(resolveCommentAnchor({ ...a, start: 0 }, text, 'v2')).toMatchObject({ state: 'anchored', start: 0 })
  })

  it('ignores whitespace when the exact words are not there', () => {
    const a = { quote: 'Late  fees\naccrue', start: 25, end: 42, versionId: 'v1' }
    const r = resolveCommentAnchor(a, 'Intro. Late fees   accrue daily.', 'v2')
    expect(r.state).toBe('moved')
    expect('Intro. Late fees   accrue daily.'.slice(r.start!, r.end!)).toBe('Late fees   accrue')
  })

  it('is orphaned when the words are gone', () => {
    const a = { quote: 'within 90 days', start: 0, end: 14, versionId: 'v1' }
    expect(resolveCommentAnchor(a, text, 'v2')).toEqual({ state: 'orphaned', start: null, end: null })
  })

  it('reads only a well-formed anchor', () => {
    expect(parseCommentAnchor(null)).toBeNull()
    expect(parseCommentAnchor({ quote: '   ' })).toBeNull()
    expect(parseCommentAnchor({ quote: 'abc', start: -1 })).toEqual({ quote: 'abc', start: 0, end: 3, versionId: null })
  })
})
