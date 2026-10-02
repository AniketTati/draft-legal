/**
 * docs/41 P1 (Part 8) — the contract's one Review panel.
 *
 * It replaces two rail sections that judged the same playbook with two
 * engines (the automatic "Playbook review" and the on-demand "Playbook
 * redline") and could disagree. Everything here comes from one place, GET
 * /contracts/:id/review:
 *   - the recommendation, decided by fixed rules over the findings (never by
 *     AI), with its reasons;
 *   - which playbook was used and why, which version this one is compared
 *     with, and where the analysis stands;
 *   - the findings, grouped: needs attention, not detected, and what is
 *     standard or accepted — each with its evidence (the clause's words, and
 *     the words before a change) and what can be done about it, in place;
 *   - docs/41 Parts 9, 10 — the gaps of the compliance frameworks that apply
 *     (a high one holds the recommendation at Review), and the drafting
 *     problems (defined terms), which never hold it back, with the glossary;
 *   - docs/41 Part 7 — a finding outside the playbook can be sent to the
 *     category's clause approver as an exception, with a reason; the finding
 *     then says who it is waiting for, and later what they decided.
 * Every status label explains itself on hover.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { approvalKeys, serverMessage } from '@/lib/approval-keys'
import { ReasonDialog } from '@/components/common/ReasonDialog'
import { toast } from '@/components/common/Toaster'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { AssistMark } from '@/components/ui/assist'
import { MEANING_CLASS } from '@/lib/status'
import { cn } from '@/lib/utils'
import {
  RECOMMENDATION_MEANING, statusMeaning, runLine, fixable, hasException, exceptionLine, exceptionMeaning,
  type ContractReview, type ReviewFindingView, type ReviewClauseView, type ExceptionView,
} from '@/lib/review'
import { FixPreview, type StagedFixes } from './FixPreview'
import { logAiEventOnce } from '@/lib/ai-events'
import { BookOpen, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

const ADVICE_WORDS: Record<string, string> = { accept: 'AI suggests accepting', counter: 'AI suggests a counter', reject: 'AI suggests pushing back' }

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-risk-700 bg-risk-50 border-risk-200',
  high: 'text-risk-700 bg-risk-50 border-risk-200',
  medium: 'text-attention-700 bg-attention-50 border-attention-200',
  low: 'text-ink-500 bg-paper-50 border-paper-200',
}

/** Where a finding's exception stands: the same chip, with the reason asked on hover. */
function ExceptionChip({ status, line, reason }: { status: string; line: string; reason?: string | null }) {
  const m = MEANING_CLASS[exceptionMeaning(status)]
  return (
    <span title={reason ? `Reason given: ${reason}` : undefined} className="inline-flex items-center gap-1 text-[10px] border border-paper-200 bg-paper-100 text-ink-700 rounded-chip px-1.5 py-px" data-exception={status}>
      <span className={cn('size-1.5 rounded-full shrink-0', m.dot)} />
      {line}
    </span>
  )
}

/**
 * docs/41 Part 7 — what each finding's exception line says: who a pending one
 * waits for, and later what they decided (who, and their comment), from the
 * contract's approval. A finding of a later version carries its exception
 * while the words are the same, so it is matched by its clause too.
 */
function useExceptionLines(contractId: string, findings: ReviewFindingView[]): Map<string, { line: string; reason: string | null }> {
  const any = findings.some(hasException)
  const approval = useQuery<{ exceptions?: ExceptionView[] }>({
    queryKey: approvalKeys.contract(contractId),
    queryFn: () => api.get(`/contracts/${contractId}/approval`).then(r => r.data),
    enabled: any,
    staleTime: 10_000,
  })
  const out = new Map<string, { line: string; reason: string | null }>()
  if (!any) return out
  for (const f of findings) {
    if (!hasException(f)) continue
    // Newest first, so the first is the one that set this status.
    const ex = approval.data?.exceptions?.find(e => e.findingId === f.id)
      ?? approval.data?.exceptions?.find(e => e.status !== 'RESET' && e.clauseType === f.clauseType && e.title === f.title)
      ?? null
    const line = exceptionLine(f.status, ex, ex?.waitingFor ?? null)
    if (line) out.set(f.id, { line, reason: ex?.reason ?? null })
  }
  return out
}

/** A status chip whose definition is its tooltip. */
function StatusChip({ reviewStatus, label, definition }: { reviewStatus: string; label: string; definition: string }) {
  const m = MEANING_CLASS[statusMeaning(reviewStatus)]
  return (
    <span title={definition} className="inline-flex items-center gap-1 text-[10px] border border-paper-200 bg-paper-100 text-ink-700 rounded-chip px-1.5 py-px cursor-help" data-status={reviewStatus}>
      <span className={cn('size-1.5 rounded-full', m.dot)} />
      {label}
    </span>
  )
}

/** docs/41 Part 16 — what a finding's "Suggested note to counterparty" does (absent: not offered). */
const SuggestedNote = createContext<((f: ReviewFindingView) => void) | null>(null)

export function ReviewPanel({
  contractId,
  contractMetadata,
  canEdit,
  onJumpToClause,
  onAnalyse,
  analysing,
  onShowText,
  definedTerms,
  onSuggestedNote,
}: {
  contractId: string
  contractMetadata: Record<string, unknown> | null | undefined
  canEdit: boolean
  onJumpToClause: (clauseId: string) => void
  onAnalyse?: () => void
  analysing?: boolean
  /** Show words in the document: a finding not about one clause (a defined term). */
  onShowText?: (text: string) => void
  /** The defined-terms glossary, shown under Drafting. */
  definedTerms?: ReactNode
  /** docs/41 Part 16 — "Suggested note to counterparty": start an external comment with the position's note. */
  onSuggestedNote?: (f: ReviewFindingView) => void
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['contract-review', contractId],
    queryFn: () => api.get<ContractReview>(`/contracts/${contractId}/review`).then(r => r.data),
    staleTime: 10_000,
    // While an analysis runs, follow it.
    refetchInterval: (query) => {
      const d = query.state.data
      const run = d?.stale?.run ?? d?.run
      return d && (d.analysis.kind === 'running' || run?.status === 'running' || run?.status === 'queued') ? 4000 : false
    },
  })
  const [showStandard, setShowStandard] = useState(false)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['contract-review', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-checks', contractId] })
  }
  const choosePlaybook = useMutation({
    mutationFn: (playbookId: string) => api.put(`/contracts/${contractId}/playbook`, { playbookId }),
    onSuccess: refresh,
  })
  const fixAll = useMutation({
    meta: { errorHandled: true },
    mutationFn: () => api.post(`/contracts/${contractId}/review/fix-all`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contract', contractId] }),
  })

  const r = q.data
  const needs = r?.groups.needsAttention ?? []
  const missing = r?.groups.notDetected ?? []
  const compliance = r?.groups.compliance ?? []
  const drafting = r?.groups.drafting ?? []
  // Drafting problems are listed, not counted: they never hold approval back.
  const open = needs.length + missing.length + compliance.length
  const meta = contractMetadata ?? {}
  const fixStatus = meta._playbookRedlineStatus as string | undefined
  const staged = meta._playbookRedline as StagedFixes | undefined
  const stagedHere = staged && staged.versionId === r?.versionId && fixStatus === 'DONE' ? staged : null
  // docs/41 Part 16 — the fix-all rewrites, shown (taking or passing them over is logged where they are applied).
  useEffect(() => {
    if (!stagedHere) return
    for (const p of stagedHere.proposals) {
      logAiEventOnce(`fix_all:${contractId}:${stagedHere.stagedAt ?? stagedHere.versionId}:${p.clauseId}`, { contractId, versionId: stagedHere.versionId, feature: 'fix_all', outcome: 'shown', suggestionId: p.clauseId })
    }
  }, [stagedHere, contractId])
  const line = r ? runLine(r) : null
  const batch = r ? fixable(needs) : []
  const exceptions = useExceptionLines(contractId, r ? [...needs, ...missing, ...compliance, ...r.groups.accepted] : [])

  return (
    <SuggestedNote.Provider value={canEdit ? onSuggestedNote ?? null : null}>
    <RailSection title="Review" defaultOpen count={open || null}>
      {q.isLoading && <p className="text-[11px] text-muted-foreground">Loading…</p>}
      {q.isError && <p className="text-[11px] text-risk-700">The review could not be loaded: {serverMessage(q.error)}</p>}
      {r && (
        <div className="space-y-2.5" data-testid="review-panel">
          {/* The recommendation: fixed rules over the findings. */}
          {r.recommendation && (
            <div className={cn('rounded-md border px-2 py-1.5', MEANING_CLASS[RECOMMENDATION_MEANING[r.recommendation.label] ?? 'neutral'].wash, MEANING_CLASS[RECOMMENDATION_MEANING[r.recommendation.label] ?? 'neutral'].washBorder)} data-testid="review-recommendation" data-label={r.recommendation.label}>
              <div className="text-[12px] font-medium text-ink-950 cursor-help" title={r.recommendation.definition}>{r.recommendation.text}</div>
              {r.recommendation.reasons.length > 0 && (
                <ul className="mt-0.5 text-[11px] text-ink-700 list-disc pl-4">
                  {r.recommendation.reasons.slice(0, 3).map((x, i) => <li key={i}>{x.text}</li>)}
                  {r.recommendation.reasons.length > 3 && <li className="list-none -ml-4 text-ink-500">and {r.recommendation.reasons.length - 3} more below</li>}
                </ul>
              )}
              <p className="text-[10px] text-ink-500 mt-0.5">Worked out from the findings below by fixed rules, not by AI.</p>
            </div>
          )}

          {/* Where the analysis stands. */}
          {line && (
            <div className="flex items-start gap-2 text-[11px] text-ink-700 bg-paper-50 border border-paper-200 rounded-md px-2 py-1" data-testid="review-run">
              {!line.canRetry && <Loader2 className="size-3 mt-0.5 animate-spin shrink-0" />}
              <span className="flex-1">{line.text}</span>
              {line.canRetry && onAnalyse && canEdit && (
                <button type="button" className="underline shrink-0" onClick={onAnalyse} disabled={analysing}>{analysing ? 'Starting…' : 'Analyse now'}</button>
              )}
            </div>
          )}

          {/* Which playbook, and why. */}
          <div className="text-[11px] text-ink-500" data-testid="review-playbook" data-why={r.playbook.why}>
            {r.playbook.why === 'ambiguous' && canEdit ? (
              <label className="flex items-center gap-1.5">
                <span>{r.playbook.explanation}</span>
                <select className="text-[11px] border border-input rounded px-1 py-0.5 bg-card" defaultValue="" onChange={e => e.target.value && choosePlaybook.mutate(e.target.value)}>
                  <option value="" disabled>Choose…</option>
                  {r.playbook.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            ) : r.playbook.why === 'none' ? (
              <span>{r.playbook.explanation} <a href="/playbook" className="inline-flex items-center gap-0.5 underline"><BookOpen className="size-3" />Set one up</a></span>
            ) : (
              <span>{r.playbook.explanation}</span>
            )}
            {r.baseline?.versionNumber != null && (
              <div className="mt-0.5">Compared with v{r.baseline.versionNumber}{r.baseline.words ? ` (${r.baseline.words})` : ''}.</div>
            )}
          </div>

          {/* Fix all fixable: a batch of the same rewrites, previewed first. */}
          {r.isCurrent && canEdit && batch.length > 0 && !stagedHere && (
            <div>
              <Button size="sm" variant="assistOutline" className="w-full gap-1.5" disabled={fixAll.isPending || fixStatus === 'QUEUED' || fixStatus === 'RUNNING'} onClick={() => fixAll.mutate()} data-testid="review-fix-all">
                <AssistMark />
                {fixStatus === 'QUEUED' || fixStatus === 'RUNNING' ? 'Drafting fixes…' : `Fix all fixable (${batch.length})`}
              </Button>
              <p className="text-[10px] text-ink-500 mt-0.5">AI drafts a rewrite for each; you see every change before anything is applied.</p>
              {fixAll.isError && <p className="text-[11px] text-risk-700 mt-1">{serverMessage(fixAll.error)}</p>}
              {fixStatus === 'FAILED' && <p className="text-[11px] text-risk-700 mt-1">{(meta._playbookRedlineError as string) || 'The fixes could not be drafted.'}</p>}
            </div>
          )}
          {stagedHere && <FixPreview contractId={contractId} staged={stagedHere} onApplied={refresh} />}

          <Group title="Needs attention" findings={needs} empty={r.analysis.kind === 'done' ? 'Nothing needs attention.' : null}
            contractId={contractId} canEdit={canEdit && r.isCurrent} onJump={onJumpToClause} onChanged={refresh} exceptions={exceptions} />
          {missing.length > 0 && (
            <Group title="Not detected" findings={missing} contractId={contractId} canEdit={canEdit && r.isCurrent} onJump={onJumpToClause} onChanged={refresh} exceptions={exceptions} />
          )}
          {compliance.length > 0 && (
            <Group title="Compliance" findings={compliance} contractId={contractId} canEdit={canEdit && r.isCurrent} onJump={onJumpToClause} onShowText={onShowText} onChanged={refresh} exceptions={exceptions} />
          )}
          {(drafting.length > 0 || definedTerms) && (
            <div data-testid="review-drafting">
              <Group title="Drafting" findings={drafting} empty={r.analysis.kind === 'done' ? 'No problems with defined terms.' : null} contractId={contractId} canEdit={canEdit && r.isCurrent} onJump={onJumpToClause} onShowText={onShowText} onChanged={refresh} exceptions={exceptions} />
              {definedTerms && <div className={drafting.length ? 'mt-1.5' : ''}>{definedTerms}</div>}
            </div>
          )}

          {(r.counts.standard > 0 || r.groups.accepted.length > 0) && (
            <div>
              <button type="button" onClick={() => setShowStandard(s => !s)} className="flex items-center gap-1 text-[11px] font-medium text-ink-700" data-testid="review-standard-toggle">
                {showStandard ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                Standard and accepted ({r.counts.standard + r.groups.accepted.length})
              </button>
              {showStandard && (
                <ul className="mt-1 space-y-1">
                  {r.clauses.filter(c => ['standard', 'matches_preferred', 'fallback', 'unchanged'].includes(c.reviewStatus)).map(c => <ClauseRow key={c.id} c={c} onJump={onJumpToClause} />)}
                  {r.groups.accepted.map(f => (
                    <li key={f.id} className="text-[10.5px] text-ink-700 flex items-center gap-1.5 flex-wrap">
                      <StatusChip reviewStatus={f.reviewStatus} label={f.label} definition={f.definition} />
                      <span>{f.title}</span>
                      {/* An exception's decision says it all; its note repeats the comment. */}
                      {exceptions.get(f.id)
                        ? <ExceptionChip status={f.status} line={exceptions.get(f.id)!.line} reason={exceptions.get(f.id)!.reason} />
                        : f.resolutionNote && <span className="text-ink-500">— {f.resolutionNote}</span>}
                      {canEdit && r.isCurrent && f.actions.includes('reopen') && <ReopenButton contractId={contractId} findingId={f.id} onChanged={refresh} />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {r.clauses.some(c => c.reviewStatus === 'not_covered') && (
            <p className="text-[10.5px] text-ink-500" title="Your playbook has no position for these kinds of clause, so nothing was checked against it.">
              {r.clauses.filter(c => c.reviewStatus === 'not_covered').length} clause(s) not covered by your playbook.
            </p>
          )}
        </div>
      )}
    </RailSection>
    </SuggestedNote.Provider>
  )
}

function ClauseRow({ c, onJump }: { c: ReviewClauseView; onJump: (id: string) => void }) {
  return (
    <li className="text-[10.5px] flex items-center gap-1.5">
      <StatusChip reviewStatus={c.reviewStatus} label={c.label} definition={c.definition} />
      <button type="button" className="text-ink-700 hover:underline truncate" onClick={() => onJump(c.id)} title="Go to this clause">
        {c.clauseLabel}{c.sectionRef ? ` §${c.sectionRef}` : ''}
      </button>
    </li>
  )
}

type ExceptionLines = Map<string, { line: string; reason: string | null }>

function Group({ title, findings, empty, contractId, canEdit, onJump, onShowText, onChanged, exceptions }: {
  title: string; findings: ReviewFindingView[]; empty?: string | null
  contractId: string; canEdit: boolean; onJump: (id: string) => void; onShowText?: (text: string) => void; onChanged: () => void
  exceptions?: ExceptionLines
}) {
  if (!findings.length && !empty) return null
  return (
    <div>
      <div className="text-[11px] font-medium text-ink-950 mb-1">{title} {findings.length > 0 && <span className="text-ink-500 tabular-nums">({findings.length})</span>}</div>
      {findings.length === 0 ? <p className="text-[11px] text-muted-foreground">{empty}</p> : (
        <ol className="space-y-1.5" data-testid={`review-group-${title.toLowerCase().replace(/\s+/g, '-')}`}>
          {findings.map(f => <FindingCard key={f.id} f={f} contractId={contractId} canEdit={canEdit} onJump={onJump} onShowText={onShowText} onChanged={onChanged} exception={exceptions?.get(f.id) ?? null} />)}
        </ol>
      )}
    </div>
  )
}

/** What the second quote of a finding is, by kind. */
const RELATED_LABEL: Record<string, string> = { drafting: 'Its definition', compliance: 'Why it applies' }

function FindingCard({ f, contractId, canEdit, onJump, onShowText, onChanged, exception }: {
  f: ReviewFindingView; contractId: string; canEdit: boolean; onJump: (id: string) => void; onShowText?: (text: string) => void; onChanged: () => void
  exception?: { line: string; reason: string | null } | null
}) {
  const qc = useQueryClient()
  const suggestNote = useContext(SuggestedNote)
  const [mode, setMode] = useState<null | 'accept' | 'tag' | 'exception'>(null)
  const [text, setText] = useState('')
  const [proposal, setProposal] = useState<{ originalText: string; proposedText: string; rationale: string } | null>(null)
  const afterVersion = () => {
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-clauses', contractId] })
    onChanged()
  }
  const act = useMutation({
    meta: { errorHandled: true },
    mutationFn: async (a: 'accept' | 'resolve' | 'tag' | 'insert' | 'redline' | 'apply') => {
      // Whole paths, so the route check (lib/route-table.test.ts) can read them.
      if (a === 'accept') return api.post(`/contracts/${contractId}/findings/${f.id}/accept`, { note: text || undefined }).then(r => r.data)
      if (a === 'resolve') return api.post(`/contracts/${contractId}/findings/${f.id}/resolve`, {}).then(r => r.data)
      if (a === 'tag') return api.post(`/contracts/${contractId}/findings/${f.id}/tag`, { text }).then(r => r.data)
      if (a === 'insert') return api.post(`/contracts/${contractId}/findings/${f.id}/insert-standard`, {}).then(r => r.data)
      if (a === 'redline') return api.post(`/contracts/${contractId}/findings/${f.id}/redline`, {}).then(r => r.data)
      return api.post(`/contracts/${contractId}/findings/${f.id}/redline/apply`, {}).then(r => r.data)
    },
    onSuccess: (data, a) => {
      if (a === 'redline') { setProposal(data); return }
      setMode(null); setText(''); setProposal(null)
      if (a === 'insert' || a === 'apply') afterVersion()
      else onChanged()
    },
  })
  // docs/41 Part 7 — an exception goes to the category's clause approver as
  // an approval step. Its refusals (no approver named yet, already asked,
  // an older version) are the server's words, shown in the dialog.
  const askException = useMutation({
    meta: { errorHandled: true },
    mutationFn: (reason: string) =>
      api.post<{ stepId: string; approverIds: string[] }>(`/contracts/${contractId}/findings/${f.id}/exception`, { reason }).then(r => r.data),
    onSuccess: () => {
      setMode(null)
      qc.invalidateQueries({ queryKey: ['contract-review', contractId] })
      qc.invalidateQueries({ queryKey: approvalKeys.contract(contractId) })
      qc.invalidateQueries({ queryKey: approvalKeys.inbox })
      qc.invalidateQueries({ queryKey: approvalKeys.stage(contractId) })
      toast.success('Exception requested')
    },
    onError: (e: unknown) => {
      // Asked already, or the version moved on: what the panel shows is stale.
      if ((e as { response?: { status?: number } })?.response?.status === 409) onChanged()
    },
  })
  const has = (x: string) => canEdit && f.actions.includes(x as never)
  const busy = act.isPending || askException.isPending

  return (
    <li className="text-[10.5px] border border-border rounded-md bg-card/60 px-2 py-1.5" data-kind={f.kind} data-testid={`finding-${f.id}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[9px] uppercase tracking-wider border rounded-chip px-1 ${SEVERITY_CLS[f.severity] ?? SEVERITY_CLS.low}`}>{f.severity}</span>
        <StatusChip reviewStatus={f.reviewStatus} label={f.label} definition={f.definition} />
        {exception && <ExceptionChip status={f.status} line={exception.line} reason={exception.reason} />}
        {f.source === 'llm' && <span className="inline-flex items-center gap-1 text-[9.5px] text-assist-700" title={f.kind === 'compliance' ? 'Checked by AI against the framework’s requirements, with the words it relied on.' : "Judged by AI against your playbook's positions, with the words it relied on."}><AssistMark className="size-[5px]" />AI</span>}
      </div>
      <div className="font-medium text-ink-950 mt-0.5">
        {f.clauseId ? <button type="button" className="text-left hover:underline" onClick={() => onJump(f.clauseId!)} title="Go to this clause">{f.title}</button>
          : f.evidence.quote && onShowText ? <button type="button" className="text-left hover:underline" onClick={() => onShowText(f.evidence.quote!)} title="Show in the document">{f.title}</button>
          : f.title}
      </div>
      <div className="text-ink-700 mt-0.5">{f.explanation}</div>
      {/* docs/41 Part 15 — the model's advice on the counterparty's change, with its suggested counter. */}
      {f.advice && (
        <div className="mt-1 text-assist-700 inline-flex items-start gap-1" data-testid={`finding-advice-${f.id}`}>
          <AssistMark className="size-[5px] mt-1" />
          <span>
            <span className="font-medium">{ADVICE_WORDS[f.advice.recommendation] ?? 'Counter'}.</span> {f.advice.reasoning}
            {f.advice.counterText && <span className="block text-ink-700">Suggested counter: “{f.advice.counterText}”</span>}
          </span>
        </div>
      )}
      {f.evidence.quote && (
        <blockquote className="mt-1 border-l-2 border-paper-300 pl-2 text-ink-950 whitespace-pre-wrap">{f.evidence.quote}</blockquote>
      )}
      {f.evidence.baselineQuote && (
        f.kind === 'deleted'
          ? <details className="mt-1" open><summary className="cursor-pointer text-ink-500">Deleted text</summary><blockquote className="mt-1 border-l-2 border-risk-200 pl-2 text-ink-700 whitespace-pre-wrap line-through decoration-risk-600/40">{f.evidence.baselineQuote}</blockquote></details>
          : <details className="mt-1"><summary className="cursor-pointer text-ink-500">Before</summary><blockquote className="mt-1 border-l-2 border-paper-300 pl-2 text-ink-700 whitespace-pre-wrap">{f.evidence.baselineQuote}</blockquote></details>
      )}
      {f.evidence.relatedQuote && (
        <details className="mt-1"><summary className="cursor-pointer text-ink-500">{RELATED_LABEL[f.kind] ?? 'See also'}</summary><blockquote className="mt-1 border-l-2 border-paper-300 pl-2 text-ink-700 whitespace-pre-wrap">{f.evidence.relatedQuote}</blockquote></details>
      )}

      {proposal && (
        <div className="mt-1.5 space-y-1" data-testid="finding-proposal">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.07em] text-assist-700"><AssistMark className="size-[5px]" />Proposed rewrite</p>
          <p className="text-[11px] text-assist-900 bg-assist-50 rounded-chip px-1.5 py-1 whitespace-pre-line">{proposal.proposedText}</p>
          {proposal.rationale && <p className="text-[10.5px] text-ink-500">{proposal.rationale}</p>}
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-[11px]" disabled={busy} onClick={() => act.mutate('apply')}>Apply as a new version</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setProposal(null)}>Discard</Button>
          </div>
        </div>
      )}

      {mode === 'accept' && (
        <div className="mt-1.5 space-y-1">
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Why it's acceptable (optional)" className="w-full text-[11px] border border-input rounded px-1.5 py-1 bg-card" />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-[11px]" disabled={busy} onClick={() => act.mutate('accept')}>Accept as is</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'tag' && (
        <div className="mt-1.5 space-y-1">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder="Paste the clause's words from the document" className="w-full text-[11px] border border-input rounded px-1.5 py-1 bg-card" />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-[11px]" disabled={busy || text.trim().length < 2} onClick={() => act.mutate('tag')}>Tag as this clause</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {!mode && !proposal && canEdit && f.actions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[10.5px]">
          {has('tag_clause') && <button type="button" className="underline text-ink-950" onClick={() => setMode('tag')}>Find it in the document</button>}
          {has('insert_standard') && <button type="button" className="underline text-ink-950" disabled={busy} onClick={() => act.mutate('insert')}>Insert standard language</button>}
          {has('redline') && <button type="button" className="underline text-assist-700 inline-flex items-center gap-1" disabled={busy} onClick={() => act.mutate('redline')}><AssistMark className="size-[5px]" />Redline to your position</button>}
          {has('accept') && <button type="button" className="underline text-ink-700" onClick={() => setMode('accept')}>Accept as is</button>}
          {has('request_exception') && (
            <button type="button" className="underline text-ink-700" disabled={busy} onClick={() => { askException.reset(); setMode('exception') }} data-testid={`finding-request-exception-${f.id}`}>
              {f.status === 'exception_declined' ? 'Request exception again' : 'Request exception'}
            </button>
          )}
          {suggestNote && f.counterpartyNote && (
            <button type="button" className="underline text-ink-700" onClick={() => suggestNote(f)} title={f.counterpartyNote} data-testid={`finding-suggested-note-${f.id}`}>Suggested note to counterparty</button>
          )}
          {has('resolve') && <button type="button" className="underline text-ink-700" disabled={busy} onClick={() => act.mutate('resolve')}>Mark resolved</button>}
          {busy && <Loader2 className="size-3 animate-spin text-ink-500" />}
        </div>
      )}
      {act.isError && <p className="mt-1 text-[11px] text-risk-700">{serverMessage(act.error)}</p>}
      <ReasonDialog
        open={mode === 'exception'}
        title="Request exception"
        intro={<>“{f.title}” goes to the person who decides exceptions for this kind of clause. They see your reason.</>}
        label="Why should this be allowed?"
        placeholder="For example: the customer is a public body and can't accept a cap above fees."
        confirmLabel="Request exception"
        pendingLabel="Requesting…"
        pending={askException.isPending}
        error={askException.isError ? serverMessage(askException.error) : null}
        onConfirm={reason => askException.mutate(reason)}
        onClose={() => setMode(null)}
        testId={`finding-exception-${f.id}`}
      />
    </li>
  )
}

function ReopenButton({ contractId, findingId, onChanged }: { contractId: string; findingId: string; onChanged: () => void }) {
  const reopen = useMutation({ mutationFn: () => api.post(`/contracts/${contractId}/findings/${findingId}/reopen`), onSuccess: onChanged })
  return <button type="button" className="underline text-ink-500" disabled={reopen.isPending} onClick={() => reopen.mutate()}>Reopen</button>
}
