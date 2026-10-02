import { describe, it, expect } from 'vitest'
import { analysisLine } from './analysis-state'

const stamp = (versionId: string, versionNumber: number, clauses = 4) => ({ _analysis: { versionId, versionNumber, at: '2026-10-01T00:00:00Z', clauses, baselineVersionId: null } })

describe('analysisLine (docs/41 P0.1)', () => {
  it('DONE with no stamp is not analysed — the old DONE-unread contracts', () => {
    const l = analysisLine({ analysisStatus: 'DONE', currentVersionId: 'v1', metadata: {} })
    expect(l).toMatchObject({ state: 'not_analysed', text: 'Not analysed', canAnalyse: true })
  })

  it('NOT_ANALYSED gives its reason', () => {
    const l = analysisLine({ analysisStatus: 'NOT_ANALYSED', analysisError: 'The document has no text to analyse yet.', currentVersionId: 'v1', metadata: {} })
    expect(l.detail).toBe('The document has no text to analyse yet.')
  })

  it('done for the version it read', () => {
    expect(analysisLine({ analysisStatus: 'DONE', currentVersionId: 'v4', metadata: stamp('v4', 4) }).text).toBe('Analysed · v4')
  })

  it('stale once the contract stands on a newer version', () => {
    const l = analysisLine({ analysisStatus: 'DONE', currentVersionId: 'v5', metadata: stamp('v4', 4) }, { currentVersionNumber: 5 })
    expect(l).toMatchObject({ state: 'stale', text: 'Analysis is for v4 — v5 has changes', canAnalyse: true })
  })

  it('failed names the step', () => {
    const l = analysisLine({ analysisStatus: 'FAILED', analysisError: 'Failed while reading its fields and clauses (attempt 3 of 3): timeout', currentVersionId: 'v1', metadata: {} })
    expect(l.text).toBe('Analysis failed at reading its fields and clauses')
    const none = analysisLine({ analysisStatus: 'FAILED', analysisError: 'No clauses found — the document may not be a contract', currentVersionId: 'v1', metadata: {} })
    expect(none.text).toBe('Analysis failed at finding its clauses')
  })

  it('running', () => {
    expect(analysisLine({ analysisStatus: 'EXTRACTING', currentVersionId: 'v1', metadata: stamp('v1', 1) }).state).toBe('running')
  })
})
