/**
 * docs/39 A9 — a Word file with tracked changes nobody has accepted: counted,
 * and read two ways (with the changes rejected: agreed; accepted: proposed).
 */
import { describe, it, expect } from 'vitest'
import { readTrackedChanges, trackedChangesOf, viewsOf, viewsFrom, counterpart } from './tracked-changes.js'
import { extractDocument } from './document.js'
import { MIME } from './file-type.js'
import { trackedDocx } from '../test-support/tracked-docx.js'

const REDLINE = [
  'MASTER SERVICES AGREEMENT',
  'Payment. Customer shall pay each invoice within {-thirty (30)-}{+sixty (60)+} days of receipt of the invoice.',
  '{-Termination. Either party may terminate this Agreement on ninety (90) days notice to the other party.-}',
  'Renewal. This Agreement starts on the Effective Date.{+ It renews automatically for successive one (1) year terms.+} Each party signs below.',
  'Governing law. This Agreement is governed by the laws of the State of New York.',
]

describe('a Word file’s tracked changes', () => {
  it('are read as made when the file is read — the reason values were taken as agreed', async () => {
    const { plainText } = await extractDocument(await trackedDocx(REDLINE), MIME.DOCX, 'redline.docx')
    expect(plainText).toContain('within sixty (60) days')
    expect(plainText).not.toContain('thirty (30)')
    expect(plainText).not.toContain('ninety (90) days')
  })

  it('are counted by who made them; a file without any has none', async () => {
    expect(await readTrackedChanges(await trackedDocx(REDLINE, 'Priya Shah'))).toEqual({
      insertions: 2, deletions: 2, byAuthor: { 'Priya Shah': 4 }, comments: 0,
    })
    const clean = await readTrackedChanges(await trackedDocx(['A clean contract.']))
    expect(clean).toEqual({ insertions: 0, deletions: 0, byAuthor: {}, comments: 0 })
    // Counted as none: nothing to say on the page.
    expect(trackedChangesOf({ trackedChanges: clean })).toBeNull()
  })

  it('are read back from a version’s metadata, and nothing else is', () => {
    expect(trackedChangesOf({ trackedChanges: { insertions: 2, deletions: 1, byAuthor: { A: 3 }, comments: 1 } }))
      .toEqual({ insertions: 2, deletions: 1, byAuthor: { A: 3 }, comments: 1 })
    expect(trackedChangesOf({ trackedChanges: { insertions: 0, deletions: 0 } })).toBeNull()
    expect(trackedChangesOf({ structure: {} })).toBeNull()
    expect(trackedChangesOf(null)).toBeNull()
  })

  it('give the file as agreed (changes rejected) and as proposed (accepted)', async () => {
    const { agreed, proposed } = await viewsOf(await trackedDocx(REDLINE))
    expect(agreed).toContain('within thirty (30) days')
    expect(agreed).toContain('ninety (90) days notice')
    expect(agreed).not.toContain('renews automatically')
    expect(proposed).toContain('within sixty (60) days')
    expect(proposed).not.toContain('ninety (90)')
    expect(proposed).toContain('renews automatically for successive one (1) year terms')
  })

  it('place each reading’s words in the other: what they replaced, nothing where they added or took out', async () => {
    const v = await viewsOf(await trackedDocx(REDLINE))
    expect(counterpart(v, 'agreed', 'within sixty (60) days')).toBe('within thirty (30) days')
    // A quote that starts or ends in their words takes in what stood there.
    expect(counterpart(v, 'agreed', 'sixty (60) days of receipt')).toBe('thirty (30) days of receipt')
    expect(counterpart(v, 'agreed', 'It renews automatically for successive one (1) year terms.')).toBe('')
    expect(counterpart(v, 'proposed', 'Either party may terminate this Agreement on ninety (90) days notice to the other party.')).toBe('')
    expect(counterpart(v, 'proposed', 'within thirty (30) days')).toBe('within sixty (60) days')
    // A changed last word comes without its sentence's full stop, as the quote has none.
    expect(counterpart(v, 'agreed', 'the laws of the State of New York')).toBe('the laws of the State of New York')
    const law = viewsFrom('Governed by the laws of the State of Delaware. Signed below.', 'Governed by the laws of the State of New York. Signed below.')
    expect(counterpart(law, 'agreed', 'the laws of the State of New York')).toBe('the laws of the State of Delaware')
    // Words both readings share map to themselves; a quote in neither, to nothing.
    expect(counterpart(v, 'agreed', 'governed by the laws of the State of New York')).toBe('governed by the laws of the State of New York')
    expect(counterpart(v, 'agreed', 'a clause nobody wrote')).toBeNull()
  })

  it('don’t stand a whole rewrite in for a quote', () => {
    const v = viewsFrom(`Start. ${'Alpha beta gamma delta. '.repeat(40)}End.`, `Start. ${'Omega sigma kappa zeta. '.repeat(40)}End.`)
    expect(counterpart(v, 'agreed', 'Omega sigma kappa zeta.')).toBeNull()
  })
})
