/**
 * DefinedTermsRailSection — "Drafting" (docs/41 Part 10)
 *
 * The defined-terms problems of the version on screen, from
 * GET /contracts/:id/defined-terms (worked out on the server, the same way on
 * every analysis):
 *   • a capitalised term used but never defined
 *   • a term defined but never used (often a clause that was deleted)
 *   • a term defined twice, or in different ways
 *   • a term used before its definition
 *   • a defined term written in another case
 * and the glossary. Clicking a problem or a term shows it in the document;
 * the glossary also goes to the canvas, where hovering a term shows its
 * definition.
 *
 * (These join the one Review panel later; for now they have this section.)
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { Wand2, BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import {
  getLexiconState,
  normalizeDefinedTerms,
  revealInCanvas,
  updateDefinedTermGlossary,
} from '@/components/editor/DefinedTermGuard'

type IssueKind = 'undefined_term' | 'unused_definition' | 'duplicate_definition' | 'used_before_defined' | 'capitalisation_drift'

interface DraftingIssue {
  kind: IssueKind
  term: string
  severity: 'low' | 'medium' | 'high'
  message: string
  evidence: { quote: string; offset: number }
  count?: number
  related?: { quote: string; offset: number }
}

interface GlossaryEntry { term: string; definition: string; offset: number; uses: number }

interface DefinedTermsResponse { versionId: string; glossary: GlossaryEntry[]; issues: DraftingIssue[] }

const KIND_LABEL: Record<IssueKind, string> = {
  undefined_term:       'Not defined',
  unused_definition:    'Defined, not used',
  duplicate_definition: 'Defined twice',
  used_before_defined:  'Used before its definition',
  capitalisation_drift: 'Written differently',
}

const KIND_ORDER: IssueKind[] = ['duplicate_definition', 'undefined_term', 'unused_definition', 'used_before_defined', 'capitalisation_drift']

const SEVERITY_CLS: Record<DraftingIssue['severity'], string> = {
  high:   'text-risk-700 bg-risk-50 border-risk-200',
  medium: 'text-attention-700 bg-attention-50 border-attention-200',
  low:    'text-ink-500 bg-paper-50 border-paper-200',
}

export function DefinedTermsRailSection({
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
  const query = useQuery({
    queryKey: ['contract-defined-terms', contractId, versionId ?? null],
    enabled: !!contractId,
    queryFn: async () => (await api.get<DefinedTermsResponse>(
      `/contracts/${contractId}/defined-terms`, { params: versionId ? { versionId } : undefined },
    )).data,
  })
  const data = query.data

  // The canvas shows a term's definition on hover.
  useEffect(() => {
    if (!editor || !data) return
    updateDefinedTermGlossary(editor, data.glossary.map(g => ({ term: g.term, definition: g.definition })))
  }, [editor, data])

  // Variants the author typed since (the fix button rewrites them in the canvas).
  const [localFlags, setLocalFlags] = useState(0)
  useEffect(() => {
    if (!editor) return
    const tick = () => setLocalFlags(getLexiconState(editor)?.flags.length ?? 0)
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
  }, [editor])

  const [showGlossary, setShowGlossary] = useState(false)

  if (!contractId || !data) return null
  const { glossary, issues } = data
  if (glossary.length === 0 && issues.length === 0) return null

  const show = (text: string) => { if (editor) revealInCanvas(editor, text) }
  const sorted = [...issues].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.evidence.offset - b.evidence.offset)

  return (
    <RailSection title="Drafting" defaultOpen count={issues.length > 0 ? issues.length : null}>
      <div className="space-y-2" data-testid="defined-terms-section">
        {issues.length === 0 ? (
          <div className="text-[11px] text-muted-foreground" data-testid="drafting-clean">
            {glossary.length} defined term{glossary.length === 1 ? '' : 's'}, each defined once and used as defined.
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="drafting-issues">
            {sorted.slice(0, 30).map((i, n) => (
              <li key={`${i.kind}-${i.term}-${n}`} data-testid={`drafting-issue-${i.kind}`} data-term={i.term}>
                <button
                  type="button"
                  onClick={() => show(i.evidence.quote)}
                  className="w-full text-left text-[11px] border border-border rounded-md px-2 py-1.5 bg-card/60 hover:bg-paper-50"
                  title="Show in the document"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9.5px] uppercase tracking-wider border rounded-chip px-1 ${SEVERITY_CLS[i.severity]}`}>
                      {KIND_LABEL[i.kind]}
                    </span>
                    {i.count && i.count > 1 && <span className="ml-auto text-[10px] text-ink-500 tabular-nums">{i.count}×</span>}
                  </div>
                  <div className="mt-0.5 text-ink-950 leading-snug">{i.message}</div>
                  <div className="mt-0.5 border-l-2 border-paper-200 pl-1.5 italic text-ink-500 leading-snug line-clamp-2">
                    “{i.evidence.quote}”
                  </div>
                </button>
              </li>
            ))}
            {sorted.length > 30 && <li className="text-[10px] text-muted-foreground">…and {sorted.length - 30} more</li>}
          </ul>
        )}

        {/* X75 review — it edits the document, which a viewer can't save. */}
        {canEdit && localFlags > 0 && (
          <Button
            size="sm"
            variant="assistOutline"
            onClick={() => normalizeDefinedTerms(editor!)}
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
              onClick={() => setShowGlossary(v => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-ink-700 hover:text-ink-950"
              data-testid="defined-terms-glossary-toggle"
            >
              {showGlossary ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Defined terms ({glossary.length})
            </button>
            {showGlossary && (
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
    </RailSection>
  )
}
