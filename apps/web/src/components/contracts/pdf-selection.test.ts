/**
 * docs/39 C1 — a selection in the original PDF: its runs joined as they read,
 * and which of the passages worded alike it is.
 */
import { describe, it, expect } from 'vitest'
import { countIn, joinRuns, pageTextOf, squash, type TextRun } from './pdf-selection'

const run = (text: string, top: number, left: number, width: number): TextRun => ({ text, top, bottom: top + 12, left, right: left + width })

describe('runs of a PDF’s text layer', () => {
  it('read with a space where a line breaks or a gap is left, and none inside a word pdf.js split', () => {
    expect(joinRuns([
      run('Neither party may assign this Agreement without the', 100, 72, 300),
      run('prior written consent of the other party.', 114, 72, 250),
    ])).toBe('Neither party may assign this Agreement without the prior written consent of the other party.')
    expect(joinRuns([run('Agree', 100, 72, 30), run('ment', 100, 102, 25)])).toBe('Agreement')
    expect(joinRuns([run('Section', 100, 72, 40), run('12.', 100, 120, 15)])).toBe('Section 12.')
    expect(joinRuns([run('thirty ', 100, 72, 40), run('(30) days', 100, 112, 50)])).toBe('thirty (30) days')
  })
})

describe('which occurrence a selection is', () => {
  it('counts the matches before it, spacing aside', () => {
    expect(squash('Thirty (30)\n days')).toBe('thirty(30)days')
    expect(countIn(squash('notice of 30 days … within 30 days … 30 days'), squash('30 days'))).toBe(3)
    expect(countIn('aaaa', 'aa')).toBe(2)
    expect(countIn('abc', '')).toBe(0)
    expect(pageTextOf([{ str: 'Payment within ' }, { str: '30 days' }, {}])).toBe('paymentwithin30days')
  })
})
