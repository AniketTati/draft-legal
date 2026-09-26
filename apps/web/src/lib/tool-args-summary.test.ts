import { describe, it, expect } from 'vitest'
import { summarizeArgs } from './tool-args-summary'

describe('a tool chip says what was asked for', () => {
  it('shows the date, value and sort filters the assistant searched with', () => {
    expect(summarizeArgs({ expiry_from: '2024-05-30', expiry_to: '2024-07-29', limit: 50, sort_by: 'expiryDate', sort_order: 'asc' }))
      .toBe('expires 2024-05-30…2024-07-29 · by expiryDate ↑ · limit=50')
    expect(summarizeArgs({ value_min: 100000, effective_from: '2026-01-01' })).toBe('effective from 2026-01-01 · value ≥ 100000')
  })

  it('shows the counterparty under the name the tool sends it by', () => {
    expect(summarizeArgs({ counterparty_name: 'Acme', status: 'EXECUTED' })).toBe('status=EXECUTED · counterparty=Acme')
  })

  it('keeps the short forms it had', () => {
    expect(summarizeArgs({ contract_id: 'cmuhc47ch0007', query: 'liability' })).toBe('cmuhc4… · "liability"')
    expect(summarizeArgs({ query: 'x' }, { kind: 'contract', title: 'Brightwave Software Ltd - Acme Corp Software Subscription Agreement' }))
      .toBe('Brightwave Software Ltd - Acme Corp… · "x"')
    expect(summarizeArgs({})).toBe('')
  })
})
