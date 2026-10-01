/**
 * The defined terms of the version on screen (docs/41 Part 10), from
 * GET /contracts/:id/defined-terms (worked out on the server, the same way on
 * every analysis).
 *
 *   useDefinedTerms       loads them and gives the glossary to the canvas,
 *                         where hovering a term shows its definition;
 *   DefinedTermsGlossary  the "Defined terms" list inside the Review panel's
 *                         Drafting group: each term, how often it is used, and
 *                         its definition, shown in the document on click; and
 *                         "Apply defined term everywhere" for variants typed
 *                         since.
 *
 * The drafting problems themselves (a term not defined, defined twice…) are
 * review findings now, listed with the others in the Review panel.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Wand2, BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import {
  getLexiconState,
  normalizeDefinedTerms,
  revealInCanvas,
  updateDefinedTermGlossary,
} from '@/components/editor/DefinedTermGuard'

interface GlossaryEntry { term: string; definition: string; offset: number; uses: number }

interface DefinedTermsResponse { versionId: string; glossary: GlossaryEntry[] }

const keyOf = (contractId: string | undefined, versionId: string | null | undefined) => ['contract-defined-terms', contractId, versionId ?? null]

/** The version's glossary; the canvas shows a term's definition on hover. */
export function useDefinedTerms(contractId: string | undefined, versionId: string | null | undefined, editor: Editor | null) {
  const query = useQuery({
    queryKey: keyOf(contractId, versionId),
    enabled: !!contractId,
    queryFn: async () => (await api.get<DefinedTermsResponse>(
      `/contracts/${contractId}/defined-terms`, { params: versionId ? { versionId } : undefined },
    )).data,
  })
  const data = query.data
  useEffect(() => {
    if (!editor || !data) return
    updateDefinedTermGlossary(editor, data.glossary.map(g => ({ term: g.term, definition: g.definition })))
  }, [editor, data])
  return data
}

export function DefinedTermsGlossary({
  contractId,
  versionId,
  editor,
  canEdit = true,
}: {
  contractId: string | undefined
  versionId?: string | null
  editor: Editor | null
  canEdit?: boolean
}) {
  // Same query as the page's useDefinedTerms: read once.
  const data = useDefinedTerms(contractId, versionId, editor)

  // Variants the author typed since (the fix button rewrites them in the canvas).
  const [localFlags, setLocalFlags] = useState(0)
  useEffect(() => {
    if (!editor) return
    const tick = () => setLocalFlags(getLexiconState(editor)?.flags.length ?? 0)
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
  }, [editor])

  const [open, setOpen] = useState(false)

  if (!contractId || !data) return null
  const { glossary } = data
  if (glossary.length === 0 && localFlags === 0) return null
  const show = (text: string) => { if (editor) revealInCanvas(editor, text) }

  return (
    <div className="space-y-1.5" data-testid="defined-terms-section">
      {/* X75 review — it edits the document, which a viewer can't save. */}
      {canEdit && localFlags > 0 && editor && (
        <Button
          size="sm"
          variant="assistOutline"
          onClick={() => normalizeDefinedTerms(editor)}
          data-testid="defined-terms-normalize-btn"
          className="gap-1 text-[11px]"
        >
          <Wand2 className="size-3" />
          Apply defined term everywhere
        </Button>
      )}

      {glossary.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-ink-700 hover:text-ink-950"
            data-testid="defined-terms-glossary-toggle"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Defined terms ({glossary.length})
          </button>
          {open && (
            <ul className="mt-1 space-y-1" data-testid="defined-terms-list">
              {glossary.map(g => (
                <li key={g.term} data-testid={`defined-term-${g.term.toLowerCase().replace(/\s+/g, '-')}`}>
                  <button
                    type="button"
                    onClick={() => show(g.definition)}
                    className="w-full text-left text-[10.5px] leading-snug hover:bg-paper-50 rounded px-1 py-0.5"
                    title="Show the definition in the document"
                  >
                    <span className="inline-flex items-center gap-0.5 font-medium text-assist-900">
                      <BookOpen className="size-2.5" />
                      {g.term}
                    </span>
                    <span className="text-ink-400 tabular-nums"> · used {g.uses}×</span>
                    <div className="text-muted-foreground line-clamp-2">{g.definition}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
