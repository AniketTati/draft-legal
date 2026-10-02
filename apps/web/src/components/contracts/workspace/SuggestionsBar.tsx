/**
 * docs/41 Part 16 (C4) — the workspace header's suggestion controls: whether
 * edits are suggestions (always while negotiating; a toggle otherwise), how
 * many are waiting, and Accept all / Reject all.
 */
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { Check, PencilLine, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { suggestionsIn, type SuggestionRange } from '@/components/editor/TrackChanges'

/** Decision: suggestion mode is on by itself once the contract is negotiated. */
export const suggestingByDefault = (stage: string | null | undefined) => stage === 'negotiate'

/** The people who made the suggestions, for "Document discussion" by person. */
export function suggestionPeople(list: SuggestionRange[]): Array<{ id: string; name: string; count: number }> {
  const by = new Map<string, { id: string; name: string; count: number }>()
  for (const s of list) {
    if (!s.authorId) continue
    const id = s.authorId.startsWith('portal:') ? 'portal' : s.authorId
    const p = by.get(id) ?? { id, name: id === 'portal' ? 'Counterparty' : s.authorName || 'Someone', count: 0 }
    p.count++
    by.set(id, p)
  }
  return [...by.values()]
}

/** The editor's pending suggestions, kept up to date as it changes. */
export function useSuggestions(editor: Editor | null): SuggestionRange[] {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? suggestionsIn(e.state.doc) : []),
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  }) ?? []
}

export function SuggestionsBar({ editor, count, suggesting, forced, canEdit, onToggle }: {
  editor: Editor | null
  count: number
  suggesting: boolean
  /** On because of the stage: shown, not offered as a toggle. */
  forced: boolean
  canEdit: boolean
  onToggle: (on: boolean) => void
}) {
  if (!canEdit && !count) return null
  return (
    <div className="flex items-center gap-1.5" data-testid="suggestions-bar">
      {canEdit && (forced ? (
        <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-700" title="While negotiating, your edits are suggestions the other side can accept or reject" data-testid="suggesting-on">
          <PencilLine className="size-3.5" />Suggesting
        </span>
      ) : (
        <Button size="sm" variant={suggesting ? 'default' : 'outline'} aria-pressed={suggesting} onClick={() => onToggle(!suggesting)} data-testid="suggesting-toggle" title="Make your edits suggestions">
          <PencilLine />Suggesting
        </Button>
      ))}
      {count > 0 && (
        <>
          <span className="text-[11.5px] text-ink-500" data-testid="suggestions-count">{count} suggestion{count === 1 ? '' : 's'}</span>
          {canEdit && (
            <>
              <Button size="sm" variant="ghost" onClick={() => editor?.chain().focus().acceptAllSuggestions().run()} data-testid="suggestions-accept-all"><Check />Accept all</Button>
              <Button size="sm" variant="ghost" onClick={() => editor?.chain().focus().rejectAllSuggestions().run()} data-testid="suggestions-reject-all"><X />Reject all</Button>
            </>
          )}
        </>
      )}
    </div>
  )
}
