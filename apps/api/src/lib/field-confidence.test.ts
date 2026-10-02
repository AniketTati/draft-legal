/**
 * docs/39 B3 — the confidence to decide by: the model's number, held down by
 * what can be checked.
 */
import { describe, it, expect } from 'vitest'
import { checkBelow, isChecked, verificationState } from '@clm/types'
import { accuracyCap, computedConfidence, NO_QUOTE_CAP, ISSUE_CAP, GONE_CAP } from './field-confidence.js'

const ai = { source: 'ai', verifiedAt: null, model: 0.95, quote: 'net thirty (30) days', issue: null, gone: false, hasValue: true, value: 30 }

describe('computedConfidence', () => {
  it('is the model’s number when everything checks out', () => {
    expect(computedConfidence(ai)).toEqual({ confidence: 0.95, reasons: [] })
  })

  it('is held down by a missing quote, a flag and words that are gone — saying why', () => {
    const r = computedConfidence({ ...ai, quote: null })
    expect(r.confidence).toBe(NO_QUOTE_CAP)
    expect(r.reasons).toEqual(['It quotes no passage of the contract'])
    expect(computedConfidence({ ...ai, issue: 'Written "03/04/2025": read as 4 March' }).confidence).toBe(ISSUE_CAP)
    expect(computedConfidence({ ...ai, gone: true }).confidence).toBe(GONE_CAP)
  })

  it('needs no quote for a clause that isn’t there', () => {
    expect(computedConfidence({ ...ai, quote: null, value: false }).confidence).toBe(0.95)
  })

  it('is as sure as the field has been right, from five checks on', () => {
    expect(accuracyCap({ confirmed: 3, corrected: 1 })).toBeNull()
    expect(accuracyCap({ confirmed: 6, corrected: 4 })).toBe(0.6)
    expect(accuracyCap({ confirmed: 99, corrected: 1 })).toBeNull()
    const r = computedConfidence(ai, { confirmed: 6, corrected: 4 })
    expect(r.confidence).toBe(0.6)
    expect(r.reasons).toEqual(['People corrected this field on 4 of the 10 contracts they checked'])
  })

  it('leaves a person’s value, a checked one and “not found” as they are', () => {
    expect(computedConfidence({ ...ai, source: 'user', quote: null, model: 1 }).confidence).toBe(1)
    expect(computedConfidence({ ...ai, verifiedAt: new Date(), quote: null }).confidence).toBe(0.95)
    expect(computedConfidence({ ...ai, hasValue: false, value: null, quote: null, model: 0.9 }).confidence).toBe(0.9)
  })
})

describe('check levels and verification', () => {
  it('checks a field always, when unsure, or only when very unsure', () => {
    expect(checkBelow('always')).toBeNull()
    expect(checkBelow('unsure')).toBe(0.7)
    expect(checkBelow('rarely')).toBe(0.4)
    expect(checkBelow(undefined)).toBe(0.7)
  })

  it('says what a person checked', () => {
    expect(isChecked({ source: 'ai', verifiedAt: null })).toBe(false)
    expect(isChecked({ source: 'ai', verifiedAt: '2026-09-27T00:00:00Z' })).toBe(true)
    expect(isChecked({ source: 'highlight', verifiedAt: null })).toBe(true)
    expect(verificationState(0, 0)).toBe('empty')
    expect(verificationState(0, 4)).toBe('unverified')
    expect(verificationState(2, 4)).toBe('partly')
    expect(verificationState(4, 4)).toBe('verified')
  })
})
