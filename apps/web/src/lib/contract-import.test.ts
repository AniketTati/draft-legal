/**
 * docs/39 A16 — the import wizard's working out: documents matched to rows,
 * how a column reads as its field, a column's distinct words.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogField, ImportTarget } from '@clm/types'
import { chunks, distinctValues, isDocumentFile, isSheetFile, matchDocuments, readColumn, statusValuesOf, typeValuesOf } from './contract-import'

const T: Array<ImportTarget | null> = [{ kind: 'title' }, { kind: 'file' }, null]

describe('documents matched to rows', () => {
  it('by the file-name column: exactly, else by the name without its extension and punctuation', () => {
    const rows = [['Acme MSA', 'Acme_MSA.pdf', ''], ['Globex DPA', 'scans/globex dpa.DOCX', ''], ['Initech', 'initech.pdf', ''], ['Hooli', '', '']]
    const m = matchDocuments(rows, T, ['acme_msa.pdf', 'Globex-DPA.docx', 'Stray.pdf'])
    expect(m.fileOf).toEqual(['acme_msa.pdf', 'Globex-DPA.docx', null, null])
    expect(m.unmatched).toEqual(['Stray.pdf'])
    expect(m.missing).toEqual([2])
  })

  it('without one, by a title the same as a document’s name; a document goes with one row only', () => {
    const rows = [['Acme MSA'], ['Acme MSA'], ['Globex']]
    const m = matchDocuments(rows, [{ kind: 'title' }], ['Acme MSA.pdf', 'Other.pdf'])
    expect(m.fileOf).toEqual(['Acme MSA.pdf', null, null])
    expect(m.unmatched).toEqual(['Other.pdf'])
    expect(m.missing).toEqual([])
  })
})

describe('a column', () => {
  const date: CatalogField = { key: 'effectiveDate', label: 'Effective date', type: 'date', kind: 'core', contractTypes: null }
  const value: CatalogField = { key: 'value', label: 'Contract value', type: 'number', kind: 'core', contractTypes: null }
  const rows = [['2024-03-01', 'USD 250,000', 'x@y.co', 'DPA', 'Signed'], ['TBD', '€12,000', 'nobody', 'Lease', 'Approved'], ['', '', '', '', ''], ['03/04/2025', 'n/a', '', 'DPA', 'On hold']]

  it('reads as its field (dates in the org’s order, an amount with its currency), and says which cells don’t', () => {
    expect(readColumn(rows, 0, { kind: 'field', key: 'effectiveDate' }, date, 'DMY')).toEqual({ filled: 3, read: 2, unreadable: ['TBD'] })
    expect(readColumn(rows, 1, { kind: 'field', key: 'value' }, value, 'MDY')).toEqual({ filled: 3, read: 2, unreadable: ['n/a'] })
    expect(readColumn(rows, 2, { kind: 'owner' }, undefined, 'MDY')).toEqual({ filled: 2, read: 1, unreadable: ['nobody'] })
    expect(readColumn(rows, 3, { kind: 'type' }, undefined, 'MDY')).toEqual({ filled: 3, read: 2, unreadable: ['Lease'] })
    expect(readColumn(rows, 4, { kind: 'status' }, undefined, 'MDY')).toEqual({ filled: 3, read: 2, unreadable: ['On hold'] })
  })

  it('of types or statuses lists its words, most used first, each read as the app reads it', () => {
    expect(distinctValues(rows, 3)).toEqual([{ value: 'DPA', count: 2 }, { value: 'Lease', count: 1 }])
    expect(typeValuesOf(rows, 3)).toEqual({ DPA: 'DATA_PROCESSING', Lease: 'OTHER' })
    expect(statusValuesOf(rows, 4)).toEqual({ Signed: 'EXECUTED', Approved: 'DRAFT', 'On hold': 'DRAFT' })
  })
})

describe('files', () => {
  it('are a spreadsheet or a document by their extension', () => {
    expect(isSheetFile('Contracts.XLSX')).toBe(true)
    expect(isSheetFile('export.csv')).toBe(true)
    expect(isDocumentFile('Acme.pdf')).toBe(true)
    expect(isDocumentFile('scan.TIFF')).toBe(true)
    expect(isDocumentFile('Contracts.xlsx')).toBe(false)
  })

  it('go a run at a time', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})
