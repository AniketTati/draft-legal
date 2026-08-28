/**
 * Tests for the audit hash chain (P7.5.4).
 *
 * Pure-function tests for hashAuditRow. The DB-backed
 * createAuditEvent + verifyAuditChain are exercised in
 * scripts/archive/p75-4-verify.mjs (needs a live Postgres).
 */
import { describe, it, expect } from 'vitest'
import { hashAuditRow } from './audit.js'

const baseRow = {
  id: 'aud_001',
  orgId: 'org_a',
  userId: 'user_x',
  action: 'CONTRACT_CREATED',
  resourceType: 'contract',
  resourceId: 'ct_1',
  metadata: { source: 'test' },
  ipAddress: '10.0.0.1',
  userAgent: 'vitest',
  createdAt: new Date('2026-04-25T12:00:00Z'),
  prevHash: null,
}

describe('hashAuditRow', () => {
  it('produces a deterministic 64-char SHA256 hex', () => {
    const h = hashAuditRow(baseRow)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same hash for the same input twice', () => {
    expect(hashAuditRow(baseRow)).toBe(hashAuditRow({ ...baseRow }))
  })

  it('changes the hash if any field changes', () => {
    const a = hashAuditRow(baseRow)
    const b = hashAuditRow({ ...baseRow, action: 'CONTRACT_DELETED' })
    expect(a).not.toBe(b)
  })

  it('treats prevHash as part of the chain', () => {
    const a = hashAuditRow({ ...baseRow, prevHash: null })
    const b = hashAuditRow({ ...baseRow, prevHash: 'abc' })
    expect(a).not.toBe(b)
  })

  it('canonicalizes nested metadata so key order does not matter', () => {
    const m1 = { source: 'test', count: 3 }
    const m2 = { count: 3, source: 'test' }
    expect(hashAuditRow({ ...baseRow, metadata: m1 }))
      .toBe(hashAuditRow({ ...baseRow, metadata: m2 }))
  })

  it('detects metadata mutation', () => {
    const a = hashAuditRow({ ...baseRow, metadata: { count: 3 } })
    const b = hashAuditRow({ ...baseRow, metadata: { count: 4 } })
    expect(a).not.toBe(b)
  })

  it('canonicalizes Date to ISO so timezone formatting does not matter', () => {
    const d1 = new Date('2026-04-25T12:00:00Z')
    const d2 = new Date('2026-04-25T12:00:00.000Z')
    expect(hashAuditRow({ ...baseRow, createdAt: d1 }))
      .toBe(hashAuditRow({ ...baseRow, createdAt: d2 }))
  })
})
