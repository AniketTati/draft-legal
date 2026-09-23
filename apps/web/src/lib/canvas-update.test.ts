/**
 * X47 — opening a contract saved a new version: the read-only canvas
 * reported TipTap's mount-time `update` as an edit, and the page autosaves
 * every edit it is told about.
 */
import { describe, it, expect } from 'vitest'
import { editedHtml } from './canvas-update'

describe('editedHtml', () => {
  it('a read-only canvas reports no edit, whatever TipTap emits', () => {
    expect(editedHtml({ isEditable: false, getHTML: () => '<h1>Globex — Mutual NDA</h1><p>Body</p>' })).toBeNull()
  })

  it('an editable canvas reports its HTML', () => {
    expect(editedHtml({ isEditable: true, getHTML: () => '<p>Changed</p>' })).toBe('<p>Changed</p>')
  })
})
