/**
 * RenewalAdviceRailSection (P5.3 / docs/30 Wave H.3)
 *
 * Surfaces Contract.metadata.renewalAdvice + a decisive CTA so a
 * contract manager staring at "Expires in 67 days" can move from
 * "aware" → "decided" in one screen.
 *
 * Layout:
 *   [recommendation pill: RENEW / RENEGOTIATE / LET EXPIRE / PAUSE]
 *   confidence + generatedAt meta
 *   rationale paragraph
 *   negotiationPoints list
 *   riskFlags pill row
 *   the notice deadline, the standing decision and [Start renewal] (docs/41 Part 14)
 *   [Run advisor again] on the bottom row
 *
 * Only renders when the contract has expiryDate (otherwise advice
 * is nonsense). Always-visible when there's any advice content or
 * the expiry is inside the 180-day window.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { RefreshCw, Repeat, LogOut, Pause, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { RenewalDecisionDialog, NoticeSentButton } from './RenewalDecisionDialog'
import { deadlineWords, noticeOutstanding, noticeSentWords, renewalKey, type RenewalState } from '@/lib/renewal'

export interface NegotiationPoint {
  topic:       string
  ourPosition: string
  reasoning:   string
  severity:    'low' | 'medium' | 'high' | string
}

export interface RenewalAdvice {
  recommendation:    'renew' | 'renegotiate' | 'let_expire' | 'pause' | string
  confidence:        'high' | 'medium' | 'low' | string
  rationale:         string
  negotiationPoints: NegotiationPoint[]
  riskFlags:         string[]
  timeline:          string
  generatedAt?:      string
  model?:            string
  provider?:         string
  error?:            string
}

// The recommendation is advice, not a status, but it still resolves to a
// meaning: renewing keeps the contract binding, renegotiating puts the ball
// back in our court, and letting it lapse is the exposure case.
const REC_META: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  renew:       { label: 'Renew',       cls: 'bg-brand-100 text-brand-700 border-brand-200',             Icon: CheckCircle2 },
  renegotiate: { label: 'Renegotiate', cls: 'bg-attention-100 text-attention-700 border-attention-200', Icon: Repeat },
  let_expire:  { label: 'Let expire',  cls: 'bg-risk-100 text-risk-700 border-risk-200',                Icon: LogOut },
  pause:       { label: 'Pause',       cls: 'bg-paper-100 text-ink-700 border-paper-300',               Icon: Pause },
}

const SEV_CLS: Record<string, string> = {
  high:   'text-risk-700 border-risk-200 bg-risk-50',
  medium: 'text-attention-700 border-attention-200 bg-attention-50',
  low:    'text-ink-500 border-paper-200 bg-paper-50',
}

/* This rail already normalised to midnight; the rest of the app now shares it
   rather than re-deriving it (the contract header disagreed by a day). */
import { calendarDaysUntil as daysUntil } from './dates'

export function RenewalAdviceRailSection({
  contractId,
  expiryDate,
  advice,
  onAfterAdvice,
  onAfterDecision,
}: {
  contractId:  string
  expiryDate:  string | null
  advice:      RenewalAdvice | null
  onAfterAdvice?:   () => void
  onAfterDecision?: () => void
}) {
  const days = useMemo(() => daysUntil(expiryDate), [expiryDate])
  const inWindow = days !== null && days <= 180 && days >= -30

  const run = useMutation({
    mutationFn: async () => (await api.post<{ ok: boolean; advice: RenewalAdvice }>(
      `/contracts/${contractId}/renewal-advice`,
    )).data,
    onSuccess: () => onAfterAdvice?.(),
  })

  // docs/41 Part 14 — the renewal terms, deadline and standing decision.
  const renewal = useQuery({
    queryKey: renewalKey(contractId),
    queryFn: async () => (await api.get<RenewalState>(`/contracts/${contractId}/renewal`)).data,
    enabled: !!contractId && !!expiryDate,
  })
  const standing = renewal.data?.decision ?? null
  const [deciding, setDeciding] = useState(false)

  // Only show the section when the contract has a meaningful renewal
  // context — either it's within the window or someone already asked
  // for advice. After the hooks: an expiry date can arrive while the page is
  // open (a calculated end date, docs/39 F2), and a hook skipped on the
  // render before crashes the page.
  if (!expiryDate || (!inWindow && !advice && !renewal.data?.inWindow && !standing)) return null

  const daysLabel = days === null ? '' : days < 0 ? `Expired ${Math.abs(days)}d ago`
    : days === 0 ? 'Expires today'
    : `Expires in ${days}d`

  return (
    <RailSection
      title="Renewal"
      defaultOpen
      count={advice ? null : null}
    >
      <div className="space-y-2" data-testid="renewal-advice-section">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className={`font-medium ${days !== null && days <= 30 ? 'text-risk-700' : days !== null && days <= 90 ? 'text-attention-700' : 'text-ink-700'}`}>
            {daysLabel}
          </span>
          <span className="text-muted-foreground">· {new Date(expiryDate).toLocaleDateString()}</span>
        </div>

        {!advice && !run.isPending && (
          <div className="text-[12px] text-muted-foreground">
            <p className="mb-2">
              Get a recommendation — <em>renew</em>, <em>renegotiate</em>, <em>let expire</em>, or <em>pause</em> — grounded in the contract text + tracked obligations.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => run.mutate()}
              disabled={run.isPending}
              data-testid="renewal-advice-run-btn"
              className="gap-1 text-[11px]"
            >
              <Sparkles className="size-3" />
              Get renewal advice
            </Button>
          </div>
        )}

        {run.isPending && (
          <div className="text-[11px] text-muted-foreground italic">Analysing contract…</div>
        )}

        {advice && (() => {
          const rec = REC_META[advice.recommendation] ?? REC_META.pause
          const Icon = rec.Icon
          return (
            <>
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md border font-medium text-[11px] w-fit ${rec.cls}`}
                data-testid="renewal-recommendation"
                data-recommendation={advice.recommendation}
              >
                <Icon className="size-3" />
                <span className="uppercase tracking-wider">{rec.label}</span>
                <span className="text-[9.5px] font-normal opacity-70">· {advice.confidence} conf</span>
              </div>

              {advice.rationale && (
                <p className="text-[11.5px] text-ink-950 leading-snug" data-testid="renewal-rationale">
                  {advice.rationale}
                </p>
              )}

              {advice.negotiationPoints && advice.negotiationPoints.length > 0 && (
                <div className="mt-1">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-ink-500 mb-0.5">
                    Negotiation points
                  </div>
                  <ul className="space-y-1" data-testid="renewal-negotiation-points">
                    {advice.negotiationPoints.map((p, i) => (
                      <li
                        key={i}
                        className="text-[11px] border border-border rounded-md px-2 py-1.5 bg-card"
                        data-testid={`renewal-point-${i}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-ink-950">{p.topic}</span>
                          <span className={`text-[9px] uppercase tracking-wider rounded-chip px-1 border ${SEV_CLS[p.severity] ?? SEV_CLS.medium}`}>
                            {p.severity}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-700 mt-0.5 leading-snug">{p.ourPosition}</div>
                        <div className="text-[10.5px] text-muted-foreground mt-0.5 italic">{p.reasoning}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {advice.riskFlags && advice.riskFlags.length > 0 && (
                <div className="mt-1">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-ink-500 mb-0.5">
                    Risk flags
                  </div>
                  <ul className="space-y-0.5" data-testid="renewal-risk-flags">
                    {advice.riskFlags.map((r, i) => (
                      <li key={i} className="flex items-start gap-1 text-[11px] text-risk-900 leading-snug">
                        <AlertTriangle className="size-2.5 mt-1 text-risk-600 flex-shrink-0" />
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {advice.timeline && (
                <div className="text-[10.5px] text-muted-foreground italic mt-1">
                  {advice.timeline}
                </div>
              )}
            </>
          )
        })()}

        {/* docs/41 Part 14 — the decision drives the action: "Start renewal"
            opens the decision dialog; the standing decision, what it
            drafted, and its notice show here. */}
        <div className="pt-2 border-t border-border mt-2 space-y-1.5" data-testid="renewal-decision-block">
          {renewal.data && deadlineWords(renewal.data) && (
            <div className={`text-[11px] ${renewal.data.daysToDeadline != null && renewal.data.daysToDeadline <= 14 ? 'text-risk-700 font-medium' : 'text-ink-700'}`} data-testid="renewal-rail-deadline">
              {deadlineWords(renewal.data)}
            </div>
          )}
          {standing ? (
            <div className="text-[11px] text-ink-700" data-testid="renewal-standing">
              Decided: <span className="font-medium">{standing.label}</span>
              {standing.decidedBy && <> by {standing.decidedBy}</>}
              {standing.decidedInTime === false && <span className="text-risk-700"> (after the deadline)</span>}
              {standing.actionContract && (
                <> · <Link to={`/contracts/${standing.actionContract.id}`} className="underline hover:text-ink-950">{standing.actionContract.title}</Link></>
              )}
              {standing.noticeSentAt && (
                <div className={standing.noticeSentInTime === false ? 'text-risk-700' : 'text-ink-500'}>
                  {noticeSentWords(standing)}
                </div>
              )}
            </div>
          ) : null}
          {renewal.data && noticeOutstanding(renewal.data) && <NoticeSentButton contractId={contractId} onDone={onAfterDecision} />}
          {renewal.data?.canDecide && (
            <Button size="xs" variant={renewal.data.inWindow && !standing ? 'default' : 'outline'} onClick={() => setDeciding(true)} data-testid="start-renewal-btn">
              {standing ? 'Change decision' : 'Start renewal'}
            </Button>
          )}
          {deciding && <RenewalDecisionDialog contractId={contractId} onClose={() => { setDeciding(false); onAfterDecision?.() }} />}
        </div>

        {advice && (
          <div className="text-[9.5px] text-muted-foreground mt-1">
            {advice.generatedAt && `Advised ${new Date(advice.generatedAt).toLocaleDateString()}`}
            <button
              type="button"
              onClick={() => run.mutate()}
              disabled={run.isPending}
              data-testid="renewal-advice-rerun-btn"
              className="ml-2 underline hover:text-ink-950"
            >
              <RefreshCw className="size-2.5 inline mr-0.5" />
              {run.isPending ? 're-running…' : 're-run'}
            </button>
          </div>
        )}
      </div>
    </RailSection>
  )
}
