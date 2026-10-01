/**
 * docs/41 P1 (Part 8) — "Fix all fixable": the rewrites drafted for the
 * review's findings, each shown with the current wording and the proposed
 * one, for the reviewer to accept change by change. Nothing reaches the
 * document until they apply what they accepted, as one new version.
 *
 * Moved here from the Playbook redline rail section, which the Review panel
 * replaces. It still says what wasn't rewritten: a clause the rewriter
 * failed on reads as "no change needed" if it is left out.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { AssistMark } from '@/components/ui/assist'
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react'

export interface StagedProposal {
  clauseId:      string
  clauseType:    string | null
  sectionRef:    string | null
  originalText:  string
  proposedText?: string
  rationale?:    string
  severity?:     string | null
  error?:        string
}

export interface StagedFixes {
  versionId:  string
  proposals:  StagedProposal[]
  stagedAt?:  string
  appliedAt?: string
}

const humanType = (t: string | null) => (t ?? 'clause').replace(/_/g, ' ')

export function FixPreview({ contractId, staged, onApplied }: { contractId: string; staged: StagedFixes; onApplied?: () => void }) {
  const qc = useQueryClient()
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const usable = useMemo(() => staged.proposals.filter(p => p.proposedText), [staged])
  const failed = useMemo(() => staged.proposals.filter(p => p.error && !p.error.startsWith('not_this_clause_type')), [staged])

  const apply = useMutation({
    meta: { errorHandled: true },
    mutationFn: (clauseIds: string[]) => api.post(`/contracts/${contractId}/redline-against-playbook/apply`, { acceptedClauseIds: clauseIds }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-clauses', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-review', contractId] })
      setAccepted(new Set())
      onApplied?.()
    },
  })
  const toggle = (id: string) => setAccepted(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  if (staged.appliedAt) return null
  return (
    <div className="space-y-2" data-testid="fix-preview">
      <p className="text-[11px] text-ink-700">
        {usable.length} change{usable.length === 1 ? '' : 's'} drafted. Accept the ones you want; nothing changes until you apply them.
      </p>
      {failed.length > 0 && (
        <p className="text-[11px] text-attention-700 bg-attention-50 border border-attention-200 rounded-md px-2 py-1">
          {failed.length} clause{failed.length === 1 ? '' : 's'} could not be rewritten ({failed.map(f => humanType(f.clauseType)).join(', ')}). Fix {failed.length === 1 ? 'it' : 'them'} by hand.
        </p>
      )}
      <ul className="space-y-1.5">
        {usable.map(p => {
          const isOpen = expanded === p.clauseId
          const isAccepted = accepted.has(p.clauseId)
          return (
            <li key={p.clauseId} className="rounded-md border border-paper-200">
              <div className="flex items-start gap-1.5 p-2">
                <button onClick={() => setExpanded(isOpen ? null : p.clauseId)} className="mt-0.5 text-ink-400 hover:text-ink-700" aria-label={isOpen ? 'Collapse' : 'Expand'}>
                  {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-medium text-ink-950 capitalize">{humanType(p.clauseType)}</span>
                  {p.sectionRef && <span className="text-[10px] text-ink-400 ml-1">§{p.sectionRef}</span>}
                  {p.rationale && !isOpen && <p className="text-[11px] text-ink-500 mt-0.5 line-clamp-2">{p.rationale}</p>}
                </div>
                <button
                  onClick={() => toggle(p.clauseId)}
                  aria-pressed={isAccepted}
                  className={`shrink-0 size-6 rounded-md border flex items-center justify-center transition-colors ${isAccepted ? 'bg-brand-700 border-brand-700 text-white' : 'border-paper-300 text-ink-400 hover:border-brand-700 hover:text-brand-700'}`}
                  title={isAccepted ? 'Accepted — click to undo' : 'Accept this change'}
                  data-testid={`fix-accept-${p.clauseId}`}
                >
                  {isAccepted ? <Check className="size-3.5" /> : <X className="size-3" />}
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-paper-100 px-2 py-2 space-y-1.5">
                  {p.rationale && <p className="text-[11px] text-ink-700">{p.rationale}</p>}
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.07em] text-ink-400 mb-0.5">Current</p>
                    <p className="text-[11px] text-ink-700 bg-paper-100 rounded-chip px-1.5 py-1 whitespace-pre-line">{p.originalText}</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.07em] text-assist-700 mb-0.5"><AssistMark className="size-[5px]" />Proposed</p>
                    <p className="text-[11px] text-assist-900 bg-assist-50 rounded-chip px-1.5 py-1 whitespace-pre-line">{p.proposedText}</p>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {usable.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1 border-t">
          <Button size="sm" variant="outline" className="text-[11px] h-7" onClick={() => setAccepted(new Set(usable.map(p => p.clauseId)))}>Accept all</Button>
          <Button size="sm" className="flex-1 gap-1.5 h-7 text-[11px]" disabled={accepted.size === 0 || apply.isPending} onClick={() => apply.mutate([...accepted])} data-testid="fix-apply">
            <Check className="h-3.5 w-3.5" />
            {apply.isPending ? 'Applying…' : `Apply ${accepted.size} change${accepted.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
      {apply.isError && (
        <p className="text-[11px] text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-2 py-1">
          {(apply.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Those changes could not be applied.'}
        </p>
      )}
    </div>
  )
}
