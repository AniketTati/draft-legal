/**
 * Tests for the costCap helpers (P7.5.2).
 *
 * Focused on the pure-function pieces: estimateCostUsd. Redis-backed
 * pieces (recordCost / getDailyCost) are integration tests that need
 * a live Redis — covered in scripts/archive/p75-2-verify.mjs.
 */
import { describe, it, expect } from 'vitest'
import { estimateCostUsd } from './costCap.js'

describe('estimateCostUsd', () => {
  it('returns 0-ish for an empty string', () => {
    expect(estimateCostUsd(0)).toBe(0)
    expect(estimateCostUsd(1)).toBeLessThan(0.0001)
  })

  it('scales roughly linearly with input size', () => {
    const small = estimateCostUsd(1_000)
    const big = estimateCostUsd(10_000)
    expect(big).toBeGreaterThan(small * 9)
    expect(big).toBeLessThan(small * 11)
  })

  it('produces a sane number for a 30-page contract (~75k chars)', () => {
    const cost = estimateCostUsd(75_000)
    // Should be in the cents-range, not dollars or fractions of a cent
    expect(cost).toBeGreaterThan(0.01)
    expect(cost).toBeLessThan(1.0)
  })

  it('rounds to 6 decimal places', () => {
    const cost = estimateCostUsd(1_234)
    const str = cost.toString()
    const decimals = str.split('.')[1] ?? ''
    expect(decimals.length).toBeLessThanOrEqual(6)
  })
})
