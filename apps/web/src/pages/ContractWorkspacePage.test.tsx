/**
 * docs/41 Parts 15, 16 (C2) — the contract workspace: full screen with the
 * status banner on top, the document in the middle and Review / Details /
 * Comments on the right; which contracts open there; a finding clicked
 * takes the person to its clause. Rendered to a string (no browser).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/permissions', () => ({ useCanRequest: () => true, usePermission: () => true }))
vi.mock('@/components/contracts/DocumentCanvas', () => ({ DocumentCanvas: () => <div data-testid="document-canvas" /> }))
vi.mock('@/components/contracts/review/ReviewPanel', () => ({ ReviewPanel: () => <div data-testid="review-panel" /> }))
vi.mock('@/components/contracts/StatusBanner', () => ({ StatusBanner: () => <div data-testid="status-banner" /> }))
vi.mock('@/components/contracts/HistoryDrawer', () => ({ HistoryDrawer: () => null }))
vi.mock('@/components/contracts/SendForReviewDialog', () => ({ SendForReviewDialog: () => null }))
vi.mock('@/components/contracts/SendForSignatureDialog', () => ({ SendForSignatureDialog: () => null }))

const { ContractWorkspacePage } = await import('./ContractWorkspacePage')
const { openPathFor, jumpTo, workspacePath } = await import('@/lib/workspace')

const CONTRACT = {
  id: 'k1', title: 'Acme MSA', status: 'IN_NEGOTIATION', currentVersionId: 'v2', metadata: {},
  versions: [{ id: 'v2', versionNumber: 2, htmlContent: '<p>Fees are payable in 30 days.</p>', createdAt: '2026-09-01' }],
}

function render(url = '/contracts/k1/workspace') {
  const qc = new QueryClient()
  qc.setQueryData(['contract', 'k1'], CONTRACT)
  qc.setQueryData(['contract-clauses', 'k1'], { data: [] })
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/contracts/:id/workspace" element={<ContractWorkspacePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the workspace', () => {
  it('puts the banner on top, the document in the middle and the panel on the right', () => {
    const html = render()
    const at = (id: string) => html.indexOf(`data-testid="${id}"`)
    expect(at('contract-workspace')).toBeGreaterThanOrEqual(0)
    expect(html).toContain('Acme MSA')
    expect(at('status-banner')).toBeLessThan(at('workspace-document'))
    expect(at('workspace-document')).toBeLessThan(at('workspace-panel'))
    // The panel's views, Review first and open.
    for (const tab of ['review', 'details', 'comments']) expect(at(`workspace-tab-${tab}`)).toBeGreaterThan(0)
    expect(html).toMatch(/aria-selected="true"[^>]*data-testid="workspace-tab-review"/)
    expect(at('review-panel')).toBeGreaterThan(at('workspace-panel'))
    // One way to see what changed, and the history.
    expect(at('workspace-changes-toggle')).toBeGreaterThan(0)
    expect(at('workspace-history')).toBeGreaterThan(0)
  })

  it('is full screen: no app rail around it', () => {
    expect(render()).not.toContain('data-testid="app-sidebar"')
    expect(render()).toContain('fixed inset-0')
  })
})

describe('where a contract opens', () => {
  it('opens the workspace while it is drafted, negotiated or approved, else the contract page', () => {
    for (const stage of ['draft', 'negotiate', 'approve']) expect(openPathFor({ id: 'k1', stage })).toBe('/contracts/k1/workspace')
    for (const stage of ['request', 'sign', 'active', 'closed', null]) expect(openPathFor({ id: 'k1', stage })).toBe('/contracts/k1')
    expect(workspacePath('k1', { changes: true })).toBe('/contracts/k1/workspace?mode=changes')
  })
})

describe('a finding clicked', () => {
  it('scrolls to the clause the risk layer marked, and marks it', () => {
    const el = { scrollIntoView: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } }
    const root = { querySelector: vi.fn((sel: string) => sel === '[data-clause-id="c1"]' ? el : null) }
    const reveal = vi.fn(() => true)
    expect(jumpTo({ clauseId: 'c1' }, { root: root as never, clauses: [], reveal })).toBe(true)
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(el.classList.add).toHaveBeenCalledWith('ring-2', 'ring-attention-600')
    expect(reveal).not.toHaveBeenCalled()
  })

  it('finds an unmarked clause by its words, and a finding without one by its quote', () => {
    const root = { querySelector: () => null }
    const reveal = vi.fn((t: string) => t !== 'gone')
    expect(jumpTo({ clauseId: 'c2' }, { root: root as never, clauses: [{ id: 'c2', content: 'Fees are payable' }], reveal })).toBe(true)
    expect(reveal).toHaveBeenLastCalledWith('Fees are payable')
    expect(jumpTo({ quote: 'in 30 days' }, { root: root as never, clauses: [], reveal })).toBe(true)
    expect(reveal).toHaveBeenLastCalledWith('in 30 days')
    expect(jumpTo({ quote: 'gone' }, { root: root as never, clauses: [], reveal })).toBe(false)
  })
})
