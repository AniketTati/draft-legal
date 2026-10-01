/**
 * docs/39 A16 — a spreadsheet's words for types and statuses read as the app
 * knows them, and which field a column's header names.
 */
import { describe, it, expect } from 'vitest'
import { CORE_FIELDS, readContractStatus, readContractType, suggestImportTarget, type CatalogField } from '@clm/types'
import { titleFromFile } from './contract-import.js'

const CATALOG: CatalogField[] = [
  ...CORE_FIELDS.filter(f => !f.legacy).map(f => ({ key: f.key, label: f.label, type: f.type, kind: 'core' as const, contractTypes: null })),
  { key: 'deliverables', label: 'Deliverables', type: 'text', kind: 'type', contractTypes: ['SOW'] },
  { key: 'po_number', label: 'PO number', type: 'text', kind: 'custom', contractTypes: null },
]

describe('a spreadsheet’s contract type', () => {
  it('is the shared type it names — exactly, or in a longer name', () => {
    const t = (s: string) => readContractType(s)?.type
    expect(t('DPA')).toBe('DATA_PROCESSING')
    expect(t('Data Processing Addendum')).toBe('DATA_PROCESSING')
    expect(t('data_processing')).toBe('DATA_PROCESSING')
    expect(t('Mutual Non-Disclosure Agreement')).toBe('NDA')
    expect(t('Master Services Agreement')).toBe('MSA')
    expect(t('Statement of Work #3')).toBe('SOW')
    expect(t('Vendor')).toBe('VENDOR_AGREEMENT')
    expect(t('Supply agreement')).toBe('VENDOR_AGREEMENT')
    expect(t('Reseller Agreement')).toBe('PARTNERSHIP')
    expect(t('Order Form')).toBe('ORDER_FORM')
    expect(t('SaaS Subscription')).toBe('LICENSE')
    expect(t('Service Level Agreement')).toBe('SLA')
  })

  it('that names none is Other, said; a blank is no type at all', () => {
    expect(readContractType('Lease')).toEqual({ type: 'OTHER', known: false })
    expect(readContractType('Other')).toEqual({ type: 'OTHER', known: true })
    expect(readContractType('  ')).toBeNull()
  })
})

describe('a spreadsheet’s status', () => {
  it('is the status it means', () => {
    const s = (x: string) => readContractStatus(x)?.status
    expect(s('Signed')).toBe('EXECUTED')
    expect(s('Active')).toBe('EXECUTED')
    expect(s('Out for signature')).toBe('PENDING_SIGNATURE')
    expect(s('In negotiation')).toBe('UNDER_NEGOTIATION')
    expect(s('Expired')).toBe('EXPIRED')
    expect(s('Cancelled')).toBe('TERMINATED')
    expect(s('pending_review')).toBe('PENDING_REVIEW')
  })

  it('that only an approval sets is a draft, said (X24); one it doesn’t know is a draft too', () => {
    expect(readContractStatus('Approved')).toEqual({ status: 'DRAFT', known: true, workflow: 'APPROVED' })
    expect(readContractStatus('Pending approval')).toEqual({ status: 'DRAFT', known: true, workflow: 'PENDING_APPROVAL' })
    expect(readContractStatus('On hold')).toEqual({ status: 'DRAFT', known: false })
  })
})

describe('a column’s header', () => {
  it('names the contract’s own properties and any field, as people write them', () => {
    const s = (h: string) => suggestImportTarget(h, CATALOG)
    expect(s('Contract Name')).toEqual({ kind: 'title' })
    expect(s('File name')).toEqual({ kind: 'file' })
    expect(s('Agreement Type')).toEqual({ kind: 'type' })
    expect(s('Owner Email')).toEqual({ kind: 'owner' })
    expect(s('Supplier')).toEqual({ kind: 'field', key: 'counterpartyName' })
    expect(s('End Date')).toEqual({ kind: 'field', key: 'expiryDate' })
    expect(s('Governing Law')).toEqual({ kind: 'field', key: 'governingLaw' })
    expect(s('Jurisdiction')).toEqual({ kind: 'field', key: 'governingLaw' })
    expect(s('TCV')).toEqual({ kind: 'field', key: 'value' })
    expect(s('PO Number')).toEqual({ kind: 'field', key: 'po_number' })
    expect(s('Deliverables')).toEqual({ kind: 'field', key: 'deliverables' })
    expect(s('Internal notes')).toBeNull()
    expect(s('')).toBeNull()
  })
})

describe('a title from a document’s name', () => {
  it('drops the folder, the extension, underscores and dashes, as an upload names one', () => {
    expect(titleFromFile('contracts/2024/Acme_MSA-2024 (signed).pdf')).toBe('Acme MSA 2024 (signed)')
    expect(titleFromFile('C:\\scans\\Globex__DPA.docx')).toBe('Globex DPA')
    expect(titleFromFile('falcon-reseller.pdf')).toBe('Falcon reseller')
  })
})
