/**
 * X47 — opening a contract saved a new version: TipTap's mount-time
 * `update` (from setEditable, which changes nothing) was reported as an
 * edit, and the page autosaves every edit it is told about.
 */
import { describe, it, expect } from 'vitest'
import { editedHtml } from './canvas-update'

const editor = { getHTML: () => '<h1>Globex — Mutual NDA</h1><p>Body</p>' }

describe('editedHtml', () => {
  it('an update that changed nothing is no edit', () => {
    expect(editedHtml({ editor, transaction: { docChanged: false } })).toBeNull()
  })

  it('a change to the document is, typed or made by a command while the canvas is read-only', () => {
    expect(editedHtml({ editor, transaction: { docChanged: true } })).toBe('<h1>Globex — Mutual NDA</h1><p>Body</p>')
  })
})
