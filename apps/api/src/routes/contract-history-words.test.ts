/**
 * docs/41 browser QA (442728c) — History says in words what changed, never
 * the stored names ("set_from_template", "metadata", "fieldConfidence").
 */
import { describe, it, expect } from 'vitest'
import { AuditAction } from '@clm/types'
import { historyItemOf } from './contract-lifecycle.js'

const at = new Date('2026-10-02T10:00:00Z')
const names = (id: string | null) => (id === 'u1' ? 'Legal Counsel' : null)
const title = (userId: string | null, metadata: Record<string, unknown>) =>
  historyItemOf({ id: 'e1', action: AuditAction.CONTRACT_UPDATED, createdAt: at, userId, metadata }, names)?.title

describe('a contract update in History', () => {
  it("is the analysis's when no person made it, in words, without stored state", () => {
    const t = title(null, { changes: ['title', 'type', 'counterpartyName', 'summary', 'keyTerms', 'riskScore', 'metadata', 'fieldConfidence', 'jurisdiction', 'analysisStatus'] })
    expect(t).toBe('The analysis updated title, type, counterparty, summary, key terms, risk score, governing law')
    expect(title(null, { changes: ['metadata', 'updatedAt'] })).toBe('The analysis updated it')
  })

  it("says what a person did to which field", () => {
    expect(title('u1', { action: 'set_from_template', field: 'counterpartyName' })).toBe('Legal Counsel filled in counterparty')
    expect(title('u1', { action: 'document_edited', field: 'body' })).toBe('Legal Counsel edited the document')
    expect(title('u1', { action: 'verified_all' })).toBe('Legal Counsel checked every field')
    expect(title('u1', { action: 'corrected', field: 'effectiveDate' })).toBe('Legal Counsel corrected effective date')
  })

  it('never shows a stored name', () => {
    const all = [
      title(null, { changes: ['metadata', 'fieldConfidence', 'overallConfidence', 'title'] }),
      title('u1', { action: 'set_from_template', field: 'governingLaw' }),
      title('u1', { action: 'some_new_action' }),
    ].join(' | ')
    expect(all).not.toMatch(/set_from_template|metadata|fieldConfidence|overallConfidence|_/)
  })
})
