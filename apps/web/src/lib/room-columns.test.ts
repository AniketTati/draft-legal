/**
 * docs/39 D6 — a room question's likely form and column name, who an answer
 * came from, and a choice list typed as one line.
 */
import { describe, it, expect } from 'vitest'
import { answerSource, choicesFrom, guessAnswerType, labelFromQuestion, runUnderWay, type ColumnRun } from './room-columns'

describe('a question’s likely form', () => {
  it('follows how it is asked', () => {
    expect(guessAnswerType('Can the supplier assign without consent?')).toBe('boolean')
    expect(guessAnswerType('Is there a change of control clause?')).toBe('boolean')
    expect(guessAnswerType('How long is the notice to terminate for convenience?')).toBe('duration')
    expect(guessAnswerType('What is the cure period for a breach?')).toBe('duration')
    expect(guessAnswerType('How much is the liability cap?')).toBe('currency')
    expect(guessAnswerType('How many renewals are allowed?')).toBe('number')
    expect(guessAnswerType('What percentage discount does the reseller get?')).toBe('percentage')
    expect(guessAnswerType('When does the agreement expire?')).toBe('date')
    expect(guessAnswerType('Which law governs the agreement?')).toBe('text')
    expect(guessAnswerType('Who owns the IP in deliverables?')).toBe('text')
  })
})

describe('a question’s column name', () => {
  it('is the question — its little words dropped when long — shortened at a word, as the API names it', () => {
    expect(labelFromQuestion('Is there a change of control clause?')).toBe('Is there a change of control clause?')
    expect(labelFromQuestion('Can the supplier assign the agreement without our consent?')).toBe('Can supplier assign agreement without consent?')
    expect(labelFromQuestion('Can the supplier assign the agreement without the customer’s consent?')).toBe('Can supplier assign agreement without customer’s…')
  })
})

describe('who an answer came from', () => {
  it('says the AI, how sure, or who checked it', () => {
    expect(answerSource('question', { state: 'answered', source: 'ai', checked: false, confidence: 0.82 })).toBe('AI · 82% sure')
    expect(answerSource('question', { state: 'answered', source: 'ai', checked: true, confidence: 0.82 })).toBe('AI · confirmed by a person')
    expect(answerSource('question', { state: 'answered', source: 'user', checked: true, confidence: null })).toBe('Answered by a person')
    // "30% sure it doesn't say" means nothing to a reader: it says what the AI found.
    expect(answerSource('question', { state: 'none', source: 'ai', checked: false, confidence: 0.3 })).toBe('AI · found nothing on it in the document')
    expect(answerSource('field', { state: 'answered', source: 'highlight', checked: false, confidence: 1 })).toBe('Picked from the text by a person')
    expect(answerSource('field', { state: 'answered', source: 'ai', checked: true, confidence: 0.9 })).toBe('Checked by a person')
  })
})

describe('choices typed as one line', () => {
  it('are each, trimmed, once, as first typed', () => {
    expect(choicesFrom(' Allowed, needs consent ;Not allowed, allowed,, ')).toEqual(['Allowed', 'needs consent', 'Not allowed'])
  })
})

describe('a column’s run', () => {
  it('is under way only while queued or running and heard from', () => {
    const run: ColumnRun = { token: 't', status: 'RUNNING', scope: 'missing', processed: 1, answered: 1, failed: 0, total: 3, error: null, updatedAt: new Date().toISOString() }
    expect(runUnderWay(run)).toBe(true)
    expect(runUnderWay({ ...run, status: 'DONE' })).toBe(false)
    expect(runUnderWay({ ...run, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() })).toBe(false)
    expect(runUnderWay(null)).toBe(false)
  })
})
