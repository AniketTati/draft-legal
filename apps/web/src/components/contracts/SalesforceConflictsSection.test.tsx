/**
 * docs/41 fix-up 4 — the contract's held-back Salesforce changes: each shows
 * the old and new value; the owner gets Apply / Dismiss; nothing shows when
 * there are none. Rendered to a string with the query already loaded.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SalesforceConflictsSection, showValue, type ContractConflict } from './SalesforceConflictsSection'

const conflict: ContractConflict = { id: 'k1', label: 'Amount', currentValue: 40000, incomingValue: '45000', createdAt: new Date().toISOString() }

function render(items: ContractConflict[], canEdit: boolean) {
  const qc = new QueryClient()
  qc.setQueryData(['integration-conflicts', 'c1'], { data: items })
  return renderToString(<QueryClientProvider client={qc}><SalesforceConflictsSection contractId="c1" canEdit={canEdit} /></QueryClientProvider>).replace(/<!-- -->/g, '')
}

describe('Salesforce changes on a contract', () => {
  it('says what Salesforce changed, old to new, with Apply and Dismiss for the owner', () => {
    const html = render([conflict], true)
    expect(html).toContain('data-testid="salesforce-conflict-k1"')
    expect(html).toContain(`Salesforce changed amount <span class="tabular-nums">${(40000).toLocaleString()} → ${(45000).toLocaleString()}</span>`)
    expect(html).toContain('>Apply<')
    expect(html).toContain('>Dismiss<')
  })

  it('shows the change but no actions to someone who cannot edit the contract', () => {
    const html = render([conflict], false)
    expect(html).toContain('salesforce-conflict-k1')
    expect(html).not.toContain('>Apply<')
  })

  it('shows nothing when there are no changes waiting', () => {
    expect(render([], true)).toBe('')
  })

  it('reads values as people do', () => {
    expect(showValue(null)).toBe('empty')
    expect(showValue('')).toBe('empty')
    expect(showValue('Net 30')).toBe('Net 30')
    expect(showValue('2026-10-01')).toBe('2026-10-01')
  })
})
