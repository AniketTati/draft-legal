/**
 * docs/41 browser QA — a request's words decide a legal choice only when they
 * name one: "QA NDA no law" was read as asking for the governing law "no law".
 */
import { describe, it, expect } from 'vitest'
import { isAbsentValue, namesAValue } from './request-values.js'

describe('a value that says there is none', () => {
  it('is no value', () => {
    for (const v of ['no law', 'No governing law', 'none', 'N/A', 'TBD', 'tbc', 'not specified', 'Not yet decided', 'to be determined', 'unspecified', '“TBD”', '']) {
      expect(isAbsentValue(v), v).toBe(true)
    }
    for (const v of ['New York', 'Delaware', 'England and Wales', 'Norway', 'evaluating a pilot', 'Nottingham']) {
      expect(isAbsentValue(v), v).toBe(false)
    }
  })
})

describe('a legal choice read from a request', () => {
  it('is kept when its words name it', () => {
    expect(namesAValue('governingLaw', 'New York', 'It should be governed by New York law.')).toBe(true)
    expect(namesAValue('governingLaw', 'New York', 'New York law, not Delaware law')).toBe(true)
    expect(namesAValue('venueLocation', 'London', 'courts of London')).toBe(true)
  })

  it('is dropped when the value or its words say there is none', () => {
    expect(namesAValue('governingLaw', 'no law', 'QA NDA no law')).toBe(false)
    expect(namesAValue('governingLaw', 'Delaware', 'QA NDA no law')).toBe(false)
    expect(namesAValue('governingLaw', 'New York', 'governing law not specified')).toBe(false)
    expect(namesAValue('governingLaw', 'Delaware', 'not Delaware law')).toBe(false)
    expect(namesAValue('jurisdiction', 'TBD', 'jurisdiction TBD')).toBe(false)
  })

  it('other values are only dropped when they say there is none', () => {
    expect(namesAValue('purpose', 'a partnership with no exclusivity', 'for a partnership with no exclusivity')).toBe(true)
    expect(namesAValue('purpose', 'TBD', 'purpose TBD')).toBe(false)
  })
})
