/**
 * X16 follow-up — a binder is split where its agreements start. The detector
 * reports each one's offset in the text (`charStart`, absolute since X16),
 * but the split used only its "~page N" guesses: a text sample has no page
 * numbers, so a 13-page binder whose second agreement starts on page 13 was
 * split evenly, at page 7, and half the first agreement went into the second.
 */
import { describe, it, expect } from 'vitest'
import { docsToSplitSpecs } from './binder-pages.js'

const msa = { title: 'MASTER SERVICES AGREEMENT', docType: 'MSA' }
const sow = { title: 'STATEMENT OF WORK NO. 1', docType: 'SOW' }

describe('docsToSplitSpecs', () => {
  it('places each agreement by its offset in the text, as in the live 13-page binder', () => {
    const docs = [{ ...msa, charStart: 0, pageHint: '~page 1' }, { ...sow, charStart: 42_837, pageHint: '~page 1' }]
    expect(docsToSplitSpecs(docs, 13, 43_570)).toEqual([
      { title: msa.title, type: 'MSA', pageStart: 1, pageEnd: 12 },
      { title: sow.title, type: 'SOW', pageStart: 13, pageEnd: 13 },
    ])
  })

  it('starts an agreement that shares a page with the one before it on the next page', () => {
    const docs = [{ ...msa, charStart: 0 }, { ...sow, charStart: 1_000 }, { title: 'ORDER FORM', docType: 'ORDER_FORM', charStart: 1_200 }]
    expect(docsToSplitSpecs(docs, 10, 20_000).map(s => [s.pageStart, s.pageEnd])).toEqual([[1, 1], [2, 2], [3, 10]])
  })

  it('falls back to the page hints when the offsets are missing, out of order, out of range or start late', () => {
    const hinted = (a: Partial<typeof msa & { charStart: number }>, b: Partial<typeof sow & { charStart: number }>) =>
      docsToSplitSpecs([{ ...msa, pageHint: '~page 1', ...a }, { ...sow, pageHint: '~page 5', ...b }], 10, 20_000).map(s => [s.pageStart, s.pageEnd])
    expect(hinted({}, {})).toEqual([[1, 4], [5, 10]])
    expect(hinted({ charStart: 0 }, { charStart: 0 })).toEqual([[1, 4], [5, 10]])
    expect(hinted({ charStart: 0 }, { charStart: 25_000 })).toEqual([[1, 4], [5, 10]])
    expect(hinted({ charStart: 5_000 }, { charStart: 9_000 })).toEqual([[1, 4], [5, 10]])
  })
})
