/**
 * docs/41 browser QA — a request's words decide a legal choice only when they
 * name one: "QA NDA no law" was read as asking for the governing law "no law".
 */
import { describe, it, expect } from 'vitest'
import { isAbsentValue, namesAValue, fitToSentence, gerund } from './request-values.js'

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

describe('a purpose fits "in connection with {{purpose}}"', () => {
  it('a bare verb becomes its -ing form', () => {
    expect(fitToSentence('purpose', 'evaluate a 12-month data-sharing pilot')).toBe('evaluating a 12-month data-sharing pilot')
    expect(fitToSentence('purpose', 'to explore a reseller partnership')).toBe('exploring a reseller partnership')
    expect(fitToSentence('purpose', 'Discuss a merger')).toBe('discussing a merger')
    expect(fitToSentence('purposeOfDisclosure', 'run a pilot')).toBe('running a pilot')
    expect(fitToSentence('purpose', 'pilot the new API')).toBe('piloting the new API')
  })

  it('a noun phrase, a noun that is also a verb, and other keys stay as read', () => {
    expect(fitToSentence('purpose', 'evaluating a pilot')).toBe('evaluating a pilot')
    expect(fitToSentence('purpose', 'a potential partnership')).toBe('a potential partnership')
    expect(fitToSentence('purpose', 'pilot program for logistics')).toBe('pilot program for logistics')
    expect(fitToSentence('purpose', 'review of the vendor')).toBe('review of the vendor')
    expect(fitToSentence('scope', 'evaluate a pilot')).toBe('evaluate a pilot')
  })

  it('makes the -ing form', () => {
    expect(['evaluate', 'see', 'tie', 'plan', 'share', 'test'].map(gerund)).toEqual(['evaluating', 'seeing', 'tying', 'planning', 'sharing', 'testing'])
  })
})
