/**
 * docs/41 Part 15 — when the counterparty sent a version, the banner says
 * what it brought, from the counts the stage sends, and offers one primary
 * action: Review changes. Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBanner, counterpartyLine, type StageView } from './StatusBanner'
import { approvalKeys } from '@/lib/approval-keys'
import { workingCopyKey } from '@/lib/working-copy'

describe('the counterparty line', () => {
  it('says the version, its changes, what needs attention and the required clauses missing', () => {
    expect(counterpartyLine({ versionNumber: 5, changes: 12, needAttention: 3, missingRequired: 1, advised: true }))
      .toBe('Counterparty sent v5 — 12 changes, 3 need attention, 1 required clause missing')
    expect(counterpartyLine({ versionNumber: 2, changes: 1, needAttention: 1, missingRequired: 2, advised: false }))
      .toBe('Counterparty sent v2 — 1 change, 1 needs attention, 2 required clauses missing')
    expect(counterpartyLine({ versionNumber: 3, changes: 4, needAttention: 0, missingRequired: 0, advised: true }))
      .toBe('Counterparty sent v3 — 4 changes')
  })
})

describe('the banner after a counterparty version', () => {
  it('shows the line and Review changes as its one primary action', () => {
    const stage: StageView = {
      contractId: 'k1', stage: 'negotiate', stageState: 'with_us', turn: 'internal', status: 'IN_NEGOTIATION',
      stageLabel: 'Negotiate', stateLabel: 'With us', turnLabel: 'Our turn', turnSince: '2026-10-01', turnSinceWords: '2h',
      turnOwner: null, line: 'Negotiate · Our turn · 2h',
      progress: [{ stage: 'negotiate', label: 'Negotiate', status: 'current' }],
      next: { kind: 'review_changes', label: 'Review changes', enabled: true },
      approvals: null, signatures: null, exceptions: { open: 0 }, returned: null,
      latestVersion: { id: 'v5', number: 5, fromCounterparty: true, at: '2026-10-01' },
      counterparty: { versionNumber: 5, changes: 12, needAttention: 3, missingRequired: 1, advised: true },
      moves: [], canCancel: false, canUndoCancel: false,
    }
    const qc = new QueryClient()
    qc.setQueryData(approvalKeys.stage('k1'), stage)
    qc.setQueryData(workingCopyKey('k1'), null)
    const html = renderToString(
      <QueryClientProvider client={qc}><MemoryRouter>
        <StatusBanner contractId="k1" onSubmit={() => {}} onSendForSignature={() => {}} onReviewChanges={() => {}} onOpenHistory={() => {}} />
      </MemoryRouter></QueryClientProvider>,
    ).replace(/<!-- -->/g, '')
    expect(html).toContain('Counterparty sent v5 — 12 changes, 3 need attention, 1 required clause missing')
    expect(html).toMatch(/data-testid="stage-next"[^>]*>(<[^>]+>)*Review changes/)
  })
})
