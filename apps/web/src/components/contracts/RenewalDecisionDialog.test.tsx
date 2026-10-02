/**
 * docs/41 Part 14 — the decision dialog says what each choice does before
 * anyone clicks, shows the deadline it is decided against, and warns when the
 * renewal terms weren't checked. Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RenewalDecisionPanel } from './RenewalDecisionDialog'
import type { RenewalState } from '@/lib/renewal'

const STATE: RenewalState = {
  contractId: 'k1', stage: 'active', expiryDate: '2026-12-31',
  terms: { renewalType: 'manual', renewalTermMonths: 12, noticeDays: 90, noticeDeadline: '2026-10-02', optOutWindowStart: null, priceUpliftCap: 5, confirmed: false },
  daysToDeadline: 10, inWindow: true, canDecide: true, decision: null,
  choices: [
    { decision: 'renew', label: 'Renew as is', effect: 'We draft a short renewal letter extending the term, from your template.' },
    { decision: 'renegotiate', label: 'Renegotiate', effect: 'We open a renewal draft from the agreement as it stands today.' },
    { decision: 'let_lapse', label: 'Let it lapse', effect: 'We draft a notice of non-renewal from your template.' },
    { decision: 'terminate', label: 'End it', effect: 'We draft a notice of non-renewal. The contract shows as expiring, then ended.' },
  ],
  history: [],
}

function render(state: RenewalState) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RenewalDecisionPanel state={state} />
      </MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '')
}

describe('RenewalDecisionPanel', () => {
  it('offers the three choices, each with what it does', () => {
    const html = render(STATE)
    expect(html).toContain('data-testid="renewal-choice-renew"')
    expect(html).toContain('data-testid="renewal-choice-renegotiate"')
    expect(html).toContain('data-testid="renewal-choice-stop"')
    expect(html).toContain('Renew as is')
    expect(html).toContain('Let it lapse or end it')
    expect(html).toContain('We draft a short renewal letter extending the term')
    expect(html).toContain('We open a renewal draft from the agreement as it stands today.')
    expect(html).toContain('We draft a notice of non-renewal from your template.')
  })

  it('shows the deadline it is decided against, urgent when close, and that the terms weren’t checked', () => {
    const html = render(STATE)
    expect(html).toContain('Last day to give notice: 2 Oct 2026 (in 10 days)')
    expect(html).toContain('text-risk-700 font-medium')
    expect(html).toContain('Renews only if both agree, for 12 months at a time.')
    expect(html).toContain('read by the AI and haven’t been checked yet')
    expect(render({ ...STATE, terms: { ...STATE.terms, confirmed: true } })).not.toContain('haven’t been checked')
  })

  it('can’t confirm until a choice is made, and starts on the standing decision', () => {
    expect(render(STATE)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="renewal-decide-btn"[^>]*>Choose one/)
    const decided = render({ ...STATE, decision: { id: 'd1', decision: 'terminate', label: 'End it', reason: null, decidedBy: 'Ana', decidedAt: '2026-09-01T00:00:00Z', decidedInTime: true, noticeSentAt: null, noticeSentInTime: null, actionContract: null } })
    expect(decided).toContain('Draft the notice')
    expect(decided).toContain('End it (terminate)')
  })

  it('never shows internal words', () => {
    expect(render(STATE)).not.toMatch(/binder|carry|MARKET|playbook redline|let_lapse/)
  })
})
