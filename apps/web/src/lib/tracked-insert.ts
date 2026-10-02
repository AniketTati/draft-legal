/**
 * docs/41 Part 16 — putting AI wording into the document "as a tracked change".
 *
 * C4: a real suggestion now. The words replaced are marked deleted and the
 * new ones inserted, by the person who chose them (the editor's suggestion
 * author), whether or not the editor is in suggestion mode: AI wording is
 * always put forward for review, never slipped in. Every caller (Ask AI,
 * insert standard, Counter) goes through here.
 *
 * It also remembers what AI wording went in, so that saving a version can
 * log "edited" for wording someone changed before saving (aiEditsAtSave).
 */
import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import { findInCanvas, revealRange } from '@/components/contracts/SourceHighlight'
import type { AiEvent, AiFeature } from '@/lib/ai-events'
import type { CounterAnchor } from '@/lib/changes'

export interface InsertRange { from: number; to: number }

/** AI wording put in, per contract, until the next version is saved. */
interface AiInsert { feature: AiFeature; suggestionId: string | null; versionId: string | null; text: string }
const inserted = new Map<string, AiInsert[]>()

/** Replace `range` with `text` as a suggestion; returns where the new words are, or null. */
export function insertAsTrackedChange(
  editor: Editor | null, range: InsertRange | null, text: string,
  ai?: { contractId: string; feature: AiFeature; suggestionId?: string | null; versionId?: string | null },
): InsertRange | null {
  if (!editor || editor.isDestroyed || !text.trim()) return null
  const from = range?.from ?? editor.state.selection.from
  const to = range?.to ?? editor.state.selection.to
  const before = editor.state.doc.content.size
  // Suggesting just for this edit, when there is someone to attribute it to.
  const track = editor.storage.trackChanges
  const was = track?.enabled ?? false
  const tracked = !!track?.author
  if (track && tracked) track.enabled = true
  const ok = (() => {
    try { return editor.chain().focus().setTextSelection({ from, to }).insertContent(text).run() }
    finally { if (track) track.enabled = was }
  })()
  if (!ok) return null
  const grew = editor.state.doc.content.size - before
  // Tracked: the replaced words stay (marked deleted) and the new ones follow them.
  const placed = tracked ? { from: to, to: to + grew } : { from, to: to + grew }
  revealRange(editor, placed.from, placed.to)
  if (ai?.contractId) {
    const list = inserted.get(ai.contractId) ?? []
    list.push({ feature: ai.feature, suggestionId: ai.suggestionId ?? null, versionId: ai.versionId ?? null, text })
    inserted.set(ai.contractId, list)
  }
  return placed
}

/**
 * Changes mode's Counter: the drafted wording as a suggestion in place of
 * their words, or beside the gap where they only removed words. Null when
 * the anchor's words aren't in the document.
 */
export function insertCounter(
  editor: Editor | null, anchor: CounterAnchor, text: string,
  ai: { contractId: string; suggestionId?: string | null; versionId?: string | null },
): InsertRange | null {
  const found = findInCanvas(editor, anchor.quote)
  if (!found || !text.trim()) return null
  const words = text.trim()
  const range = anchor.at === 'replace' ? found : anchor.at === 'after' ? { from: found.to, to: found.to } : { from: found.from, to: found.from }
  const put = anchor.at === 'after' ? ` ${words}` : anchor.at === 'before' ? `${words} ` : words
  return insertAsTrackedChange(editor, range, put, { ...ai, feature: 'counter' })
}

/** Replace `range` with `text`, untracked. */
export function replaceRange(editor: Editor | null, range: InsertRange | null, text: string): boolean {
  if (!editor || editor.isDestroyed || !text.trim()) return false
  const chain = editor.chain().focus()
  return (range ? chain.setTextSelection(range) : chain).deleteSelection().insertContent(text).run()
}

/** The document's words as they read with every suggestion accepted. */
export function acceptedText(doc: PMNode): string {
  let out = ''
  doc.descendants(node => {
    if (node.isText) { if (!node.marks.some(m => m.type.name === 'deletion')) out += node.text ?? ''; return false }
    if (node.isBlock && out && !out.endsWith('\n')) out += '\n'
    return true
  })
  return out
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * At "Save as version": the AI wording put in since the last save that no
 * longer reads as it was inserted is "edited" (changed or removed by a
 * person). Returns those outcomes to log and forgets the contract's inserts.
 */
export function aiEditsAtSave(contractId: string, doc: PMNode | null | undefined): AiEvent[] {
  const list = inserted.get(contractId) ?? []
  inserted.delete(contractId)
  if (!doc || !list.length) return []
  const text = norm(acceptedText(doc))
  return list.filter(i => !text.includes(norm(i.text)))
    .map(i => ({ contractId, versionId: i.versionId, feature: i.feature, outcome: 'edited' as const, suggestionId: i.suggestionId }))
}
