import { describe, it, expect } from 'vitest'
import { statusData, statusChangeMetadata } from './status-change.js'

describe('status changes (docs/41 P0.10)', () => {
  it('EXECUTED records when', () => {
    const at = new Date('2026-10-01T10:00:00Z')
    expect(statusData('EXECUTED', at)).toEqual({ status: 'EXECUTED', executedAt: at })
    expect(statusData('APPROVED', at)).toEqual({ status: 'APPROVED' })
  })

  it('one typed payload for every site', () => {
    expect(statusChangeMetadata({ from: 'PENDING_APPROVAL', to: 'DRAFT', source: 'approval', reason: 'Cap must be 1x fees', extra: { instanceId: 'i1' } }))
      .toEqual({ from: 'PENDING_APPROVAL', to: 'DRAFT', source: 'approval', reason: 'Cap must be 1x fees', instanceId: 'i1' })
    expect(statusChangeMetadata({ from: 'DRAFT', to: 'PENDING_SIGNATURE', source: 'signature', versionId: 'v2' }))
      .toEqual({ from: 'DRAFT', to: 'PENDING_SIGNATURE', source: 'signature', versionId: 'v2' })
  })
})
