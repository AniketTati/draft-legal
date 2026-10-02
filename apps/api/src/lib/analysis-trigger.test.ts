import { describe, it, expect, afterEach } from 'vitest'
import { checkpointDelayMs, wordCount, MIN_WORDS_FOR_CLAUSES } from './analysis-trigger.js'
import { clausesChanged } from './version-refresh.js'
import { analysisState, failedStep } from '@clm/types'

describe('analysis trigger helpers (docs/41 P0.1)', () => {
  afterEach(() => { delete process.env.ANALYSIS_CHECKPOINT_MS })

  it('checkpoints default to two minutes, and 0 turns them off', () => {
    expect(checkpointDelayMs()).toBe(120_000)
    process.env.ANALYSIS_CHECKPOINT_MS = '0'
    expect(checkpointDelayMs()).toBe(0)
    process.env.ANALYSIS_CHECKPOINT_MS = 'nonsense'
    expect(checkpointDelayMs()).toBe(120_000)
  })

  it('a deleted clause counts as a change', () => {
    expect(clausesChanged({ changed: 0, dropped: 1 })).toBe(true)
    expect(clausesChanged({ changed: 2, dropped: 0 })).toBe(true)
    expect(clausesChanged({ changed: 0, dropped: 0 })).toBe(false)
    expect(clausesChanged(null)).toBe(false)
  })

  it('counts words', () => {
    expect(wordCount('  one two\nthree ')).toBe(3)
    expect(wordCount(null)).toBe(0)
    expect(MIN_WORDS_FOR_CLAUSES).toBeGreaterThan(50)
  })

  it('analysisState never reads DONE without a stamp as analysed', () => {
    expect(analysisState({ analysisStatus: 'DONE', currentVersionId: 'v1', metadata: {} }).kind).toBe('not_analysed')
    expect(analysisState({ analysisStatus: 'NOT_ANALYSED', currentVersionId: 'v1', metadata: { _analysis: { versionId: 'v1' } } }).kind).toBe('not_analysed')
  })

  it('failedStep reads the extraction job\'s message', () => {
    expect(failedStep('Failed while saving what was read (attempt 1 of 3): refused')).toBe('saving what was read')
    expect(failedStep('Search indexing failed: boom')).toBe('building the search index')
    expect(failedStep('something else')).toBeNull()
  })
})
