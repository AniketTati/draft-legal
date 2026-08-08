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
 *   [Log decision: Renew | Renegotiate | Let expire | Pause]
 *   [Run advisor again] on the bottom row
 *
 * Only renders when the contract has expiryDate (otherwise advice
 * is nonsense). Always-visible when there's any advice content or
 * the expiry is inside the 180-day window.
 */
import { useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { RefreshCw, Repeat, LogOut, Pause, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react'

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

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const mid = new Date(iso); mid.setHours(0, 0, 0, 0)
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0)
  return Math.round((mid.getTime() - todayMid.getTime()) / (24 * 3600 * 1000))
}

export function RenewalAdviceRailSection({
  contractId,
  expiryDate,
  advice,
  decision,
  onAfterAdvice,
  onAfterDecision,
}: {
  contractId:  string
  expiryDate:  string | null
  advice:      RenewalAdvice | null
  decision:    string | null  // renew | renegotiate | let_expire | pause | null
  onAfterAdvice?:   () => void
  onAfterDecision?: () => void
}) {
  const days = useMemo(() => daysUntil(expiryDate), [expiryDate])
  const inWindow = days !== null && days <= 180 && days >= -30

  // Only show the section when the contract has a meaningful renewal
  // context — either it's within the window or someone already asked
  // for advice.
  if (!expiryDate || (!inWindow && !advice)) return null

  const run = useMutation({
    mutationFn: async () => (await api.post<{ ok: boolean; advice: RenewalAdvice }>(
      `/contracts/${contractId}/renewal-advice`,
    )).data,
    onSuccess: () => onAfterAdvice?.(),
  })

  const decide = useMutation({
    mutationFn: async (d: string) => (await api.post<{ ok: boolean; decision: string }>(
      `/contracts/${contractId}/renewal-decision`,
      { decision: d },
    )).data,
    onSuccess: () => onAfterDecision?.(),
  })

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

        {/* Decision buttons — always present so the owner can log a
            decision even without running the advisor. */}
        <div className="pt-2 border-t border-border mt-2">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-ink-500 mb-1">
            Log decision
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {(['renew', 'renegotiate', 'let_expire', 'pause'] as const).map(d => {
              const meta = REC_META[d]
              const active = decision === d
              return (
                <button
                  key={d}
                  onClick={() => decide.mutate(d)}
                  disabled={decide.isPending}
                  data-testid={`renewal-decision-${d}`}
                  className={`text-[10.5px] px-2 py-0.5 rounded-md border transition-colors ${
                    active
                      ? meta.cls
                      : 'border-border text-ink-700 hover:bg-paper-100'
                  }`}
                >
                  {meta.label}
                </button>
              )
            })}
          </div>
          {decision && (
            <div className="text-[10px] text-muted-foreground mt-1">
              Recorded: <span className="font-medium">{REC_META[decision]?.label ?? decision}</span>
            </div>
          )}
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
