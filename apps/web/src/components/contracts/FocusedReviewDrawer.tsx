/**
 * FocusedReviewDrawer — State 3 from the unified-canvas wireframes.
 *
 * Replaces the normal right rail (same 320px slot) when a user clicks an
 * inline risk/deviation marker or a rail risk item. Shows everything the
 * reviewer needs to decide on one clause in one place:
 *   - Title, severity, section reference
 *   - WHY THIS IS A RISK (AI-generated)
 *   - PLAYBOOK GAP — only for deviations, not risks
 *   - AI SUGGESTION — proposed replacement text (when available)
 *   - PLAYBOOK REFERENCE
 *   - Four actions: Accept · Edit manually · Reject · Mark Reviewed
 *   - Inline comments
 *   - Prev / Next navigation across risky clauses in severity order
 *
 * B.5.6 — UI only, local state. B.5.7 persists reviewState to the DB.
 */
import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, X, ChevronLeft, ChevronRight, FileEdit, XCircle,
  BookOpen, Circle, MessageCircle, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { classifyRisk, type RiskClause, type RiskKind } from './RiskDecorations'

/** A playbook position as returned by GET /playbook/positions. */
interface PlaybookPosition {
  id:             string
  positionType:   'preferred' | 'acceptable' | 'fallback' | 'walkaway'
  content:        string
  notes?:         string | null
  clauseCategory?: { id: string; name: string } | null
}

const POSITION_TONE: Record<string, string> = {
  preferred:  'bg-emerald-50 text-emerald-700',
  acceptable: 'bg-blue-50 text-blue-700',
  fallback:   'bg-amber-50 text-amber-700',
  walkaway:   'bg-red-50 text-red-700',
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** One clause with everything the drawer needs to render it. */
export interface FocusedClause extends RiskClause {
  clauseType?: string | null
  interpretation?: string | null
  sectionRef?: string | null
}

/** Review state kept per clause. Local in B.5.6, persisted in B.5.7. */
export type ReviewState = 'unreviewed' | 'reviewed' | 'resolved'

/** Human-readable label for a clauseType value like "limitation_of_liability". */
function labelClauseType(t: string | null | undefined): string {
  if (!t) return 'Clause'
  return t
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The `code` the apply endpoint returns on a structured refusal, if any. */
function applyClauseErrorCode(err: unknown): string | undefined {
  return (err as { response?: { data?: { code?: string } } })?.response?.data?.code
}

function applyClauseErrorDetail(err: unknown): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    ?? 'That change could not be applied. Try again in a moment.'
}

export function FocusedReviewDrawer({
  contractId,
  clauses,
  currentIndex,
  reviewStates,
  onPrev,
  onNext,
  onAccept,
  onReject,
  onEditManually,
  onMarkReviewed,
  onClose,
}: {
  contractId: string
  clauses: FocusedClause[]
  currentIndex: number
  reviewStates: Record<string, ReviewState>
  onPrev: () => void
  onNext: () => void
  onAccept: (clauseId: string) => void
  onReject: (clauseId: string) => void
  onEditManually: (clauseId: string) => void
  onMarkReviewed: (clauseId: string) => void
  onClose: () => void
}) {
  const clause = clauses[currentIndex]
  const qc = useQueryClient()

  // Wave 2.2 — real playbook comparison. Pull the org's playbook positions and
  // match them to this clause's type by category name (replaces the old
  // hardcoded "Playbook v2 / Non-standard" stub with grounded DB data).
  const { data: playbookPositions } = useQuery<PlaybookPosition[]>({
    queryKey: ['playbook-positions'],
    queryFn: () => api.get('/playbook/positions').then(r => r.data.data ?? []),
    staleTime: 5 * 60_000,
  })
  const matchedPositions = (playbookPositions ?? []).filter(p =>
    clause?.clauseType && p.clauseCategory?.name &&
    normalize(p.clauseCategory.name) === normalize(clause.clauseType),
  )

  // Alternative language for this clause, grounded in the org playbook.
  // On demand rather than automatic: each call is an LLM round-trip, and the
  // reviewer clicks through many clauses that need no rewrite.
  const suggest = useMutation({
    mutationFn: async (clauseId: string) => {
      const r = await api.post(`/contracts/${contractId}/clauses/${clauseId}/suggest`, {})
      return r.data as {
        hasPlaybook: boolean
        variants: Array<{ aggression: string; proposedText: string; rationale: string }>
        error?: string
      }
    },
  })

  // Splice a chosen variant into the document as a new version. This is what
  // "apply" always should have meant — the old Accept button only marked the
  // clause resolved and wrote no text at all.
  const applyVariant = useMutation({
    mutationFn: async (v: {
      aggression: string; proposedText: string; rationale: string
      allowAppendFallback?: boolean
    }) => {
      const r = await api.post(`/contracts/${contractId}/clauses/${clause!.id}/apply`, {
        proposedText: v.proposedText,
        aggression:   v.aggression,
        rationale:    v.rationale,
        // Only ever set by the explicit "add as an amendment" button below —
        // the server refuses rather than appending silently, because an
        // amendment is a different instrument from the replacement shown here.
        ...(v.allowAppendFallback ? { allowAppendFallback: true } : {}),
      })
      return r.data as { newVersionNumber: number; spliced: boolean }
    },
    onSuccess: () => {
      // The document body and version list both changed underneath us.
      qc.invalidateQueries({ queryKey: ['contract', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-versions', contractId] })
      qc.invalidateQueries({ queryKey: ['contract-clauses', contractId] })
      onMarkReviewed(clause!.id)
    },
  })

  // Drop any loaded suggestion when the drawer moves to a different clause —
  // showing one clause's proposed language under another would be dangerous.
  const clauseId = clause?.id
  useEffect(() => { suggest.reset(); applyVariant.reset() }, [clauseId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Esc closes, j/k nav like the rest of the app might adopt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]')) return
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); onNext() }
      if (e.key === 'k' || e.key === 'ArrowUp')   { e.preventDefault(); onPrev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev])

  if (!clause) {
    return (
      <aside className="hidden xl:flex w-80 border-l bg-white overflow-y-auto flex-col p-5">
        <div className="text-sm text-gray-400 italic">No issue selected.</div>
      </aside>
    )
  }

  const kind: RiskKind = classifyRisk(clause.riskRating)
  const state = reviewStates[clause.id] ?? 'unreviewed'

  const severityColor =
    kind === 'risk'      ? 'bg-red-50 text-red-700 border-red-200'
    : kind === 'deviation' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : 'bg-gray-100 text-gray-600 border-gray-200'

  const severityLabel =
    kind === 'risk' ? 'HIGH RISK'
    : kind === 'deviation' ? 'DEVIATION'
    : 'NOTED'

  const stateColor =
    state === 'resolved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : state === 'reviewed' ? 'bg-gray-100 text-gray-700 border-gray-200'
    : 'bg-amber-50 text-amber-700 border-amber-200'

  return (
    <aside className="hidden xl:flex w-80 border-l bg-white overflow-y-auto flex-col">
      {/* ── Header — prev / counter / next + close ─────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-50">
        <div className="flex items-center gap-1">
          <button
            onClick={onPrev}
            disabled={currentIndex === 0}
            aria-label="Previous issue (k)"
            className="p-1 rounded text-gray-500 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-gray-600 tabular-nums min-w-[3.5rem] text-center">
            {currentIndex + 1} / {clauses.length}
          </span>
          <button
            onClick={onNext}
            disabled={currentIndex === clauses.length - 1}
            aria-label="Next issue (j)"
            className="p-1 rounded text-gray-500 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={onClose}
          aria-label="Close focused review (Esc)"
          className="p-1 rounded text-gray-400 hover:bg-white hover:text-gray-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Severity + Title + Section ──────────────────────────────────── */}
      <div className="px-5 pt-4 pb-3 border-b">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wide',
            severityColor,
          )}>
            <AlertTriangle className="h-3 w-3" />
            {severityLabel}
          </span>
          <span className={cn(
            'inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium capitalize',
            stateColor,
          )}>
            {state}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-gray-900 leading-snug">
          {labelClauseType(clause.clauseType)}
        </h3>
        {clause.sectionRef && (
          <p className="text-xs text-gray-500 mt-0.5">{clause.sectionRef}</p>
        )}
      </div>

      {/* ── WHY THIS IS A RISK ──────────────────────────────────────────── */}
      <Section title="Why this matters">
        {clause.interpretation ? (
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
            {clause.interpretation}
          </p>
        ) : (
          <p className="text-sm text-gray-400 italic">
            The AI hasn't written an explanation for this clause yet.
          </p>
        )}
      </Section>

      {/* ── PLAYBOOK COMPARISON (deviations only) ─────────────────────── */}
      {kind === 'deviation' && (
        <Section title="Playbook comparison">
          {matchedPositions.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              No playbook position defined for {labelClauseType(clause.clauseType)}.
              Add one in Admin → Playbook to compare this clause automatically.
            </p>
          ) : (
            <div className="space-y-2">
              {matchedPositions.map(p => (
                <div key={p.id} className="rounded-md border border-gray-200 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn(
                      'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded',
                      POSITION_TONE[p.positionType] ?? 'bg-gray-100 text-gray-600',
                    )}>
                      {p.positionType}
                    </span>
                    {p.clauseCategory?.name && (
                      <span className="text-[10px] text-gray-400 truncate">{p.clauseCategory.name}</span>
                    )}
                  </div>
                  {p.content && (
                    <p className="mt-1 text-xs text-gray-600 line-clamp-4">{stripHtml(p.content)}</p>
                  )}
                  {p.notes && <p className="mt-1 text-[11px] text-gray-400 italic">{p.notes}</p>}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── AI SUGGESTION ──────────────────────────────────────────────── */}
      <Section title="Alternative language" icon={<BookOpen className="h-3.5 w-3.5 text-gray-400" />}>
        {suggest.data ? (
          <div className="space-y-2">
            {suggest.data.variants.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                {suggest.data.error ?? 'No alternative language was returned for this clause.'}
              </p>
            ) : (
              suggest.data.variants.map((v, i) => (
                <div key={i} className="rounded-md border border-gray-200 p-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                    {v.aggression}
                  </span>
                  <p className="mt-1.5 text-xs text-gray-700 whitespace-pre-line">{v.proposedText}</p>
                  {v.rationale && (
                    <p className="mt-1 text-[11px] text-gray-400 italic">{v.rationale}</p>
                  )}
                  <button
                    onClick={() => applyVariant.mutate(v)}
                    disabled={applyVariant.isPending}
                    data-testid={`apply-variant-${v.aggression}`}
                    className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-emerald-300 bg-emerald-50 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
                  >
                    <FileEdit className="h-3.5 w-3.5" />
                    {applyVariant.isPending ? 'Applying…' : 'Apply to document'}
                  </button>

                  {/*
                    The server refuses when it can't find the original clause
                    text — the clause was edited after this proposal was
                    generated. Say that, and make the amendment an explicit
                    choice rather than something that quietly happened.
                  */}
                  {applyVariant.isError && applyVariant.variables?.aggression === v.aggression && (
                    <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                      {applyClauseErrorCode(applyVariant.error) === 'CLAUSE_TEXT_NOT_FOUND' ? (
                        <>
                          <p className="text-[11px] text-amber-800">
                            This clause has changed since the suggestion was written, so it can’t
                            be replaced automatically. Regenerate the suggestion, or add this
                            language to the end of the document as an amendment.
                          </p>
                          <button
                            onClick={() => applyVariant.mutate({ ...v, allowAppendFallback: true })}
                            disabled={applyVariant.isPending}
                            data-testid={`append-variant-${v.aggression}`}
                            className="mt-1.5 w-full inline-flex items-center justify-center gap-1.5 px-2 py-1 rounded border border-amber-300 bg-white text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                          >
                            Add as an amendment instead
                          </button>
                        </>
                      ) : (
                        <p className="text-[11px] text-amber-800">
                          {applyClauseErrorDetail(applyVariant.error)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
            {!suggest.data.hasPlaybook && suggest.data.variants.length > 0 && (
              // Say so plainly — otherwise this reads as playbook-approved language.
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                No preferred playbook position exists for {labelClauseType(clause.clauseType)},
                so this is general drafting practice rather than your playbook.
              </p>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={() => suggest.mutate(clause.id)}
              disabled={suggest.isPending}
              data-testid="suggest-alternative-btn"
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              {suggest.isPending ? 'Drafting alternatives…' : 'Suggest alternative language'}
            </button>
            {suggest.isError && (
              <p className="mt-2 text-xs text-red-600">
                Could not draft alternatives right now. Try again, or use Edit manually.
              </p>
            )}
          </>
        )}
      </Section>

      {/* ── ACTIONS ─────────────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-b space-y-2">
        <button
          onClick={() => onAccept(clause.id)}
          title="Accept the clause as written and mark it resolved"
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
        >
          {/* Named for what it does: this resolves the clause, it does not
              write any text into the document. */}
          <Circle className="h-4 w-4" /> Accept clause as-is
        </button>
        <button
          onClick={() => onEditManually(clause.id)}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <FileEdit className="h-4 w-4" /> Edit manually
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => onReject(clause.id)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <XCircle className="h-4 w-4" /> Reject
          </button>
          <button
            onClick={() => onMarkReviewed(clause.id)}
            disabled={state === 'reviewed' || state === 'resolved'}
            className={cn(
              'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50',
              (state === 'reviewed' || state === 'resolved') && 'opacity-60 cursor-not-allowed',
            )}
            title="Mark this clause as reviewed without changing it."
          >
            <Circle className="h-4 w-4" />
            {state === 'unreviewed' ? 'Mark reviewed' : 'Reviewed'}
          </button>
        </div>
      </div>

      {/* ── COMMENTS ───────────────────────────────────────────────────── */}
      <Section title={`Comments on this clause`}>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <MessageCircle className="h-4 w-4 text-gray-300" />
          Full inline comments land in B.3 (margin bubbles).
        </div>
      </Section>
    </aside>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="px-5 py-3.5 border-b last:border-b-0">
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h4>
      </div>
      {children}
    </section>
  )
}
