/**
 * PlaybookReviewRailSection (V1)
 *
 * After extraction, a job scores every clause against the org's playbook and
 * stores the result on the contract (metadata._playbookReview): findings with
 * severity, playbook alignment, a recommendation, and a human-gate flag. That
 * review ran on every contract but nothing rendered it. This section reads
 * GET /contracts/:id/playbook-review — findings arrive in document order —
 * and mirrors ComplianceRailSection's shape.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { ShieldAlert, BookOpen } from 'lucide-react'

export interface PlaybookFinding {
  clauseId:            string
  clauseType:          string
  playbookAlignment:   'preferred' | 'acceptable' | 'fallback' | 'walkaway' | 'outside_playbook' | 'not_covered'
  severity:            'low' | 'medium' | 'high' | 'critical'
  recommendation:      'accept' | 'negotiate' | 'reject'
  reasoning:           string
  requiresHumanReview?: boolean
  sectionRef:          string | null
  excerpt:             string | null
}

export interface PlaybookReview {
  findings:          PlaybookFinding[]
  summary:           string
  requiresHumanGate: boolean
  clausesReviewed:   number
  reviewedAt:        string
}

type Missing = { reason: 'no_positions' | 'not_run'; detail: string; contractType?: string }

/** Severity as exposure: high/critical are risk, medium is your turn, low informational. */
const SEVERITY_CLS: Record<PlaybookFinding['severity'], string> = {
  critical: 'text-risk-700 bg-risk-50 border-risk-200',
  high:     'text-risk-700 bg-risk-50 border-risk-200',
  medium:   'text-attention-700 bg-attention-50 border-attention-200',
  low:      'text-ink-500 bg-paper-50 border-paper-200',
}

const ALIGNMENT_LABEL: Record<PlaybookFinding['playbookAlignment'], string> = {
  preferred:        'preferred',
  acceptable:       'acceptable',
  fallback:         'fallback position',
  walkaway:         'walkaway position',
  outside_playbook: 'outside the playbook',
  not_covered:      'no playbook position',
}

const humanType = (t: string) => t.replace(/_/g, ' ')

export function PlaybookReviewRailSection({
  contractId,
  onJumpToClause,
}: {
  contractId: string
  onJumpToClause: (clauseId: string) => void
}) {
  const query = useQuery({
    queryKey: ['contract-playbook-review', contractId],
    enabled:  !!contractId,
    retry:    false,
    queryFn:  async (): Promise<{ review: PlaybookReview | null; missing: Missing | null }> => {
      try {
        return { review: (await api.get<PlaybookReview>(`/contracts/${contractId}/playbook-review`)).data, missing: null }
      } catch (err) {
        const res = (err as { response?: { status?: number; data?: Missing } }).response
        if (res?.status === 404 && res.data?.reason) return { review: null, missing: res.data }
        throw err
      }
    },
  })
  const review = query.data?.review ?? null
  const missing = query.data?.missing ?? null
  const findings = review?.findings ?? []

  return (
    <RailSection title="Playbook review" defaultOpen count={findings.length > 0 ? findings.length : null}>
      {query.isLoading ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : !review ? (
        <div className="text-[12px] text-muted-foreground leading-relaxed" data-testid="playbook-review-empty" data-reason={missing?.reason ?? 'error'}>
          {missing?.reason === 'no_positions' ? (
            <>
              <p className="mb-1">No playbook positions apply to {missing.contractType ? humanType(missing.contractType) : 'this type of'} contracts, so there is nothing to score this contract against.</p>
              <a href="/playbook" className="inline-flex items-center gap-1 text-[11px] underline hover:text-ink-950">
                <BookOpen className="size-3" /> Add positions in Playbook
              </a>
            </>
          ) : missing?.reason === 'not_run' ? (
            <p>Not reviewed yet. The playbook review runs automatically once the contract has been analysed.</p>
          ) : (
            <p>The playbook review could not be loaded.</p>
          )}
        </div>
      ) : (
        <>
          {review.requiresHumanGate && (
            <div className="mb-2 flex items-start gap-1.5 text-[10.5px] font-medium text-risk-700 bg-risk-50 border border-risk-200 rounded-chip px-2 py-1" data-testid="playbook-review-gate">
              <ShieldAlert className="size-3 mt-0.5 flex-shrink-0" />
              Legal review required — a clause is at a walkaway position, outside the playbook, or critical.
            </div>
          )}
          {review.summary && (
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2" data-testid="playbook-review-summary">{review.summary}</p>
          )}
          {findings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Every reviewed clause matches a preferred position.</p>
          ) : (
            <ol className="space-y-1.5" data-testid="playbook-review-findings">
              {findings.map(f => (
                <li key={f.clauseId} className="text-[10.5px] border border-border rounded-md bg-card/60">
                  <button
                    type="button"
                    onClick={() => onJumpToClause(f.clauseId)}
                    className="w-full text-left px-2 py-1.5 hover:bg-paper-50 rounded-md"
                    data-testid={`playbook-finding-${f.clauseId}`}
                    title="Go to this clause"
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[9px] uppercase tracking-wider border rounded-chip px-1 ${SEVERITY_CLS[f.severity] ?? SEVERITY_CLS.low}`}>
                        {f.severity}
                      </span>
                      <span className="font-medium text-ink-950 capitalize">{humanType(f.clauseType)}</span>
                      {f.sectionRef && <span className="font-mono text-ink-500">§{f.sectionRef}</span>}
                      <span className="ml-auto text-ink-500">{f.recommendation}</span>
                    </div>
                    <div className="text-ink-500 mt-0.5">{ALIGNMENT_LABEL[f.playbookAlignment] ?? f.playbookAlignment}</div>
                    {f.reasoning && <div className="text-muted-foreground leading-snug mt-0.5">{f.reasoning}</div>}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="text-[9.5px] text-muted-foreground mt-1.5 tabular-nums">
            {review.clausesReviewed} clause{review.clausesReviewed === 1 ? '' : 's'} reviewed · {new Date(review.reviewedAt).toLocaleDateString()}
          </div>
        </>
      )}
    </RailSection>
  )
}
