import { describe, it, expect } from 'vitest'
import { runLine, statusMeaning, fixable, exceptionLine, type ReviewFindingView } from './review'

const run = (over: Record<string, unknown> = {}) => ({ id: 'r', status: 'running', versionNumber: 5, failedStepLabel: null, error: null, current: { label: 'reading its fields and clauses', index: 1, of: 4 }, stuck: false, ...over }) as never

describe('runLine (docs/41 P1)', () => {
  it('says the analysis is for an older version, and that it is being redone', () => {
    expect(runLine({ analysis: { kind: 'stale', analysedVersionNumber: 4 }, versionNumber: 5, run: null, stale: { analysedVersionNumber: 4, run: run() } }))
      .toEqual({ text: 'Analysis is for v4 — v5 has changes. Re-analysing…', canRetry: false })
    expect(runLine({ analysis: { kind: 'stale', analysedVersionNumber: 4 }, versionNumber: 5, run: null, stale: { analysedVersionNumber: 4, run: null } }))
      .toEqual({ text: 'Analysis is for v4 — v5 has changes.', canRetry: true })
  })
  it('names the step a run is on, and the one a run failed at', () => {
    expect(runLine({ analysis: { kind: 'running' }, versionNumber: 1, run: run(), stale: null })?.text).toBe('Analysing — step 1 of 4, reading its fields and clauses…')
    expect(runLine({ analysis: { kind: 'failed' }, versionNumber: 1, run: run({ status: 'failed', failedStepLabel: 'finding and indexing its clauses', error: 'No clauses found' }), stale: null }))
      .toEqual({ text: 'The analysis failed while finding and indexing its clauses. No clauses were found in the document.', canRetry: true })
    // 41 browser QA — never the stored error's JSON.
    expect(runLine({ analysis: { kind: 'failed' }, versionNumber: 1, run: run({ status: 'failed', failedStepLabel: 'reading its fields and clauses', error: 'Failed while saving what was read (attempt 3 of 3): the contract\'s fields were refused (422): {"type":"about:blank","status":422}' }), stale: null })?.text)
      .toBe('The analysis failed while reading its fields and clauses. What it read couldn’t be saved.')
  })
  it('says nothing when the analysis is done for this version', () => {
    expect(runLine({ analysis: { kind: 'done' }, versionNumber: 1, run: run({ status: 'done', current: null }), stale: null })).toBeNull()
  })
})

describe('statuses', () => {
  it('what blocks reads as risk, what needs a look as your turn, the rest calm', () => {
    expect(statusMeaning('deleted')).toBe('risk')
    expect(statusMeaning('changed')).toBe('turn')
    expect(statusMeaning('standard')).toBe('binding')
    expect(statusMeaning('not_covered')).toBe('neutral')
  })
  it('a batch fix covers the findings a rewrite can fix', () => {
    const f = (actions: string[]) => ({ id: actions.join(), actions }) as unknown as ReviewFindingView
    expect(fixable([f(['redline', 'accept']), f(['insert_standard']), f(['resolve'])]).map(x => x.id)).toEqual(['redline,accept'])
  })
})

describe('exceptionLine (docs/41 Part 7)', () => {
  it('says who a requested exception waits for, or the clause approver when the name is not known', () => {
    expect(exceptionLine('exception_requested', null, 'Priya Shah')).toBe('Exception requested — waiting for Priya Shah')
    expect(exceptionLine('exception_requested', null, null)).toBe('Exception requested — waiting for the clause approver')
  })
  it('says what was decided, by whom, with the comment', () => {
    expect(exceptionLine('exception_approved', { decidedBy: null, comment: null })).toBe('Exception approved')
    expect(exceptionLine('exception_declined', { decidedBy: 'Priya', comment: 'Keep the cap' })).toBe('Exception declined by Priya: “Keep the cap”')
  })
  it('says nothing for a finding with no exception', () => {
    expect(exceptionLine('open')).toBeNull()
  })
})
