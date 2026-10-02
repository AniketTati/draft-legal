/**
 * docs/41 Part 16 (C1) — typing autosaves to draft changes; a version is made
 * only with a note. The Save as version dialog, the prompt on leaving the
 * editor with draft changes, and the dialog when someone else saved first.
 * Rendered to a string (no browser).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import {
  LeaveDraftPrompt, SaveVersionDialog, WorkingCopyConflictDialog,
  conflictWords, draftStatusText, emptySaveVersionForm, saveVersionBody, saveVersionRefusal,
} from './WorkingCopyDialogs'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
const noop = () => {}

describe('Save as version', () => {
  const dialog = (over: Partial<Parameters<typeof SaveVersionDialog>[0]> = {}) =>
    renderToString(<SaveVersionDialog open onClose={noop} onSave={noop} canResetApprovals={false} canShare {...over} />)

  it('asks what changed, and won\'t save without it', () => {
    const html = dialog()
    expect(text(html)).toContain('What changed')
    expect(html).toMatch(/data-testid="save-version-submit"[^>]*disabled=""|disabled=""[^>]*data-testid="save-version-submit"/)
    expect(saveVersionRefusal(emptySaveVersionForm())).toMatch(/what changed/i)
    expect(saveVersionRefusal({ ...emptySaveVersionForm(), note: 'ok' })).not.toBeNull()
    expect(saveVersionRefusal({ ...emptySaveVersionForm(), note: 'Extended the term' })).toBeNull()
  })

  it('offers "Send to counterparty" by share link, email, Word or PDF', () => {
    const html = dialog({ initial: { send: true } })
    expect(text(html)).toContain('Send to counterparty')
    for (const m of ['share_link', 'email', 'word', 'pdf']) expect(html).toContain(`save-version-method-${m}`)
    expect(buttons(html)).toContain('Save and send')
  })

  it('leaves out link and email for someone who can\'t share, and Word or PDF remain', () => {
    const html = dialog({ canShare: false, initial: { send: true } })
    expect(html).not.toContain('save-version-method-share_link')
    expect(html).not.toContain('save-version-method-email')
    expect(html).toContain('save-version-method-word')
    expect(html).toContain('save-version-method-pdf')
  })

  it('needs an address to send it by email', () => {
    const f = { ...emptySaveVersionForm(), note: 'Our counter', send: true, method: 'email' as const }
    expect(saveVersionRefusal(f)).toMatch(/email/i)
    expect(saveVersionRefusal({ ...f, recipientEmail: 'legal@acme.com' })).toBeNull()
    expect(saveVersionBody({ ...f, recipientEmail: ' legal@acme.com ' }, { canResetApprovals: false })).toEqual({
      note: 'Our counter', sendToCounterparty: { method: 'email', recipientEmail: 'legal@acme.com' },
    })
  })

  it('shows "Reset approvals", with what it does, only to someone who configures workflows', () => {
    expect(dialog()).not.toContain('save-version-reset-approvals')
    const html = dialog({ canResetApprovals: true })
    expect(html).toContain('save-version-reset-approvals')
    expect(text(html)).toMatch(/Reset approvals Every approver is asked again/)
  })

  it('sends resetApprovals only from someone allowed to', () => {
    const f = { ...emptySaveVersionForm(), note: 'Term extended', resetApprovals: true }
    expect(saveVersionBody(f, { canResetApprovals: false })).toEqual({ note: 'Term extended' })
    expect(saveVersionBody(f, { canResetApprovals: true })).toEqual({ note: 'Term extended', resetApprovals: true })
  })

  it('says a save of typing is not a version', () => {
    expect(draftStatusText('saved')).toBe('Draft changes saved · not a version yet')
    expect(draftStatusText('idle')).toBe('')
  })

  it('shows the server\'s refusal', () => {
    expect(text(dialog({ error: 'There are no draft changes to save.' }))).toContain('There are no draft changes to save.')
  })
})

describe('leaving the editor with draft changes', () => {
  it('offers Save as version, Keep as draft changes, or Discard', () => {
    const html = renderToString(<LeaveDraftPrompt open onChoose={noop} onClose={noop} />)
    expect(buttons(html).sort()).toEqual(['Discard', 'Keep as draft changes', 'Save as version'])
    expect(text(html)).toContain('a version yet')
  })

  it('renders nothing when closed', () => {
    expect(renderToString(<LeaveDraftPrompt open={false} onChoose={noop} onClose={noop} />)).toBe('')
  })
})

describe('someone else saved first (409)', () => {
  const now = Date.parse('2026-10-02T10:00:00Z')
  const conflict = {
    code: 'WORKING_COPY_CONFLICT' as const,
    detail: 'Priya Shah saved changes to this draft since you loaded it.',
    current: { revision: 4, updatedAt: '2026-10-02T09:58:00Z', updatedBy: { id: 'u2', name: 'Priya Shah' }, baseVersionId: 'v1' },
  }

  it('names who saved and when', () => {
    expect(conflictWords(conflict, now)).toBe('Priya Shah saved changes 2 min ago.')
    expect(conflictWords({ ...conflict, current: null }, now)).toMatch(/saved as a version or discarded/)
  })

  it('offers Reload their changes or Overwrite', () => {
    const html = renderToString(<WorkingCopyConflictDialog conflict={conflict} onReload={noop} onOverwrite={noop} onClose={noop} />)
    expect(text(html)).toContain('Priya Shah saved changes')
    expect(buttons(html)).toEqual(['Reload their changes', 'Overwrite'])
    expect(renderToString(<WorkingCopyConflictDialog conflict={null} onReload={noop} onOverwrite={noop} onClose={noop} />)).toBe('')
  })
})

describe('the contract page', () => {
  const page = readFileSync(join(__dirname, '../../pages/ContractDetailPage.tsx'), 'utf8')
  const banner = readFileSync(join(__dirname, 'StatusBanner.tsx'), 'utf8')

  it('autosaves typing to the draft changes, not to a version', () => {
    expect(page).not.toContain('/html-version`')
    expect(page).toContain('draft.change(html)')
  })

  it('shows "Unsaved draft changes" in the status banner, and no Sync chip', () => {
    expect(banner).toContain('Unsaved draft changes')
    expect(page).not.toContain('CollabStatusBadge')
  })
})
