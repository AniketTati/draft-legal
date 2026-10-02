// @vitest-environment happy-dom
/**
 * docs/41 fix-up 15 — the family banner's "View family" opens the rail's
 * Contract family section (again, if someone folded it) and scrolls to it.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FamilyPanel, type FamilyMember } from './FamilyPanel'

const member = (id: string, children: FamilyMember[] = []): FamilyMember => ({
  id, title: id, status: 'EXECUTED', stage: 'active', relationshipType: id === 'root' ? null : 'amendment',
  number: id === 'root' ? null : 1, label: id === 'root' ? null : 'Amendment No. 1', effectiveDate: null, signed: true, changesTerms: false, children,
})

describe('View family', () => {
  it('opens the folded family section and scrolls it into view', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    qc.setQueryData(['contract-family-tree', 'root'], { root: member('root', [member('a1')]), currentId: 'root' })
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    const draw = (reveal: number) => act(() => root.render(
      <QueryClientProvider client={qc}><MemoryRouter><FamilyPanel contractId="root" reveal={reveal} /></MemoryRouter></QueryClientProvider>,
    ))
    await draw(0)
    const section = () => box.querySelector('[data-testid="rail-section-contract-family"]')!
    expect(section().getAttribute('data-state')).toBe('open')
    // Someone folds it.
    await act(async () => { (section().querySelector('button') as HTMLButtonElement).click() })
    expect(section().getAttribute('data-state')).toBe('closed')
    expect(scrolled).not.toHaveBeenCalled()

    await draw(1)
    expect(section().getAttribute('data-state')).toBe('open')
    await act(() => new Promise(r => setTimeout(r, 80)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(box.textContent).toContain('Amendment No. 1')
    root.unmount()
  })
})
