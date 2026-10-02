/**
 * docs/41 Part 16 — putting AI wording into the document "as a tracked change".
 *
 * Until suggestion marks exist (C4), this replaces the words in the editor —
 * so they go into the draft changes like any edit — and highlights what was
 * put in. C4 swaps this one function for real insert/delete marks with the
 * author and time; every caller (Ask AI, insert standard, Counter) goes
 * through here so nothing else has to change.
 */
import type { Editor } from '@tiptap/react'
import { revealRange } from '@/components/contracts/SourceHighlight'

export interface InsertRange { from: number; to: number }

/** Replace `range` with `text` and mark it; returns where the new words are, or null. */
export function insertAsTrackedChange(editor: Editor | null, range: InsertRange | null, text: string): InsertRange | null {
  if (!editor || editor.isDestroyed || !text.trim()) return null
  const from = range?.from ?? editor.state.selection.from
  const to = range?.to ?? editor.state.selection.to
  const before = editor.state.doc.content.size
  const ok = editor.chain().focus().setTextSelection({ from, to }).deleteSelection().insertContent(text).run()
  if (!ok) return null
  const end = to + (editor.state.doc.content.size - before)
  revealRange(editor, from, end)
  return { from, to: end }
}

/** Replace `range` with `text`, untracked. */
export function replaceRange(editor: Editor | null, range: InsertRange | null, text: string): boolean {
  if (!editor || editor.isDestroyed || !text.trim()) return false
  const chain = editor.chain().focus()
  return (range ? chain.setTextSelection(range) : chain).deleteSelection().insertContent(text).run()
}
