/**
 * docs/41 fix-up 9 — a category's rules on the Playbook page: Required / Not
 * allowed / Optional, the contract types, and the approver, for those who may
 * edit the playbook; a plain summary for everyone else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const can = vi.hoisted(() => ({ edit: true }))
vi.mock('@/lib/permissions', async (orig) => ({ ...(await orig<typeof import('@/lib/permissions')>()), useCanRequest: () => can.edit }))

import { CategoryRulesPanel, presenceSummary, type RulesCategory } from './CategoryRulesPanel'

const gov: RulesCategory = { id: 'g', name: 'Governing Law', presence: 'required', presenceContractTypes: ['NDA', 'VENDOR_AGREEMENT'], approverUserId: null, approverRoleId: null }
const render = (c: RulesCategory) => renderToString(
  <QueryClientProvider client={new QueryClient()}><CategoryRulesPanel category={c} all={[c]} /></QueryClientProvider>,
).replace(/<!-- -->/g, '')

describe('a clause category\'s rules', () => {
  beforeEach(() => { can.edit = true })

  it('says what the rule does', () => {
    expect(presenceSummary('required', ['NDA', 'VENDOR_AGREEMENT'])).toBe('Required in NDA, VENDOR AGREEMENT.')
    expect(presenceSummary('not_allowed', [])).toBe('Not allowed in all contract types.')
    expect(presenceSummary('optional', ['NDA'])).toBe('Optional — contracts are not checked for it.')
  })

  it('offers Required / Not allowed / Optional, the contract types, and the approver to a playbook editor', () => {
    const html = render(gov)
    expect(html).toMatch(/data-testid="category-presence-required"[^>]*>Required</)
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('>Not allowed<')
    expect(html).toContain('>Optional<')
    expect(html).toContain('data-testid="category-presence-types"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>NDA</)
    expect(html).toContain('data-testid="category-approver"')
  })

  it('hides the contract types for an optional clause', () => {
    expect(render({ ...gov, presence: 'optional', presenceContractTypes: [] })).not.toContain('category-presence-types')
  })

  it('shows only the summary to someone who cannot edit the playbook', () => {
    can.edit = false
    const html = render(gov)
    expect(html).toContain('Required in NDA, VENDOR AGREEMENT.')
    expect(html).not.toContain('category-presence-required')
    expect(html).not.toContain('category-approver')
  })
})
