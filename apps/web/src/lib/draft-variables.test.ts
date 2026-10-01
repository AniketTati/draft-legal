import { describe, it, expect } from 'vitest'
import { labelOfKey, noteOf, variableRows, wordsForField } from './draft-variables'

const place = (key: string, text: string, from: number, unfilled = false) => ({ key, text, from, to: from + text.length, unfilled })

describe('variableRows (docs/39 H2)', () => {
  it('lists each variable once, in the order the text uses them, named by the server when it has', () => {
    const rows = variableRows(
      [place('client', 'Initech', 1), place('fees', '[[fees]]', 20, true), place('client', 'Initech', 40)],
      [{ key: 'client', label: 'Client', type: 'text', field: null }],
    )
    expect(rows.map(r => [r.key, r.label, r.text, r.places.length, r.unfilled])).toEqual([
      ['client', 'Client', 'Initech', 2, false],
      ['fees', 'Fees', '[[fees]]', 1, true],
    ])
  })

  it('takes the words most places have, and counts the places that differ', () => {
    const [r] = variableRows([place('client', 'Initech LLC', 1), place('client', 'Initech', 30), place('client', 'Initech', 60)])
    expect(r).toMatchObject({ text: 'Initech', differs: 1, unfilled: false })
    // A tie keeps the first place's words.
    expect(variableRows([place('a', 'x', 1), place('a', 'y', 5)])[0].text).toBe('x')
  })

  it('writes a field’s date the way the text already writes it, and anything else as the field shows it', () => {
    const july = { value: '2026-07-05', display: 'Jul 5, 2026' }
    expect(wordsForField('1 June 2026', july)).toBe('5 July 2026')
    expect(wordsForField('1st June, 2026', july)).toBe('5th July 2026')
    expect(wordsForField('June 1, 2026', july)).toBe('July 5, 2026')
    expect(wordsForField('Jun. 1, 2026', july)).toBe('Jul 5, 2026')
    expect(wordsForField('2026-06-01', july)).toBe('2026-07-05')
    expect(wordsForField('01/06/2026', july, 'DMY')).toBe('05/07/2026')
    expect(wordsForField('6/1/2026', july, 'MDY')).toBe('7/5/2026')
    // A blank, or words that aren't a date: in full, the org's way.
    expect(wordsForField('[[effective_date]]', july, 'DMY')).toBe('5 July 2026')
    expect(wordsForField('TBC', july)).toBe('July 5, 2026')
    expect(wordsForField('3 years 2026', july)).toBe('July 5, 2026')
    expect(wordsForField('Initech', { value: 'Globex Inc', display: 'Globex Inc' })).toBe('Globex Inc')
    expect(wordsForField('3 years', { value: { value: 5, unit: 'years' }, display: '5 years' })).toBe('5 years')
  })

  it('names a variable from its key, and notes a change for the version list', () => {
    expect(labelOfKey('customer_name')).toBe('Customer name')
    expect(labelOfKey('poNumber')).toBe('PO number')
    expect(noteOf('Client', 'Initech LLC', 3)).toBe('Changed Client to “Initech LLC” (3 places)')
    expect(noteOf('Fees', 'x'.repeat(80), 1)).toBe(`Changed Fees to “${'x'.repeat(57)}…”`)
  })
})
