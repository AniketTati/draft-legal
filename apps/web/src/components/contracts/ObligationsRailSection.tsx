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

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.floor((t - Date.now()) / (24 * 3600 * 1000))
}

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
    mutationFn: async () => (await api.post<{ ok: boolean; obligations: ObligationShape[]; summary: string }>(
      `/contracts/${contractId}/extract-obligations`,
    )).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-obligations', contractId] })
      onAfterExtract?.()
    },
  })

  const [showAll, setShowAll] = useState(false)
  const [completeTarget, setCompleteTarget] = useState<{ id: string; description: string } | null>(null)

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
              Obligations are extracted once this contract is executed. Until then, focus on negotiation + risk review.
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
                  className={`group text-[11.5px] border rounded-md px-2 py-1.5 ${
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
                        <span className="font-mono uppercase tracking-wider text-ink-400">{o.type}</span>
                        <span className="text-muted-foreground">· {o.owner}</span>
                        {o.sectionRef && <span className="font-mono text-ink-500">§{o.sectionRef}</span>}
                        {o.dueDate && (
                          <span className={dueColor}>
                            {days == null ? new Date(o.dueDate).toLocaleDateString()
                              : days < 0 ? `${-days}d overdue`
                              : days === 0 ? 'due today'
                              : `due in ${days}d`}
                          </span>
                        )}
                        {!o.dueDate && o.trigger && (
                          <span className="text-muted-foreground italic truncate">{o.trigger}</span>
                        )}
                        {o.status === 'OPEN' && (
                          <button
                            type="button"
                            onClick={() => setCompleteTarget({ id: o.id, description: o.description })}
                            data-testid={`obligation-complete-${o.id}`}
                            className="ml-auto inline-flex items-center gap-0.5 text-ink-700 hover:text-ink-950 opacity-0 group-hover:opacity-100 transition-opacity"
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
    </RailSection>
  )
}
