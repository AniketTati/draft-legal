/**
 * ObligationsRailSection (P5.1 → P8 Step 1: now reads from the
 * Obligation table, not contract.metadata)
 *
 * Surfaces a contract's obligations on the contract rail. Each
 * obligation shows type + description + due-date (if any), sorted by
 * soonest-due-first. Empty state offers an "Extract obligations"
 * button that fires POST /contracts/:id/extract-obligations.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { CalendarClock, DollarSign, Shield, RefreshCw, FileSearch, Bell, Check, AlertTriangle, Sparkles, CheckCircle2 } from 'lucide-react'
import { CompleteObligationModal } from '@/components/contracts/CompleteObligationModal'
import { useCanRequest } from '@/lib/permissions'
import { ObligationDrawer, sectionLabel } from '@/components/obligations/ObligationDrawer'

export interface ObligationShape {
  id: string
  type: string
  description: string
  owner: string
  dueDate: string | null
  recurrence: string
  trigger: string | null
  quote: string
  severity: string
  sectionRef: string | null
  status?: string
  completedAt?: string | null
  notifiedAt?: string | null
  /** docs/39 G4 — found by the AI: suggested until a person confirms it. */
  reviewState?: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED'
}

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  payment:     DollarSign,
  sla:         Shield,
  renewal:     RefreshCw,
  audit:       FileSearch,
  report:      CalendarClock,
  termination: AlertTriangle,
  compliance:  Check,
  other:       Bell,
}

/*
 * Calendar days, not elapsed milliseconds. The old `Math.floor((due - now)/1d)`
 * was wrong in both directions on the two labels that matter most: an
 * obligation due tomorrow morning, read this afternoon, floored to 0 and said
 * "due today"; one that fell due six hours ago floored to -1 and said "1d
 * overdue" before anybody had missed a day. Shared with the contract header
 * and the Renewal rail so a date reads the same everywhere.
 */
import { calendarDaysUntil as daysUntil } from './dates'

// P7.4.1 (F-32, F-47) — Status-aware empty state. Obligations only
// matter once a contract is signed; surfacing the "Extract" CTA on
// drafts pushes users toward premature action. SETTLEMENT + NDA
// types rarely have ongoing obligations; show that explicitly.
type EmptyVariant = 'pre_execution' | 'low_value_type' | 'ready'

function emptyVariantFor(status: string | undefined, type: string | undefined): EmptyVariant {
  const PRE_EXEC = ['DRAFT', 'PENDING_REVIEW', 'UNDER_NEGOTIATION', 'PENDING_APPROVAL', 'APPROVED', 'PENDING_SIGNATURE']
  if (status && PRE_EXEC.includes(status)) return 'pre_execution'
  // Settlements + most NDAs don't have ongoing obligations; tell the
  // user instead of pretending the extract pass will find any.
  const LOW_VALUE_TYPES = ['SETTLEMENT', 'NDA', 'AMENDMENT']
  if (type && LOW_VALUE_TYPES.includes(type)) return 'low_value_type'
  return 'ready'
}

export function ObligationsRailSection({
  contractId,
  contractStatus,
  contractType,
  onAfterExtract,
}: {
  contractId: string
  contractStatus?: string
  contractType?: string
  onAfterExtract?: () => void
}) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['contract-obligations', contractId],
    enabled:  !!contractId,
    queryFn:  async () => (await api.get<{
      data: ObligationShape[]; summary: string | null; extractedAt: string | null
    }>(`/contracts/${contractId}/obligations`)).data,
  })
  const obligations = list.data?.data ?? []
  const extractedAt = list.data?.extractedAt ?? null

  const extract = useMutation({
    // Shown where it happened; the global error toast stays out (lib/api.ts).
    meta: { errorHandled: true },
    mutationFn: async () => (await api.post<{ ok: boolean; obligations: ObligationShape[]; summary: string }>(
      `/contracts/${contractId}/extract-obligations`,
    )).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-obligations', contractId] })
      onAfterExtract?.()
    },
  })

  // G4 — a suggestion becomes an obligation, or goes.
  const canReview = useCanRequest('POST /obligations/:id/confirm')
  const review = useMutation({
    mutationFn: async ({ ids, action }: { ids: string[]; action: 'confirm' | 'dismiss' }) =>
      (await api.post<{ count: number }>('/obligations/review', { ids, action })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-obligations', contractId] })
      qc.invalidateQueries({ queryKey: ['obligations-list'] })
      qc.invalidateQueries({ queryKey: ['obligations-stats'] })
    },
  })
  const suggested = obligations.filter(o => o.reviewState === 'SUGGESTED')
  // docs/41 Part 11 — read from a draft: what it would commit to, owed once signed.
  const proposed = obligations.filter(o => o.status === 'PROPOSED')

  const [showAll, setShowAll] = useState(false)
  const [completeTarget, setCompleteTarget] = useState<{ id: string; description: string } | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const sorted = useMemo(() => {
    return [...obligations].sort((a, b) => {
      const ad = a.dueDate, bd = b.dueDate
      if (!ad && !bd) return 0
      if (!ad) return 1
      if (!bd) return -1
      return new Date(ad).getTime() - new Date(bd).getTime()
    })
  }, [obligations])

  const visible = showAll ? sorted : sorted.slice(0, 6)

  // P7.4.1 — pick the right empty-state copy + CTA strength for THIS
  // contract's status + type combo.
  const emptyVariant = emptyVariantFor(contractStatus, contractType)

  return (
    <RailSection title="Obligations" defaultOpen count={obligations.length > 0 ? obligations.length : null}>
      {obligations.length === 0 ? (
        <div className="text-[12px] text-muted-foreground" data-testid={`obligations-empty-${emptyVariant}`}>
          {emptyVariant === 'pre_execution' && (
            <p className="leading-relaxed">
              This draft’s obligations are read when it is analysed, and shown as proposed until it is signed.
            </p>
          )}
          {emptyVariant === 'low_value_type' && (
            <>
              <p className="mb-2 leading-relaxed">
                {contractType === 'SETTLEMENT' && 'Settlements are typically one-time — no ongoing obligations to track.'}
                {contractType === 'NDA'        && 'NDAs typically have just confidentiality + survival terms — nothing recurring to extract.'}
                {contractType === 'AMENDMENT'  && 'Amendments modify their parent contract; obligations live on the parent.'}
              </p>
              <button
                type="button"
                onClick={() => extract.mutate()}
                disabled={extract.isPending}
                data-testid="obligations-extract-btn"
                className="text-[11px] font-medium text-ink-950 hover:underline disabled:opacity-50"
              >
                {extract.isPending ? 'Extracting…' : 'Extract anyway →'}
              </button>
            </>
          )}
          {emptyVariant === 'ready' && (
            <>
              <p className="mb-2 leading-relaxed">
                No obligations extracted yet. Run a pass to pull every payment, SLA, renewal notice, audit right, and report deadline into a structured list the reminder cron can walk.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => extract.mutate()}
                disabled={extract.isPending}
                data-testid="obligations-extract-btn"
                className="gap-1 text-[11px]"
              >
                <Sparkles className="size-3" />
                {extract.isPending ? 'Extracting…' : 'Extract obligations'}
              </Button>
            </>
          )}
          {extract.error && (
            <div className="mt-2 text-[10.5px] text-risk-700">
              {(extract.error as Error).message ?? 'Extraction failed.'}
            </div>
          )}
        </div>
      ) : (
        <>
          {suggested.length > 0 && canReview && (
            <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-700" data-testid="obligations-suggested">
              <Sparkles className="size-3 shrink-0 text-assist-600" />
              <span className="flex-1">
                {suggested.length} found by the AI — confirm the ones that apply.
              </span>
              {suggested.length > 1 && (
                <button type="button" disabled={review.isPending} onClick={() => review.mutate({ ids: suggested.map(o => o.id), action: 'confirm' })}
                  className="font-medium text-ink-950 hover:underline underline-offset-2 disabled:opacity-50" data-testid="obligations-confirm-all">
                  Confirm all
                </button>
              )}
            </div>
          )}
          {proposed.length > 0 && (
            <p className="mb-2 text-[11px] leading-relaxed text-ink-700" data-testid="obligations-proposed-note">
              <span className="font-medium text-ink-950">Proposed — confirmed at signing.</span>{' '}
              What this draft would commit you to. They become obligations to track when it is signed.
            </p>
          )}
          <ul data-testid="obligations-list" className="space-y-1.5">
            {visible.map(o => {
              const Icon = TYPE_ICON[o.type] ?? Bell
              const days = daysUntil(o.dueDate)
              // Overdue is real exposure; inside two weeks it is the user's
              // turn to act. Anything further out is just a date.
              const dueColor = days == null ? 'text-muted-foreground'
                : days < 0 ? 'text-risk-700 font-medium'
                : days <= 14 ? 'text-attention-700 font-medium'
                : 'text-muted-foreground'
              return (
                <li
                  key={o.id}
                  data-testid={`obligation-${o.id}`}
                  data-type={o.type}
                  data-severity={o.severity}
                  data-status={o.status ?? 'OPEN'}
                  tabIndex={0}
                  aria-label={`Open obligation: ${o.description}`}
                  onClick={() => setOpenId(o.id)}
                  onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setOpenId(o.id) } }}
                  className={`group cursor-pointer hover:border-paper-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-[11.5px] border rounded-md px-2 py-1.5 ${
                    o.status === 'COMPLETED'
                      ? 'border-brand-200 bg-brand-50 opacity-90'
                      : 'border-border bg-card'
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    <Icon className={`size-3 mt-0.5 flex-shrink-0 ${o.status === 'COMPLETED' ? 'text-brand-700' : 'text-ink-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`font-medium text-[11.5px] leading-tight ${o.status === 'COMPLETED' ? 'text-ink-500 line-through' : 'text-ink-950'}`}>
                        {o.description}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[10px]">
                        {o.status === 'PROPOSED' ? (
                          <span className="rounded-chip border border-paper-300 bg-paper-100 px-1 font-medium text-ink-700" data-testid={`obligation-proposed-${o.id}`}>Proposed — confirmed at signing</span>
                        ) : o.reviewState === 'SUGGESTED' && (
                          <span className="rounded-chip border border-assist-200 bg-assist-50 px-1 font-medium text-assist-700">Suggested</span>
                        )}
                        <span className="font-mono uppercase tracking-wider text-ink-400">{o.type}</span>
                        <span className="text-muted-foreground">· {o.owner}</span>
                        {sectionLabel(o.sectionRef) && <span className="font-mono text-ink-500">{sectionLabel(o.sectionRef)}</span>}
                        {o.dueDate && (
                          <span className={o.status === 'PROPOSED' ? 'text-muted-foreground' : dueColor}>
                            {days == null || o.status === 'PROPOSED' ? new Date(o.dueDate).toLocaleDateString()
                              : days < 0 ? `${-days}d overdue`
                              : days === 0 ? 'due today'
                              : `due in ${days}d`}
                          </span>
                        )}
                        {!o.dueDate && o.trigger && (
                          <span className="text-muted-foreground italic truncate">{o.trigger}</span>
                        )}
                        {o.reviewState === 'SUGGESTED' && canReview ? (
                          // G4 — confirmed (or dismissed) before it's worked.
                          <span className="ml-auto inline-flex items-center gap-2">
                            <button type="button" disabled={review.isPending}
                              onClick={(e) => { e.stopPropagation(); review.mutate({ ids: [o.id], action: 'confirm' }) }}
                              className="inline-flex items-center gap-0.5 font-medium text-ink-950 hover:underline underline-offset-2 disabled:opacity-50"
                              data-testid={`obligation-confirm-${o.id}`}>
                              <Check className="size-3" /> confirm
                            </button>
                            <button type="button" disabled={review.isPending}
                              onClick={(e) => { e.stopPropagation(); review.mutate({ ids: [o.id], action: 'dismiss' }) }}
                              className="text-ink-500 hover:text-ink-950 hover:underline underline-offset-2 disabled:opacity-50"
                              data-testid={`obligation-dismiss-${o.id}`}>
                              dismiss
                            </button>
                          </span>
                        ) : o.status !== 'COMPLETED' && o.status !== 'WAIVED' && o.status !== 'PROPOSED' && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setCompleteTarget({ id: o.id, description: o.description }) }}
                            data-testid={`obligation-complete-${o.id}`}
                            // `opacity-0 group-hover:opacity-100` alone meant a
                            // keyboard user could Tab onto "complete" and never
                            // see where they were.
                            className="ml-auto inline-flex items-center gap-0.5 text-ink-700 hover:text-ink-950 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-chip"
                          >
                            <CheckCircle2 className="size-3" />
                            <span className="font-medium">complete</span>
                          </button>
                        )}
                        {/* The verb is an action (ink); the past tense is a
                            settled state, which is what brand is for. */}
                        {o.status === 'COMPLETED' && (
                          <span className="ml-auto inline-flex items-center gap-0.5 text-brand-700">
                            <CheckCircle2 className="size-3" />
                            done
                          </span>
                        )}
                      </div>
                    </div>
                    {o.severity === 'high' && o.status !== 'COMPLETED' && (
                      <span className="text-[9.5px] uppercase tracking-wider text-risk-700 bg-risk-50 border border-risk-200 rounded-chip px-1 flex-shrink-0">
                        high
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          {sorted.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              data-testid="obligations-toggle-all"
              className="text-[10.5px] font-medium text-ink-950 hover:underline mt-1.5"
            >
              {showAll ? `Show fewer` : `Show all ${sorted.length}`}
            </button>
          )}
          <div className="text-[9.5px] text-muted-foreground mt-1.5">
            {extractedAt && `Extracted ${new Date(extractedAt).toLocaleDateString()}`}
            <button
              type="button"
              onClick={() => extract.mutate()}
              disabled={extract.isPending}
              data-testid="obligations-refresh-btn"
              className="ml-2 underline hover:text-ink-950"
            >
              {extract.isPending ? 're-running…' : 're-run'}
            </button>
          </div>
        </>
      )}

      {completeTarget && (
        <CompleteObligationModal
          obligationId={completeTarget.id}
          description={completeTarget.description}
          open={!!completeTarget}
          onClose={() => setCompleteTarget(null)}
          onCompleted={() => {
            qc.invalidateQueries({ queryKey: ['contract-obligations', contractId] })
            qc.invalidateQueries({ queryKey: ['obligations-list'] })
            qc.invalidateQueries({ queryKey: ['obligations-stats'] })
          }}
        />
      )}
      <ObligationDrawer obligationId={openId} onClose={() => setOpenId(null)} />
    </RailSection>
  )
}
