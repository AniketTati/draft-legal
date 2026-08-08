/**
 * ComplianceRailSection (Phase 10 — Compliance Agent)
 *
 * Surfaces the contract's regulatory compliance posture (GDPR / HIPAA /
 * SOX / CCPA) on the contract rail. Reads the last persisted report
 * from GET /contracts/:id/compliance; offers a "Run compliance check"
 * button that fires POST /contracts/:id/compliance-check.
 *
 * Per-framework: status badge + score; expandable check list with
 * severity colors, grounding quote, and a concrete recommendation for
 * every gap.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion, ChevronDown, ChevronRight, Scale } from 'lucide-react'

export interface ComplianceCheckItem {
  id:             string
  requirement:    string
  status:         'present' | 'partial' | 'missing' | 'risky'
  severity:       'low' | 'medium' | 'high' | 'critical'
  finding:        string
  quote:          string | null
  sectionRef:     string | null
  recommendation: string | null
}

export interface ComplianceFrameworkResult {
  framework:           string
  applicable:          boolean
  applicabilityReason: string
  status:              'compliant' | 'gaps' | 'non_compliant' | 'not_applicable'
  score:               number
  checks:              ComplianceCheckItem[]
}

export interface ComplianceReport {
  frameworks: ComplianceFrameworkResult[]
  overall: { status: string; summary: string; criticalCount: number }
  checkedAt: string
  frameworksRequested: string[]
}

/**
 * Framework posture on the five meanings: compliant is verified (binding), a
 * gap is work waiting on this user (turn), non-compliant is exposure (risk),
 * and "not applicable" asserts nothing, so it stays neutral.
 */
const FW_BADGE: Record<ComplianceFrameworkResult['status'], { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  compliant:      { label: 'compliant',     cls: 'text-brand-700 bg-brand-50 border-brand-200',             Icon: ShieldCheck },
  gaps:           { label: 'gaps',          cls: 'text-attention-700 bg-attention-50 border-attention-200', Icon: ShieldAlert },
  non_compliant:  { label: 'non-compliant', cls: 'text-risk-700 bg-risk-50 border-risk-200',                Icon: ShieldX },
  not_applicable: { label: 'n/a',           cls: 'text-ink-500 bg-paper-50 border-paper-200',               Icon: ShieldQuestion },
}

const CHECK_DOT: Record<ComplianceCheckItem['status'], string> = {
  present: 'bg-brand-700',
  partial: 'bg-attention-600',
  missing: 'bg-risk-600',
  risky:   'bg-risk-700',
}

export function ComplianceRailSection({
  contractId,
  onAfterCheck,
}: {
  contractId: string
  onAfterCheck?: () => void
}) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['contract-compliance', contractId],
    enabled:  !!contractId,
    queryFn:  async () => (await api.get<{ report: ComplianceReport | null }>(
      `/contracts/${contractId}/compliance`,
    )).data,
  })
  const report = query.data?.report ?? null

  const check = useMutation({
    mutationFn: async () => (await api.post<{ ok: boolean; report: ComplianceReport }>(
      `/contracts/${contractId}/compliance-check`,
    )).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract-compliance', contractId] })
      onAfterCheck?.()
    },
  })

  const [openFw, setOpenFw] = useState<string | null>(null)

  // Count of applicable frameworks with findings, for the section badge.
  const issueCount = report
    ? report.frameworks.filter(f => f.applicable && f.status !== 'compliant').length
    : 0

  return (
    <RailSection title="Compliance" defaultOpen count={issueCount > 0 ? issueCount : null}>
      {!report ? (
        <div className="text-[12px] text-muted-foreground" data-testid="compliance-empty">
          <p className="mb-2 leading-relaxed">
            No compliance check run yet. Scan this contract against GDPR, HIPAA, SOX, and CCPA — every finding grounded in a verbatim clause quote with a concrete fix.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            data-testid="compliance-check-btn"
            className="gap-1 text-[11px]"
          >
            <Scale className="size-3" />
            {check.isPending ? 'Checking…' : 'Run compliance check'}
          </Button>
          {check.error && (
            <div className="mt-2 text-[10.5px] text-risk-700">
              {(check.error as { response?: { data?: { detail?: string } } }).response?.data?.detail
                ?? (check.error as Error).message ?? 'Compliance check failed.'}
            </div>
          )}
        </div>
      ) : (
        <>
          {report.overall.summary && (
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2" data-testid="compliance-summary">
              {report.overall.summary}
            </p>
          )}
          {report.overall.criticalCount > 0 && (
            <div className="mb-2 text-[10.5px] font-medium text-risk-700 bg-risk-50 border border-risk-200 rounded-chip px-2 py-1 tabular-nums" data-testid="compliance-critical-banner">
              {report.overall.criticalCount} critical finding{report.overall.criticalCount > 1 ? 's' : ''} — review before signature
            </div>
          )}
          <ul data-testid="compliance-frameworks" className="space-y-1.5">
            {report.frameworks.map(fw => {
              const badge = FW_BADGE[fw.status] ?? FW_BADGE.gaps
              const open = openFw === fw.framework
              const gaps = fw.checks.filter(c => c.status !== 'present')
              return (
                <li
                  key={fw.framework}
                  data-testid={`compliance-fw-${fw.framework}`}
                  data-status={fw.status}
                  className="text-[11.5px] border border-border rounded-md bg-card/60"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFw(open ? null : fw.framework)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left"
                    data-testid={`compliance-fw-toggle-${fw.framework}`}
                  >
                    {open ? <ChevronDown className="size-3 text-ink-400 flex-shrink-0" /> : <ChevronRight className="size-3 text-ink-400 flex-shrink-0" />}
                    <span className="font-medium text-ink-950">{fw.framework}</span>
                    <span className={`inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wider border rounded-chip px-1 ${badge.cls}`}>
                      <badge.Icon className="size-2.5" />
                      {badge.label}
                    </span>
                    {fw.applicable && (
                      <span className="ml-auto font-mono text-[10px] text-ink-500 tabular-nums">{fw.score}/100</span>
                    )}
                  </button>
                  {open && (
                    <div className="px-2 pb-2 border-t border-border/60 pt-1.5">
                      {!fw.applicable ? (
                        <p className="text-[10.5px] text-muted-foreground italic leading-relaxed">
                          {fw.applicabilityReason || 'Not applicable to this contract.'}
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {(gaps.length > 0 ? gaps : fw.checks).map(c => (
                            <li key={c.id} data-testid={`compliance-check-${c.id}`} className="text-[10.5px]">
                              <div className="flex items-start gap-1.5">
                                <span className={`h-1.5 w-1.5 rounded-full mt-1 flex-shrink-0 ${CHECK_DOT[c.status]}`} />
                                <div className="min-w-0">
                                  <span className="font-medium text-ink-950">{c.requirement}</span>
                                  <span className="text-ink-400"> · {c.status}</span>
                                  {c.sectionRef && <span className="font-mono text-ink-500"> §{c.sectionRef}</span>}
                                  {(c.severity === 'critical' || c.severity === 'high') && c.status !== 'present' && (
                                    <span className="ml-1 text-[9px] uppercase tracking-wider text-risk-700 bg-risk-50 border border-risk-200 rounded-chip px-1">
                                      {c.severity}
                                    </span>
                                  )}
                                  <div className="text-muted-foreground leading-snug">{c.finding}</div>
                                  {c.quote && (
                                    <div className="mt-0.5 border-l-2 border-paper-200 pl-1.5 italic text-ink-500 leading-snug">
                                      “{c.quote}”
                                    </div>
                                  )}
                                  {/* A recommendation is something to do, not a
                                      state — so it reads as ink, not as info. */}
                                  {c.recommendation && c.status !== 'present' && (
                                    <div className="mt-0.5 text-ink-950 leading-snug">→ {c.recommendation}</div>
                                  )}
                                </div>
                              </div>
                            </li>
                          ))}
                          {gaps.length > 0 && gaps.length < fw.checks.length && (
                            <li className="text-[9.5px] text-muted-foreground">
                              + {fw.checks.length - gaps.length} requirement{fw.checks.length - gaps.length > 1 ? 's' : ''} satisfied
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="text-[9.5px] text-muted-foreground mt-1.5">
            Checked {new Date(report.checkedAt).toLocaleDateString()}
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={check.isPending}
              data-testid="compliance-rerun-btn"
              className="ml-2 underline hover:text-ink-950"
            >
              {check.isPending ? 're-running…' : 're-run'}
            </button>
          </div>
          {check.error && (
            <div className="mt-1 text-[10.5px] text-risk-700">
              {(check.error as { response?: { data?: { detail?: string } } }).response?.data?.detail
                ?? (check.error as Error).message ?? 'Compliance check failed.'}
            </div>
          )}
        </>
      )}
    </RailSection>
  )
}
