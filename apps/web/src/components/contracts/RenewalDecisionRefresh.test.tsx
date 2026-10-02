// @vitest-environment happy-dom
/**
 * docs/41 browser QA (fa711b9) — a renewal decision moves the contract
 * ("Active · Renewing"): the header's stage line and the contract are fetched
 * again at once, not after a reload.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(async () => ({ data: { unchanged: false, decidedInTime: true, actionContract: null } })) },
}))

import { RenewalDecisionPanel } from './RenewalDecisionDialog'
import { approvalKeys } from '@/lib/approval-keys'
import type { RenewalState } from '@/lib/renewal'

const STATE: RenewalState = {
  contractId: 'k1', stage: 'active', expiryDate: '2026-12-31',
  terms: { renewalType: 'manual', renewalTermMonths: 12, noticeDays: 90, noticeDeadline: '2026-10-16', optOutWindowStart: null, priceUpliftCap: null, confirmed: true },
  daysToDeadline: 14, inWindow: true, canDecide: true,
  // Standing on "renew", so the choice is made and Confirm is live.
  decision: { id: 'd0', decision: 'renew', label: 'Renew as is', reason: null, decidedBy: 'Ana', decidedAt: '2026-09-01T00:00:00Z', decidedInTime: true, noticeSentAt: null, noticeSentInTime: null, actionContract: null },
  choices: [{ decision: 'renew', label: 'Renew as is', effect: 'It renews on its own.' }],
  history: [],
}

describe('after a renewal decision', () => {
  it("refetches the contract's stage line and the contract", async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    await act(() => root.render(
      <QueryClientProvider client={qc}><MemoryRouter><RenewalDecisionPanel state={STATE} /></MemoryRouter></QueryClientProvider>,
    ))
    await act(async () => { (box.querySelector('[data-testid="renewal-decide-btn"]') as HTMLButtonElement).click() })
    await act(() => new Promise(r => setTimeout(r, 20)))
    const keys = invalidate.mock.calls.map(c => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(approvalKeys.stage('k1')))
    expect(keys).toContain(JSON.stringify(['contract', 'k1']))
    expect(box.textContent).toContain('Decision recorded.')
    root.unmount()
  })
})
