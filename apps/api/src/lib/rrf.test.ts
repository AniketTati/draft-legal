/**
 * Tests for the Reciprocal Rank Fusion core (issue #9).
 *
 * Pure functions — no infra needed. Covers the cases the issue called
 * out (empty inputs, single-source, the standard k constant) plus the
 * two behaviours the search routes depend on: multi-source score
 * summing and per-list dedupe that preserves first-seen rank.
 */
import { describe, it, expect } from 'vitest'
import { RRF_K, rrfScore, fuseRRF } from './rrf.js'

describe('RRF_K', () => {
  it('is the standard 60 constant', () => {
    expect(RRF_K).toBe(60)
  })
})

describe('rrfScore', () => {
  it('uses 1 / (k + rank + 1) with the default k', () => {
    expect(rrfScore(0)).toBe(1 / 61)
    expect(rrfScore(1)).toBe(1 / 62)
    expect(rrfScore(9)).toBe(1 / 70)
  })

  it('honours a custom k', () => {
    expect(rrfScore(0, 10)).toBe(1 / 11)
    expect(rrfScore(4, 0)).toBe(1 / 5)
  })

  it('decreases monotonically as rank grows', () => {
    expect(rrfScore(0)).toBeGreaterThan(rrfScore(1))
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2))
  })
})

describe('fuseRRF', () => {
  it('returns [] for no lists and for all-empty lists', () => {
    expect(fuseRRF([])).toEqual([])
    expect(fuseRRF([[], []])).toEqual([])
  })

  it('ranks a single source in list order with 1/(k+rank+1) scores', () => {
    const out = fuseRRF([['a', 'b', 'c']])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(out[0].score).toBeCloseTo(1 / 61, 12)
    expect(out[1].score).toBeCloseTo(1 / 62, 12)
    expect(out[2].score).toBeCloseTo(1 / 63, 12)
  })

  it('sums contributions across sources so a shared hit outranks singletons', () => {
    // 'b' appears in both lists → 1/61 + 1/62; 'a' and 'c' appear once.
    const out = fuseRRF([
      ['a', 'b'],
      ['b', 'c'],
    ])
    expect(out.map(r => r.id)).toEqual(['b', 'a', 'c'])
    const b = out.find(r => r.id === 'b')!
    expect(b.score).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(out.find(r => r.id === 'a')!.score).toBeCloseTo(1 / 61, 12)
    expect(out.find(r => r.id === 'c')!.score).toBeCloseTo(1 / 62, 12)
  })

  it('counts a duplicate id within a list once, at its first-seen rank', () => {
    // 'a' repeats; 'b' sits at index 2 and must keep rank 2 (not compact to 1).
    const out = fuseRRF([['a', 'a', 'b']])
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.find(r => r.id === 'a')!.score).toBeCloseTo(rrfScore(0), 12)
    expect(out.find(r => r.id === 'b')!.score).toBeCloseTo(rrfScore(2), 12)
  })

  it('skips falsy ids but still consumes their rank position', () => {
    // undefined at index 1 is dropped, yet 'b' at index 2 stays rank 2.
    const out = fuseRRF([['a', undefined, 'b', null, '']])
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.find(r => r.id === 'b')!.score).toBeCloseTo(rrfScore(2), 12)
  })

  it('breaks score ties by first-seen order (list 0 before list 1)', () => {
    // 'a' (list 0) and 'b' (list 1) both score exactly 1/61.
    const out = fuseRRF([['a'], ['b']])
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
    expect(out[0].score).toBe(out[1].score)
  })

  it('applies a custom k throughout', () => {
    const out = fuseRRF([['x']], 10)
    expect(out[0].score).toBe(1 / 11)
  })
})
