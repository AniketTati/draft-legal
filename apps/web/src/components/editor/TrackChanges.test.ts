// @vitest-environment happy-dom
/**
 * docs/41 Part 16 (C4) — suggestion mode: typing, deleting and typing over a
 * selection become suggestions with their author; accept and reject, one or
 * all; and the marks survive the trip through the document's HTML.
 */
import { describe, it, expect } from 'vitest'
import { getSchema, createDocument, getHTMLFromFragment } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import { Deletion, Insertion, acceptedHtml, decideSuggestions, suggestionsIn, trackEdit, type SuggestionAuthor } from './TrackChanges'

const schema = getSchema([StarterKit, Insertion, Deletion])
const asha: SuggestionAuthor = { id: 'u1', name: 'Asha' }
const ben: SuggestionAuthor = { id: 'u2', name: 'Ben' }

function stateOf(html: string, author: SuggestionAuthor = asha) {
  const plugin = new Plugin({ appendTransaction: (trs, o, n) => (trs.length === 1 ? trackEdit(trs[0], o, n, author) : null) })
  return EditorState.create({ schema, doc: createDocument(html, schema), plugins: [plugin] })
}
const html = (s: EditorState) => getHTMLFromFragment(s.doc.content, schema)
/** Position of the first `text` in the (single-paragraph) document. */
const at = (s: EditorState, text: string) => s.doc.textContent.indexOf(text) + 1
const apply = (s: EditorState, f: (tr: EditorState['tr']) => EditorState['tr']) => s.apply(f(s.tr))
const reapply = (s: EditorState, f: (tr: EditorState['tr']) => EditorState['tr']) => s.applyTransaction(f(s.tr)).state

describe('suggestion mode', () => {
  it('typing inserts words marked as Asha’s insertion', () => {
    let s = stateOf('<p>The fee is ten dollars.</p>')
    s = reapply(s, tr => tr.insertText('only ', at(s, 'ten')))
    const [c] = suggestionsIn(s.doc)
    expect(c).toMatchObject({ kind: 'insertion', authorId: 'u1', authorName: 'Asha', text: 'only ' })
    expect(s.doc.textContent).toBe('The fee is only ten dollars.')
  })

  it('consecutive keystrokes are one change', () => {
    let s = stateOf('<p>Pay now.</p>')
    s = reapply(s, tr => tr.setSelection(TextSelection.create(tr.doc, at(s, 'now'))))
    for (const ch of 'abc') s = reapply(s, tr => tr.insertText(ch))
    expect(s.doc.textContent).toBe('Pay abcnow.')
    expect(suggestionsIn(s.doc).filter(c => c.kind === 'insertion')).toHaveLength(1)
  })

  it('deleting marks the words deleted instead of removing them', () => {
    let s = stateOf('<p>The fee is ten dollars.</p>')
    const from = at(s, 'ten ')
    s = reapply(s, tr => tr.delete(from, from + 4))
    expect(s.doc.textContent).toBe('The fee is ten dollars.')
    expect(suggestionsIn(s.doc)).toMatchObject([{ kind: 'deletion', text: 'ten ', authorName: 'Asha' }])
  })

  it('Backspace leaves the caret before the deleted letter, so the next one goes on leftwards', () => {
    let s = stateOf('<p>abc</p>')
    s = reapply(s, tr => tr.setSelection(TextSelection.create(tr.doc, 4)))
    s = reapply(s, tr => tr.delete(3, 4))
    expect(s.selection.from).toBe(3)
    s = reapply(s, tr => tr.delete(2, 3))
    expect(s.doc.textContent).toBe('abc')
    expect(suggestionsIn(s.doc)).toMatchObject([{ kind: 'deletion', text: 'bc' }])
  })

  it('typing over a selection is a deletion then an insertion', () => {
    let s = stateOf('<p>The fee is ten dollars.</p>')
    const from = at(s, 'ten')
    s = reapply(s, tr => tr.insertText('twenty', from, from + 3))
    expect(s.doc.textContent).toBe('The fee is tentwenty dollars.')
    expect(suggestionsIn(s.doc).map(c => [c.kind, c.text])).toEqual([['deletion', 'ten'], ['insertion', 'twenty']])
  })

  it('deleting words only suggested removes them for good', () => {
    let s = stateOf('<p>Pay now.</p>')
    s = reapply(s, tr => tr.insertText('today ', at(s, 'now')))
    const from = at(s, 'today')
    s = reapply(s, tr => tr.delete(from, from + 6))
    expect(s.doc.textContent).toBe('Pay now.')
    expect(suggestionsIn(s.doc)).toEqual([])
  })

  it('each author’s changes are their own', () => {
    let s = stateOf('<p>Pay now.</p>')
    s = reapply(s, tr => tr.insertText('A ', at(s, 'now')))
    const t = stateOf(html(s), ben)
    const u = reapply(t, tr => tr.insertText('B ', at(t, 'now')))
    expect(suggestionsIn(u.doc).map(c => c.authorName)).toEqual(['Asha', 'Ben'])
  })
})

describe('accept and reject', () => {
  const start = () => {
    let s = stateOf('<p>The fee is ten dollars.</p>')
    const from = at(s, 'ten')
    s = reapply(s, tr => tr.insertText('twenty', from, from + 3))
    return s
  }

  it('accepting a deletion removes its words; rejecting an insertion removes its words', () => {
    const s = start()
    const [del, ins] = suggestionsIn(s.doc)
    const a = s.apply(decideSuggestions(s, del.id, 'accept')!)
    expect(a.doc.textContent).toBe('The fee is twenty dollars.')
    const b = a.apply(decideSuggestions(a, ins.id, 'reject')!)
    expect(b.doc.textContent).toBe('The fee is  dollars.')
  })

  it('Accept all keeps the new words; Reject all gives the original back', () => {
    const s = start()
    const acc = s.apply(decideSuggestions(s, null, 'accept')!)
    expect(acc.doc.textContent).toBe('The fee is twenty dollars.')
    expect(suggestionsIn(acc.doc)).toEqual([])
    const rej = s.apply(decideSuggestions(s, null, 'reject')!)
    expect(rej.doc.textContent).toBe('The fee is ten dollars.')
  })

  it('a decision is not itself tracked', () => {
    const s = start()
    const next = s.applyTransaction(decideSuggestions(s, null, 'reject')!).state
    expect(suggestionsIn(next.doc)).toEqual([])
  })

  it('nothing to decide: null', () => {
    const s = stateOf('<p>Plain.</p>')
    expect(decideSuggestions(s, null, 'accept')).toBeNull()
    void apply
  })
})

describe('HTML', () => {
  it('stores suggestions as <ins>/<del> with the change id, author and time, and reads them back', () => {
    let s = stateOf('<p>The fee is ten dollars.</p>')
    const from = at(s, 'ten')
    s = reapply(s, tr => tr.insertText('twenty', from, from + 3))
    const out = html(s)
    expect(out).toMatch(/<del data-change-id="s[^"]+" data-author-id="u1" data-color="\d" data-author="Asha" data-time="\d{4}-[^"]+" class="suggestion suggestion-del">ten<\/del>/)
    expect(out).toMatch(/<ins data-change-id="[^"]+"[^>]*data-author="Asha"[^>]*>twenty<\/ins>/)
    const back = EditorState.create({ schema, doc: createDocument(out, schema) })
    expect(suggestionsIn(back.doc)).toEqual(suggestionsIn(s.doc))
    expect(html(back)).toBe(out)
  })

  it('a plain <del> (struck-through text) stays strike, not a suggestion', () => {
    const s = EditorState.create({ schema, doc: createDocument('<p><del>old</del> text</p>', schema) })
    expect(suggestionsIn(s.doc)).toEqual([])
    expect(html(s)).toContain('<s>old</s>')
  })

  it('acceptedHtml reads the document as if every suggestion were accepted', () => {
    expect(acceptedHtml('<p>The fee is <del data-change-id="a" data-author="A">ten</del><ins data-change-id="b">twenty</ins> dollars.</p>'))
      .toBe('<p>The fee is twenty dollars.</p>')
  })
})

describe('in a TipTap editor', () => {
  it('suggests while on, and the accept / reject commands decide', async () => {
    const { Editor } = await import('@tiptap/core')
    const { TrackChanges } = await import('./TrackChanges')
    const editor = new Editor({ extensions: [StarterKit, TrackChanges], content: '<p>The fee is ten dollars.</p>' })
    editor.commands.setSuggesting(true, asha)
    const from = editor.state.doc.textContent.indexOf('ten') + 1
    editor.chain().setTextSelection({ from, to: from + 3 }).insertContent('twenty').run()
    expect(editor.getHTML()).toContain('<del data-change-id=')
    const [del, ins] = suggestionsIn(editor.state.doc)
    expect(editor.commands.rejectSuggestion(ins.id)).toBe(true)
    expect(editor.commands.rejectSuggestion(del.id)).toBe(true)
    expect(editor.getText()).toBe('The fee is ten dollars.')
    editor.commands.setSuggesting(false)
    editor.chain().setTextSelection({ from, to: from + 3 }).insertContent('nine').run()
    expect(editor.getText()).toBe('The fee is nine dollars.')
    expect(editor.commands.acceptAllSuggestions()).toBe(false)
    editor.destroy()
  })
})
