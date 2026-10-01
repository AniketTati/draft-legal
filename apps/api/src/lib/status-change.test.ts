import { describe, it, expect, vi } from 'vitest'

vi.mock('./audit.js', () => ({ createAuditEvent: vi.fn(async () => ({})) }))
vi.mock('./webhook-events.js', () => ({ fireWebhook: vi.fn(async () => {}) }))

const { stageChangeMetadata, moved, recordStageChange } = await import('./status-change.js')
const { createAuditEvent } = await import('./audit.js')
const { fireWebhook } = await import('./webhook-events.js')

const at = (stage: string, stageState: string, turn: string, status: string) => ({ stage, stageState, turn, status }) as never

describe('stage changes (docs/41 P0.10, Part 18)', () => {
  it('one typed payload for every site, with the status kept as from/to', () => {
    expect(stageChangeMetadata({
      from: at('approve', 'pending', 'approvers', 'PENDING_APPROVAL'), to: at('draft', 'returned', 'internal', 'DRAFT'),
      source: 'approval', reason: 'Cap must be 1x fees', extra: { instanceId: 'i1' },
    })).toEqual({
      from: 'PENDING_APPROVAL', to: 'DRAFT', fromStage: 'approve', toStage: 'draft', fromState: 'pending', toState: 'returned',
      fromTurn: 'approvers', toTurn: 'internal', source: 'approval', reason: 'Cap must be 1x fees', instanceId: 'i1',
    })
  })

  it('a move of the turn alone is a move; standing still is not', () => {
    expect(moved(at('negotiate', 'with_us', 'internal', 'UNDER_NEGOTIATION'), at('negotiate', 'with_counterparty', 'counterparty', 'UNDER_NEGOTIATION'))).toBe(true)
    expect(moved(at('draft', 'drafting', 'internal', 'DRAFT'), at('draft', 'drafting', 'internal', 'DRAFT'))).toBe(false)
  })

  it('records STAGE_CHANGED and tells subscribers what moved: the stage, the turn, or both', async () => {
    await recordStageChange({
      orgId: 'o', contractId: 'c', userId: 'u', source: 'send',
      from: at('negotiate', 'with_us', 'internal', 'UNDER_NEGOTIATION'), to: at('negotiate', 'with_counterparty', 'counterparty', 'UNDER_NEGOTIATION'),
    })
    expect(vi.mocked(createAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAGE_CHANGED', resourceType: 'contract', resourceId: 'c' }))
    const events = vi.mocked(fireWebhook).mock.calls.map(c => c[1])
    expect(events).toEqual(['contract.stage_changed', 'contract.turn_changed'])
    vi.mocked(fireWebhook).mockClear()
    await recordStageChange({ orgId: 'o', contractId: 'c', source: 'dates', from: at('active', 'active', 'none', 'EXECUTED'), to: at('active', 'expiring', 'none', 'EXECUTED') })
    expect(vi.mocked(fireWebhook).mock.calls.map(c => c[1])).toEqual(['contract.stage_changed'])
  })
})
