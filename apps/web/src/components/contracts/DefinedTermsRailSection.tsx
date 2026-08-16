/**
 * DefinedTermsRailSection (P6.4 / docs/30 Wave G.4)
 *
 * Reads the DefinedTermGuard extension's state directly off the
 * editor (via getLexiconState) and renders:
 *   • the canonical defined terms found in the doc (count pill)
 *   • the list of inconsistent usages the author introduced
 *   • an "Apply defined term everywhere" button that rewrites the
 *     variants in a single tx
 *
 * The section only appears when at least one defined term was
 * extracted — untrained drafts stay quiet.
 */
import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { Wand2, BookOpen } from 'lucide-react'
import {
  getLexiconState,
  normalizeDefinedTerms,
  type DefinedTerm,
  type TermFlag,
} from '@/components/editor/DefinedTermGuard'

export function DefinedTermsRailSection({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<{ terms: DefinedTerm[]; flags: TermFlag[] }>({ terms: [], flags: [] })

  // Poll the plugin state — cheap (one object fetch). Avoids wiring
  // a second React-Tiptap bridge for just this rail.
  useEffect(() => {
    if (!editor) return
    const tick = () => {
      const s = getLexiconState(editor)
      if (s) setState({ terms: s.terms, flags: s.flags })
    }
    tick()
    const id = setInterval(tick, 1200)
    return () => clearInterval(id)
  }, [editor])

  if (!editor || state.terms.length === 0) return null

  const handleNormalize = () => {
    const n = normalizeDefinedTerms(editor)
    if (n === 0) return
    // force a rescan via the plugin's next update tick
  }

  return (
    <RailSection
      title="Defined terms"
      defaultOpen
      count={state.flags.length > 0 ? state.flags.length : null}
    >
      <div className="space-y-2" data-testid="defined-terms-section">
        {/* A defined term is something the model found, not a state the contract
            is in — so these wear the assist accent that marks the dotted
            underline in the document, not the in-flight blue. */}
        <div className="flex flex-wrap gap-1" data-testid="defined-terms-list">
          {state.terms.map(t => (
            <span
              key={t.canonical}
              className="inline-flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-chip bg-assist-50 text-assist-900 border border-assist-200"
              data-testid={`defined-term-${t.canonical.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <BookOpen className="size-2.5" />
              {t.canonical}
            </span>
          ))}
        </div>

        {state.flags.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic">
            All usages match their canonical form.
          </div>
        ) : (
          <>
            <div className="text-[11px] text-ink-700" data-testid="defined-terms-flag-count">
              <span className="font-medium text-assist-700 tabular-nums">{state.flags.length} inconsistent usage{state.flags.length === 1 ? '' : 's'}</span> — the author typed a variant of a defined term.
            </div>
            <ul className="space-y-1">
              {state.flags.slice(0, 6).map((f, i) => (
                <li
                  key={i}
                  className="text-[11px] border border-border rounded-md px-2 py-1 bg-card/60 flex items-center justify-between"
                  data-testid={`defined-term-flag-${i}`}
                >
                  <span>
                    <span className="font-mono text-assist-700 underline decoration-dotted">{f.found}</span>
                    {' → '}
                    <span className="font-mono font-medium text-ink-950">{f.term}</span>
                  </span>
                </li>
              ))}
              {state.flags.length > 6 && (
                <li className="text-[10px] text-muted-foreground">…and {state.flags.length - 6} more</li>
              )}
            </ul>
            <Button
              size="sm"
              variant="assistOutline"
              onClick={handleNormalize}
              data-testid="defined-terms-normalize-btn"
              className="gap-1 text-[11px]"
            >
              <Wand2 className="size-3" />
              Apply defined term everywhere
            </Button>
          </>
        )}
      </div>
    </RailSection>
  )
}
