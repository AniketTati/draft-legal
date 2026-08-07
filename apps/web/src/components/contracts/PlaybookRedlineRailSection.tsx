/**
 * PlaybookRedlineRailSection (Phase 3 — full-document redlining)
 *
 * "Redline against our playbook" for the whole contract: fires the pipeline,
 * polls it, then shows every proposed change so a reviewer can accept the ones
 * they want. Nothing reaches the document until they do — the pipeline stages,
 * it does not apply.
 *
 * Two things this deliberately surfaces that are easy to leave out:
 *
 *   - Clauses the checker could NOT judge (no playbook position, or a position
 *     with no rules). "We found nothing wrong" and "we did not look" are
 *     different answers, and only one of them means the document is clean.
 *   - Clauses the rewriter failed on. An omitted clause reads as "no change
 *     needed", which is the silent miss this whole feature exists to remove.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { Wand2, Check, X, AlertTriangle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

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

export interface StagedRedline {
  versionId:         string
  aggression:        string
  proposals:         StagedProposal[]
  deviationCount:    number
  proposedCount?:    number
  failedCount?:      number
  worstSeverity?:    string | null
  truncated?:        boolean
  uncoveredClauses?: number
  stagedAt?:         string
  acceptedClauseIds?: string[]
  note?:             string
}

type Status = 'IDLE' | 'QUEUED' | 'RUNNING' | 'DONE' | 'APPLIED' | 'FAILED'

const SEVERITY_STYLE: Record<string, string> = {
  walkaway: 'bg-red-100 text-red-800 border-red-200',
  critical: 'bg-red-100 text-red-800 border-red-200',
  high:     'bg-orange-100 text-orange-800 border-orange-200',
  medium:   'bg-amber-100 text-amber-800 border-amber-200',
  low:      'bg-slate-100 text-slate-700 border-slate-200',
}

export function PlaybookRedlineRailSection({
  contractId,
  status,
  staged,
  error,
}: {
  contractId: string
  status:     Status
  staged?:    StagedRedline | null
  error?:     string | null
}) {
  const qc = useQueryClient()
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)

  const running = status === 'QUEUED' || status === 'RUNNING'

  const start = useMutation({
    mutationFn: () =>
      api.post(`/contracts/${contractId}/redline-against-playbook`, { aggression: 'moderate' })
        .then(r => r.data),
    // Invalidating is enough because ContractDetailPage's refetchInterval
    // lists _playbookRedlineStatus among the in-flight conditions. That is
    // load-bearing: without it the page fetches once, polling stops, and this
    // rail sits on "working…" until the user refreshes by hand.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', contractId] }),
  })

  const applyAccepted = useMutation({
    mutationFn: (clauseIds: string[]) =>
      api.post(`/contracts/${contractId}/redline-against-playbook/apply`, { acceptedClauseIds: clauseIds })
        .then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-clauses', contractId] })
      setAccepted(new Set())
    },
  })

  const usable = useMemo(
    () => (staged?.proposals ?? []).filter(p => p.proposedText),
    [staged],
  )
  const failed = useMemo(
    () => (staged?.proposals ?? []).filter(p => p.error),
    [staged],
  )

  const toggle = (id: string) =>
    setAccepted(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <RailSection title="Playbook redline" defaultOpen>
      {status === 'IDLE' && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Check every clause against your playbook and draft a first-pass markup.
            Nothing changes in the document until you accept it.
          </p>
          <Button
            size="sm" className="w-full gap-1.5"
            onClick={() => start.mutate()}
            disabled={start.isPending}
            data-testid="start-playbook-redline"
          >
            <Wand2 className="h-3.5 w-3.5" />
            {start.isPending ? 'Starting…' : 'Redline against playbook'}
          </Button>
        </div>
      )}

      {running && (
        <div className="flex items-center gap-2 text-xs text-gray-600" data-testid="redline-running">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reviewing every clause against your playbook — this takes a minute or two.
        </div>
      )}

      {status === 'FAILED' && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600 mt-0.5 shrink-0" />
            <p className="text-[11px] text-red-800">
              {/* Say what went wrong. A run that fails quietly looks the same as
                  one still working, and these take minutes. */}
              {error || 'The redline could not be completed.'}
            </p>
          </div>
          <Button size="sm" variant="outline" className="w-full" onClick={() => start.mutate()}>
            Try again
          </Button>
        </div>
      )}

      {(status === 'DONE' || status === 'APPLIED') && staged && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-gray-600">
              {staged.deviationCount} clause{staged.deviationCount === 1 ? '' : 's'} deviate
              {staged.deviationCount === 1 ? 's' : ''} from your playbook
            </span>
            {staged.worstSeverity && (
              <span className={`px-1.5 py-0.5 rounded border font-medium ${SEVERITY_STYLE[staged.worstSeverity] ?? SEVERITY_STYLE.low}`}>
                worst: {staged.worstSeverity}
              </span>
            )}
          </div>

          {/* Coverage honesty — what was NOT judged is as important as what was. */}
          {(staged.uncoveredClauses ?? 0) > 0 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              {staged.uncoveredClauses} clause{staged.uncoveredClauses === 1 ? '' : 's'} could not be
              checked — no playbook position covers {staged.uncoveredClauses === 1 ? 'it' : 'them'}.
              They were not reviewed, not approved.
            </p>
          )}
          {staged.truncated && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              This contract was too long to check in full — some clauses were not examined.
            </p>
          )}
          {failed.length > 0 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              {failed.length} clause{failed.length === 1 ? '' : 's'} could not be rewritten
              ({failed.map(f => f.clauseType ?? 'clause').join(', ')}). Review {failed.length === 1 ? 'it' : 'them'} by hand.
            </p>
          )}

          {usable.length === 0 ? (
            <p className="text-xs text-gray-500">
              {staged.note ?? 'No changes to propose.'}
            </p>
          ) : (
            <>
              <ul className="space-y-1.5" data-testid="staged-proposals">
                {usable.map(p => {
                  const isOpen = expanded === p.clauseId
                  const isAccepted = accepted.has(p.clauseId)
                  return (
                    <li key={p.clauseId} className="rounded border border-gray-200">
                      <div className="flex items-start gap-1.5 p-2">
                        <button
                          onClick={() => setExpanded(isOpen ? null : p.clauseId)}
                          className="mt-0.5 text-gray-400 hover:text-gray-600"
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium text-gray-800 truncate">
                              {(p.clauseType ?? 'clause').replace(/_/g, ' ')}
                            </span>
                            {p.sectionRef && <span className="text-[10px] text-gray-400">§{p.sectionRef}</span>}
                            {p.severity && (
                              <span className={`text-[10px] px-1 py-0.5 rounded border ${SEVERITY_STYLE[p.severity] ?? SEVERITY_STYLE.low}`}>
                                {p.severity}
                              </span>
                            )}
                          </div>
                          {p.rationale && !isOpen && (
                            <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{p.rationale}</p>
                          )}
                        </div>
                        <button
                          onClick={() => toggle(p.clauseId)}
                          data-testid={`accept-${p.clauseId}`}
                          aria-pressed={isAccepted}
                          className={`shrink-0 h-6 w-6 rounded border flex items-center justify-center transition-colors ${
                            isAccepted
                              ? 'bg-emerald-600 border-emerald-600 text-white'
                              : 'border-gray-300 text-gray-400 hover:border-emerald-400 hover:text-emerald-600'
                          }`}
                          title={isAccepted ? 'Accepted — click to undo' : 'Accept this change'}
                        >
                          {isAccepted ? <Check className="h-3.5 w-3.5" /> : <X className="h-3 w-3" />}
                        </button>
                      </div>

                      {isOpen && (
                        <div className="border-t border-gray-100 px-2 py-2 space-y-1.5">
                          {p.rationale && <p className="text-[11px] text-gray-600">{p.rationale}</p>}
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">Current</p>
                            <p className="text-[11px] text-gray-700 bg-red-50 rounded px-1.5 py-1 whitespace-pre-line">
                              {p.originalText}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">Proposed</p>
                            <p className="text-[11px] text-gray-800 bg-emerald-50 rounded px-1.5 py-1 whitespace-pre-line">
                              {p.proposedText}
                            </p>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              <div className="flex items-center gap-1.5 pt-1 border-t">
                <Button
                  size="sm" variant="outline" className="text-[11px] h-7"
                  onClick={() => setAccepted(new Set(usable.map(p => p.clauseId)))}
                >
                  Accept all
                </Button>
                <Button
                  size="sm" className="flex-1 gap-1.5 h-7 text-[11px]"
                  disabled={accepted.size === 0 || applyAccepted.isPending}
                  onClick={() => applyAccepted.mutate([...accepted])}
                  data-testid="apply-accepted-redline"
                >
                  <Check className="h-3.5 w-3.5" />
                  {applyAccepted.isPending
                    ? 'Applying…'
                    : `Apply ${accepted.size} change${accepted.size === 1 ? '' : 's'}`}
                </Button>
              </div>

              {applyAccepted.isError && (
                <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                  {(applyAccepted.error as { response?: { data?: { detail?: string } } })
                    ?.response?.data?.detail ?? 'Those changes could not be applied.'}
                </p>
              )}
              {applyAccepted.isSuccess && (
                <p className="text-[11px] text-emerald-700">
                  Applied as a new version. Everything you did not accept was left alone.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </RailSection>
  )
}
