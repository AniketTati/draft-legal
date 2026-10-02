// @vitest-environment happy-dom
/**
 * docs/41 Part 16 (C4) — suggestions in the workspace: the popover a click
 * opens (who, when, what, Accept / Reject), the header's count and Accept all
 * / Reject all, suggestion authors in "Document discussion", AI wording put
 * in as a suggestion, and "edited" logged for AI wording changed before a save.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { SuggestionPopover } from '../SuggestionPopover'
import { SuggestionsBar, suggestingByDefault, suggestionPeople } from './SuggestionsBar'
import { mergePeople } from './CommentsView'
import { TrackChanges, suggestionsIn } from '@/components/editor/TrackChanges'
import { aiEditsAtSave, insertAsTrackedChange } from '@/lib/tracked-insert'

const change = { id: 'c1', kind: 'insertion' as const, authorName: 'Asha', at: '2026-10-02T09:05:00.000Z', text: 'twenty', rect: { left: 10, bottom: 20 } }

describe('the suggestion popover', () => {
  it('says who suggested what, with Accept and Reject', () => {
    const html = renderToString(<SuggestionPopover change={change} canDecide onAccept={() => {}} onReject={() => {}} onClose={() => {}} />)
    expect(html).toContain('Asha')
    expect(html).toContain('Suggested adding')
    expect(html).toContain('twenty')
    expect(html).toContain('data-testid="suggestion-accept"')
    expect(html).toContain('data-testid="suggestion-reject"')
  })

  it('a reader sees the suggestion without the buttons', () => {
    const html = renderToString(<SuggestionPopover change={{ ...change, kind: 'deletion' }} canDecide={false} onAccept={() => {}} onReject={() => {}} onClose={() => {}} />)
    expect(html).toContain('Suggested removing')
    expect(html).not.toContain('suggestion-accept')
  })

  it('Accept and Reject call back with the change, Escape closes', () => {
    const onAccept = vi.fn(), onReject = vi.fn(), onClose = vi.fn()
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    act(() => root.render(<SuggestionPopover change={change} canDecide onAccept={onAccept} onReject={onReject} onClose={onClose} />))
    act(() => (box.querySelector('[data-testid="suggestion-accept"]') as HTMLButtonElement).click())
    act(() => (box.querySelector('[data-testid="suggestion-reject"]') as HTMLButtonElement).click())
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onAccept).toHaveBeenCalledWith('c1')
    expect(onReject).toHaveBeenCalledWith('c1')
    expect(onClose).toHaveBeenCalled()
    act(() => root.unmount())
  })
})

describe('the suggestions bar', () => {
  it('while negotiating, suggesting is on and not a toggle', () => {
    expect(suggestingByDefault('negotiate')).toBe(true)
    expect(suggestingByDefault('draft')).toBe(false)
    const html = renderToString(<SuggestionsBar editor={null} count={2} suggesting forced canEdit onToggle={() => {}} />).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="suggesting-on"')
    expect(html).not.toContain('suggesting-toggle')
    expect(html).toContain('2 suggestions')
    expect(html).toContain('Accept all')
    expect(html).toContain('Reject all')
  })

  it('otherwise a toggle, and no Accept all without suggestions', () => {
    const html = renderToString(<SuggestionsBar editor={null} count={0} suggesting={false} forced={false} canEdit onToggle={() => {}} />)
    expect(html).toContain('data-testid="suggesting-toggle"')
    expect(html).not.toContain('Accept all')
  })
})

describe('Document discussion', () => {
  it('lists suggestion authors with commenters, the counterparty as one person', () => {
    const people = suggestionPeople([
      { id: 'a', kind: 'insertion', authorId: 'u1', authorName: 'Asha', at: null, from: 1, to: 2, text: 'x' },
      { id: 'b', kind: 'deletion', authorId: 'portal:link1', authorName: 'Acme legal', at: null, from: 3, to: 4, text: 'y' },
    ])
    expect(people).toEqual([{ id: 'u1', name: 'Asha', count: 1 }, { id: 'portal', name: 'Counterparty', count: 1 }])
    expect(mergePeople([{ id: 'u1', name: 'Asha', count: 2 }], people)).toEqual([{ id: 'u1', name: 'Asha', count: 3 }, { id: 'portal', name: 'Counterparty', count: 1 }])
  })
})

describe('AI wording as a suggestion', () => {
  const editorWith = (html: string) => {
    const editor = new Editor({ extensions: [StarterKit, TrackChanges], content: html })
    editor.commands.setSuggesting(false, { id: 'u1', name: 'Asha' })
    return editor
  }

  it('goes in as a suggestion by the person, even outside suggestion mode', () => {
    const editor = editorWith('<p>Liability is unlimited.</p>')
    const from = editor.state.doc.textContent.indexOf('unlimited') + 1
    const placed = insertAsTrackedChange(editor as never, { from, to: from + 9 }, 'capped at fees', { contractId: 'k1', feature: 'ask_ai', suggestionId: 'sg1' })
    expect(suggestionsIn(editor.state.doc).map(c => [c.kind, c.text, c.authorName])).toEqual([['deletion', 'unlimited', 'Asha'], ['insertion', 'capped at fees', 'Asha']])
    expect(editor.state.doc.textBetween(placed!.from, placed!.to)).toBe('capped at fees')
    // Not left in suggestion mode afterwards.
    expect(editor.storage.trackChanges.enabled).toBe(false)
    expect(aiEditsAtSave('k1', editor.state.doc)).toEqual([])
    editor.destroy()
  })

  it('logs "edited" at save when the person changed the AI wording', () => {
    const editor = editorWith('<p>Liability is unlimited.</p>')
    const from = editor.state.doc.textContent.indexOf('unlimited') + 1
    insertAsTrackedChange(editor as never, { from, to: from + 9 }, 'capped at fees', { contractId: 'k2', feature: 'ask_ai', suggestionId: 'sg2' })
    editor.commands.setContent('<p>Liability is capped at twice the fees.</p>')
    expect(aiEditsAtSave('k2', editor.state.doc)).toEqual([{ contractId: 'k2', versionId: null, feature: 'ask_ai', outcome: 'edited', suggestionId: 'sg2' }])
    // Logged once: forgotten after the save.
    expect(aiEditsAtSave('k2', editor.state.doc)).toEqual([])
    editor.destroy()
  })
})
