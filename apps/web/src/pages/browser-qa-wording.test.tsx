/**
 * docs/41 browser QA — what the Inbox and the dashboard say:
 *   - an Inbox row waiting for my approval says the AI's recommendation and
 *     its first reason, as the decision strip does (cf29987);
 *   - the dashboard calls the Inbox count contracts that need my action, which
 *     includes a returned one to fix, not "approvals waiting" (0584c1e).
 * Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MineRow, type InboxRow, type QueueItem } from './ApprovalsPage'
import { YourDayBand, type YourDay } from './DashboardPage'

const html = (node: ReactNode) => renderToString(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'")

const row = (kind: 'approve' | 'fix_and_resubmit', detail: string | null = null): InboxRow => ({
  contractId: 'k1', title: 'QA NDA', type: 'NDA', counterpartyName: 'Initech', value: null, currency: null,
  stage: 'review', stageState: 'in_approval', turn: 'internal', turnSince: '2026-10-01T00:00:00Z', line: 'In approval',
  owner: { id: 'u1', name: 'Rep A' }, waitingOn: null, approvals: null,
  primary: { kind, label: kind === 'approve' ? 'Approve' : 'Fix and resubmit', since: '2026-10-01T00:00:00Z', stepId: 's1', detail },
  actions: [{ kind, label: 'x', since: '2026-10-01T00:00:00Z', stepId: 's1', detail }],
})

const card = (approvalRecommendation: string, recommendationReasons: string[]): QueueItem => ({
  stepId: 's1', instanceId: 'i1', stepName: 'Legal review',
  contract: { id: 'k1', title: 'QA NDA', type: 'NDA', status: 'IN_REVIEW' },
  instance: { id: 'i1', status: 'PENDING', submittedAt: '2026-10-01T00:00:00Z', approvalRecommendation, recommendationReasons },
})

describe('an Inbox row waiting for my approval', () => {
  it("says the AI's recommendation and its first reason", () => {
    const out = html(<MineRow row={row('approve')} cardOf={new Map([['s1', card('review', ['Governing Law — deleted since v1 (required)', 'other'])]])} onDone={() => {}} />)
    expect(out).toContain('data-testid="inbox-recommendation"')
    expect(out).toContain('AI: Review — Governing Law — deleted since v1 (required)')
    expect(html(<MineRow row={row('approve')} cardOf={new Map([['s1', card('cant_recommend', ['this contract has not been analysed'])]])} onDone={() => {}} />))
      .toContain("AI: Can't recommend — this contract has not been analysed")
  })

  it('a returned contract to fix says its reason, and no AI line', () => {
    const out = html(<MineRow row={row('fix_and_resubmit', 'Put the governing law clause back.')} cardOf={new Map()} onDone={() => {}} />)
    expect(out).toContain('Reason: “Put the governing law clause back.”')
    expect(out).not.toContain('inbox-recommendation')
  })
})

describe("the dashboard's Your day", () => {
  const day = (approvalsWaiting: number): YourDay => ({ approvalsWaiting, requestsWaiting: 0, contractsExpiring: 0, draftsInProgress: 0, total: approvalsWaiting })

  it('calls the Inbox count contracts that need your action', () => {
    expect(html(<YourDayBand yourDay={day(1)} />)).toContain('needs your action in Inbox')
    expect(html(<YourDayBand yourDay={day(2)} />)).toContain('need your action in Inbox')
    const out = html(<YourDayBand yourDay={day(1)} />)
    expect(out).toContain('1 item needs you')
    expect(out).not.toMatch(/waiting on your decision|needs your decision/)
  })
})
