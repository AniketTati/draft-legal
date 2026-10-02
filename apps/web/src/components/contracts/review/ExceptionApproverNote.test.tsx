/**
 * docs/41 fix-up 7 — the Request exception dialog names who will decide, or
 * says no one is named (with a link for those who can name one).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ExceptionApproverText } from './ExceptionApproverNote'

const render = (el: React.ReactElement) => renderToString(<MemoryRouter>{el}</MemoryRouter>).replace(/<!-- -->/g, '')

describe('who decides an exception', () => {
  it('names the clause approver', () => {
    const html = render(<ExceptionApproverText title="Liability cap" approver={{ kind: 'user', name: 'Priya Shah', category: 'Liability' }} canSetApprover={false} />)
    expect(html).toContain('goes to <span class="font-medium text-ink-950">Priya Shah</span>, who decides exceptions for Liability')
  })

  it('names the role when a role decides', () => {
    const html = render(<ExceptionApproverText title="Liability cap" approver={{ kind: 'role', name: 'Deal Desk', category: null }} canSetApprover={false} />)
    expect(html).toContain('anyone with the Deal Desk role')
  })

  it('says no one is named, and links admins to the Playbook page', () => {
    const msg = 'No one is named to decide exceptions for “Liability”. An admin can name a clause approver on the Playbook page.'
    const admin = render(<ExceptionApproverText title="x" error={msg} canSetApprover />)
    expect(admin).toContain('data-testid="exception-no-approver"')
    expect(admin).toContain('href="/playbook"')
    expect(render(<ExceptionApproverText title="x" error={msg} canSetApprover={false} />)).not.toContain('href="/playbook"')
  })
})
