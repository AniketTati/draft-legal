/**
 * docs/39 D6 — a question's answer read in the form the column asks for, and
 * doubted the way a field's value is; a question's column name.
 */
import { describe, it, expect } from 'vitest'
import { labelFromQuestion, readAnswer, roomColumns, runUnderWay, freshRun } from './diligence-columns.js'

const QUOTE = 'The Supplier shall give not less than thirty (30) days’ written notice.'

describe('an answer, in the column’s form', () => {
  it('is parsed as a field of that type would be', () => {
    expect(readAnswer({ answerType: 'duration' }, { value: 'thirty days', confidence: 0.9, quote: QUOTE })).toMatchObject({ value: { value: 30, unit: 'days' }, display: '30 days', confidence: 0.9, quote: QUOTE })
    expect(readAnswer({ answerType: 'currency' }, { value: 'USD 250,000', confidence: 0.8, quote: QUOTE }).value).toEqual({ amount: 250000, currency: 'USD' })
    expect(readAnswer({ answerType: 'date' }, { value: '2025-03-01', confidence: 0.8, quote: QUOTE }).display).toBe('Mar 1, 2025')
    expect(readAnswer({ answerType: 'select', options: ['Allowed', 'Needs consent'] }, { value: 'needs CONSENT', confidence: 0.8, quote: QUOTE }).value).toBe('Needs consent')
    expect(readAnswer({ answerType: 'boolean' }, { value: 'yes', confidence: 0.8, quote: QUOTE }).display).toBe('Yes')
  })

  it('that doesn’t fit the form is kept as the AI said it, and doubted', () => {
    const a = readAnswer({ answerType: 'date' }, { value: 'Upon signature by both parties', confidence: 0.9, quote: QUOTE })
    expect(a).toMatchObject({ value: null, display: 'Upon signature by both parties', confidence: 0.4 })
    expect(a.issue).toBe('The AI answered “Upon signature by both parties”, which isn\'t a date.')
    expect(readAnswer({ answerType: 'select', options: ['A', 'B'] }, { value: 'C', confidence: 0.9 }).issue).toContain('isn\'t one of the choices')
  })

  it('without words to show for it is doubted — but a plain "no" can stand alone', () => {
    expect(readAnswer({ answerType: 'text' }, { value: 'Delaware', confidence: 0.95 }).confidence).toBe(0.65)
    expect(readAnswer({ answerType: 'boolean' }, { value: true, confidence: 0.95 }).confidence).toBe(0.65)
    expect(readAnswer({ answerType: 'boolean' }, { value: false, confidence: 0.95 }).confidence).toBe(0.95)
    // A quote the agents service found not word for word keeps its issue.
    expect(readAnswer({ answerType: 'text' }, { value: 'Delaware', confidence: 0.5, quote: 'laws of Delaware', issue: 'Its quote isn\'t in the document word for word.' }).issue).toContain('word for word')
  })

  it('that is empty says the document doesn’t answer it', () => {
    expect(readAnswer({ answerType: 'text' }, { value: null, confidence: 0.3 })).toEqual({ value: null, display: '', quote: null, confidence: 0.3, issue: null })
    expect(readAnswer({ answerType: 'text' }, undefined)).toEqual({ value: null, display: '', quote: null, confidence: null, issue: null })
    expect(readAnswer({ answerType: 'number' }, { value: '  ', confidence: 0.3 }).display).toBe('')
  })
})

describe('a question’s column name', () => {
  it('is the question — its little words dropped when it’s long — shortened at a word', () => {
    expect(labelFromQuestion('Is there a change of control clause?')).toBe('Is there a change of control clause?')
    expect(labelFromQuestion('Can the supplier assign the agreement without our consent?')).toBe('Can supplier assign agreement without consent?')
    expect(labelFromQuestion('Can the supplier assign the agreement without the customer’s consent?')).toBe('Can supplier assign agreement without customer’s…')
    expect(labelFromQuestion('The notice period for termination for convenience by either side?')).toBe('Notice period for termination for convenience by…')
    expect(labelFromQuestion('x'.repeat(60))).toBe(`${'x'.repeat(48)}…`)
  })
})

describe('a room’s columns as stored', () => {
  it('leave out anything malformed', () => {
    expect(roomColumns([
      { id: 'a', label: 'Law', kind: 'field', key: 'governingLaw' },
      { id: 'b', label: 'Q', kind: 'question', question: 'Why?', answerType: 'text' },
      { id: 'c', label: 'Q', kind: 'question', question: 'Why?', answerType: 'colour' },
      { id: 'd', kind: 'field', key: 'x' },
      null,
    ]).map(c => c.id)).toEqual(['a', 'b'])
    expect(roomColumns({})).toEqual([])
  })

  it('count a run as under way only while it is heard from', () => {
    const run = freshRun('missing', 'u1')
    expect(runUnderWay(run)).toBe(true)
    expect(runUnderWay({ ...run, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() })).toBe(false)
    expect(runUnderWay({ ...run, status: 'PAUSED' })).toBe(false)
    expect(runUnderWay(null)).toBe(false)
    // Each run is its own: a new token every time.
    expect(freshRun('missing', 'u1').token).not.toBe(run.token)
  })
})
