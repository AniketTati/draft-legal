/**
 * ComplianceRailSection (Phase 10, reworked for docs/41 Part 9)
 *
 * Nobody has to know which frameworks apply. The AI reads facts from the
 * contract (personal data? whose? health data? card data? financial
 * reporting?), each with a quote; the org's policy turns them into
 * frameworks; this section says which apply and why, quoting the contract:
 *   "GDPR applies because: 'Supplier will process Customer's employee
 *    personal data' · Where the people are: Germany"
 * When a fact is unsure it asks ONE question. The frameworks that apply are
 * checked automatically (GET /contracts/:id/compliance/applicability); a
 * lawyer can still add one by hand.
 *
 * Per framework checked: status badge + score; expandable check list with
 * severity colours, grounding quote, and a concrete recommendation per gap.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  COMPLIANCE_FRAMEWORK_IDS, COMPLIANCE_FRAMEWORK_LABELS,
  type ComplianceFactEvidence, type ComplianceFrameworkId, type ComplianceQuestion, type FrameworkApplicability,
} from '@clm/types'
import { api } from '@/lib/api'
import { RailSection } from '@/components/contracts/RailSection'
import { Button } from '@/components/ui/button'
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion, ChevronDown, ChevronRight, Scale, HelpCircle, Plus } from 'lucide-react'

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
  versionId?: string
  textHash?: string
}

interface Applicability {
  versionId: string | null
  frameworks: FrameworkApplicability[]
  question: ComplianceQuestion | null
  factsReadAt: string | null
  factsStale: boolean
  added: ComplianceFrameworkId[]
  report: ComplianceReport | null
  checksRan?: string[]
  checkError?: string | null
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

const REGION_NAMES: Record<string, string> = { EU: 'the EU', UK: 'the UK', 'US-CA': 'California', US: 'the US', OTHER: 'elsewhere' }

/** A fact's value in words: "yes", "Germany, the US", "processor". */
function valueText(e: ComplianceFactEvidence): string {
  const v = e.value
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (v === null || v === undefined) return 'not known'
  if (Array.isArray(v)) {
    if (!v.length) return 'none'
    const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null
    return v.map(c => REGION_NAMES[String(c)] ?? (/^[A-Z]{2}$/.test(String(c)) ? names?.of(String(c)) ?? c : c)).join(', ')
  }
  return String(v)
}

const errorText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? fallback

function Because({ items }: { items: ComplianceFactEvidence[] }) {
  if (!items.length) return null
  return (
    <ul className="mt-0.5 space-y-0.5">
      {items.map(e => (
        <li key={e.key} className="text-[10.5px] leading-snug">
          {e.quote ? (
            <span className="border-l-2 border-paper-200 pl-1.5 italic text-ink-500 block">“{e.quote}”</span>
          ) : (
            <span className="text-muted-foreground">
              {e.label}: {valueText(e)}{e.confirmed ? ' (you answered)' : e.value === false ? ' (not found in the text)' : ''}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function Question({ q, pending, onAnswer }: { q: ComplianceQuestion; pending: boolean; onAnswer: (value: unknown) => void }) {
  const [picked, setPicked] = useState<string[]>([])
  return (
    <div className="mb-2 rounded-md border border-attention-200 bg-attention-50 px-2 py-1.5" data-testid="compliance-question" data-key={q.key}>
      <div className="flex items-start gap-1.5 text-[11.5px] text-ink-950">
        <HelpCircle className="size-3.5 mt-0.5 text-attention-700 flex-shrink-0" />
        <span>{q.text}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {q.kind === 'list' ? (
          <>
            {q.options.filter(o => o.value !== 'unsure').map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => setPicked(p => (p.includes(o.value) ? p.filter(x => x !== o.value) : [...p, o.value]))}
                className={`text-[10.5px] border rounded-chip px-1.5 py-0.5 ${picked.includes(o.value) ? 'bg-ink-950 text-paper-50 border-ink-950' : 'bg-card border-border text-ink-700'}`}
                data-testid={`compliance-answer-${o.value}`}
              >
                {o.label}
              </button>
            ))}
            <Button size="sm" variant="outline" className="h-6 text-[10.5px]" disabled={pending || !picked.length} onClick={() => onAnswer(picked)} data-testid="compliance-answer-save">
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[10.5px]" disabled={pending} onClick={() => onAnswer('unsure')} data-testid="compliance-answer-unsure">
              Not sure
            </Button>
          </>
        ) : q.options.map(o => (
          <Button
            key={o.value}
            size="sm"
            variant={o.value === 'unsure' ? 'ghost' : 'outline'}
            className="h-6 text-[10.5px]"
            disabled={pending}
            onClick={() => onAnswer(o.value)}
            data-testid={`compliance-answer-${o.value}`}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function Results({ result, open, onToggle }: { result: ComplianceFrameworkResult; open: boolean; onToggle: () => void }) {
  const badge = FW_BADGE[result.status] ?? FW_BADGE.gaps
  const gaps = result.checks.filter(c => c.status !== 'present')
  return (
    <div className="mt-1">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-1.5 text-left" data-testid={`compliance-fw-toggle-${result.framework}`}>
        {open ? <ChevronDown className="size-3 text-ink-400 flex-shrink-0" /> : <ChevronRight className="size-3 text-ink-400 flex-shrink-0" />}
        <span className={`inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wider border rounded-chip px-1 ${badge.cls}`}>
          <badge.Icon className="size-2.5" />
          {badge.label}
        </span>
        <span className="text-[10.5px] text-ink-500">{gaps.length ? `${gaps.length} to fix` : 'all requirements met'}</span>
        <span className="ml-auto font-mono text-[10px] text-ink-500 tabular-nums">{result.score}/100</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-1.5 border-t border-border/60 pt-1.5">
          {(gaps.length > 0 ? gaps : result.checks).map(c => (
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
                    <div className="mt-0.5 border-l-2 border-paper-200 pl-1.5 italic text-ink-500 leading-snug">“{c.quote}”</div>
                  )}
                  {/* A recommendation is something to do, not a state — so it reads as ink, not as info. */}
                  {c.recommendation && c.status !== 'present' && (
                    <div className="mt-0.5 text-ink-950 leading-snug">→ {c.recommendation}</div>
                  )}
                </div>
              </div>
            </li>
          ))}
          {gaps.length > 0 && gaps.length < result.checks.length && (
            <li className="text-[9.5px] text-muted-foreground">
              + {result.checks.length - gaps.length} requirement{result.checks.length - gaps.length > 1 ? 's' : ''} met
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

export function ComplianceRailSection({
  contractId,
  canEdit = true,
  onAfterCheck,
}: {
  contractId: string
  canEdit?: boolean
  onAfterCheck?: () => void
}) {
  const qc = useQueryClient()
  const key = ['contract-compliance-applicability', contractId]
  const query = useQuery({
    queryKey: key,
    enabled: !!contractId,
    queryFn: async () => (await api.get<Applicability>(`/contracts/${contractId}/compliance/applicability`)).data,
  })
  const a = query.data
  const done = (data: Applicability) => {
    qc.setQueryData(key, data)
    qc.invalidateQueries({ queryKey: ['contract-compliance', contractId] })
    onAfterCheck?.()
  }

  // Each is shown where it happened; the global error toast stays out (lib/api.ts).
  const extract = useMutation({
    meta: { errorHandled: true },
    mutationFn: async (force: boolean) => (await api.post<Applicability>(`/contracts/${contractId}/compliance/facts/extract`, { force })).data,
    onSuccess: done,
  })
  const answer = useMutation({
    meta: { errorHandled: true },
    mutationFn: async ({ key: factKey, value }: { key: string; value: unknown }) =>
      (await api.post<Applicability>(`/contracts/${contractId}/compliance/facts/confirm`, { key: factKey, value })).data,
    onSuccess: done,
  })
  const add = useMutation({
    meta: { errorHandled: true },
    mutationFn: async (framework: string) => (await api.post<Applicability>(`/contracts/${contractId}/compliance/frameworks`, { framework })).data,
    onSuccess: done,
  })

  const [openFw, setOpenFw] = useState<string | null>(null)
  const [adding, setAdding] = useState<string>('')
  const busy = extract.isPending || answer.isPending || add.isPending
  const error = extract.error ?? answer.error ?? add.error

  const applying = a?.frameworks.filter(f => f.applies === 'yes') ?? []
  const unsure = a?.frameworks.filter(f => f.applies === 'unsure') ?? []
  const notApplying = a?.frameworks.filter(f => f.applies === 'no') ?? []
  const report = a?.report ?? null
  const resultFor = (fw: string) => report?.frameworks.find(r => r.framework === fw)
  const issueCount = applying.filter(f => { const r = resultFor(f.framework); return r && r.status !== 'compliant' }).length + (a?.question ? 1 : 0)
  const addable = COMPLIANCE_FRAMEWORK_IDS.filter(id => !applying.some(f => f.framework === id))
  const checkedOnOlder = !!report?.versionId && !!a?.versionId && report.versionId !== a.versionId

  return (
    <RailSection title="Compliance" defaultOpen count={issueCount > 0 ? issueCount : null}>
      {!a ? (
        <div className="text-[11px] text-muted-foreground">{query.isError ? 'Could not load compliance.' : 'Loading…'}</div>
      ) : !a.factsReadAt && !a.added.length && !a.frameworks.some(f => f.because.some(b => b.confirmed)) ? (
        <div className="text-[12px] text-muted-foreground" data-testid="compliance-empty">
          <p className="mb-2 leading-relaxed">
            Not worked out yet. The AI reads the contract for personal, health, payment card and financial-reporting data, quotes what it finds, and checks the rules that apply.
          </p>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => extract.mutate(false)} disabled={busy} data-testid="compliance-check-btn" className="gap-1 text-[11px]">
              <Scale className="size-3" />
              {extract.isPending ? 'Reading the contract…' : 'Work out what applies'}
            </Button>
          )}
        </div>
      ) : (
        <>
          {a.question && canEdit && (
            <Question q={a.question} pending={busy} onAnswer={value => answer.mutate({ key: a.question!.key, value })} />
          )}
          {a.factsStale && (
            <div className="mb-2 text-[10.5px] text-attention-700" data-testid="compliance-stale">
              The text changed since this was worked out.
              {canEdit && (
                <button type="button" className="ml-1 underline" onClick={() => extract.mutate(false)} disabled={busy}>Update</button>
              )}
            </div>
          )}

          {applying.length === 0 && unsure.length === 0 ? (
            <p className="text-[11.5px] text-ink-700 leading-relaxed" data-testid="compliance-none-apply">
              No compliance frameworks apply (no personal or regulated data found).
            </p>
          ) : (
            <ul data-testid="compliance-frameworks" className="space-y-1.5">
              {applying.map(f => {
                const result = resultFor(f.framework)
                return (
                  <li key={f.framework} data-testid={`compliance-fw-${f.framework}`} data-applies="yes" data-status={result?.status ?? 'unchecked'}
                    className="text-[11.5px] border border-border rounded-md bg-card/60 px-2 py-1.5">
                    <div className="font-medium text-ink-950">
                      {f.label} <span className="font-normal text-ink-500">{f.addedByUser && !f.because.length ? 'added by hand' : 'applies because:'}</span>
                    </div>
                    <Because items={f.because} />
                    {result ? (
                      <Results result={result} open={openFw === f.framework} onToggle={() => setOpenFw(openFw === f.framework ? null : f.framework)} />
                    ) : (
                      <div className="mt-1 text-[10.5px] text-muted-foreground">
                        {busy ? 'Checking…' : 'Not checked yet.'}
                        {canEdit && !busy && (
                          <button type="button" className="ml-1 underline" onClick={() => extract.mutate(false)} data-testid={`compliance-check-now-${f.framework}`}>Check now</button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
              {unsure.map(f => (
                <li key={f.framework} data-testid={`compliance-fw-${f.framework}`} data-applies="unsure"
                  className="text-[11.5px] border border-dashed border-border rounded-md px-2 py-1.5">
                  <div className="font-medium text-ink-950">{f.label} <span className="font-normal text-ink-500">may apply</span></div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Not known yet: {f.because.map(b => b.label.toLowerCase()).join(', ')}.
                  </div>
                </li>
              ))}
            </ul>
          )}

          {notApplying.length > 0 && (
            <details className="mt-1.5 text-[10.5px] text-muted-foreground" data-testid="compliance-not-applying">
              <summary className="cursor-pointer">Doesn’t apply: {notApplying.map(f => f.label).join(', ')}</summary>
              <ul className="mt-1 space-y-1">
                {notApplying.map(f => (
                  <li key={f.framework}>
                    <span className="text-ink-700">{f.label}</span>
                    <Because items={f.because} />
                  </li>
                ))}
              </ul>
            </details>
          )}

          {canEdit && addable.length > 0 && (
            <div className="mt-2 flex items-center gap-1" data-testid="compliance-add-framework">
              <select
                value={adding}
                onChange={e => setAdding(e.target.value)}
                className="h-6 text-[10.5px] border border-border rounded-md bg-card px-1"
                aria-label="Framework to add"
              >
                <option value="">Add a framework…</option>
                {addable.map(id => <option key={id} value={id}>{COMPLIANCE_FRAMEWORK_LABELS[id]}</option>)}
              </select>
              <Button size="sm" variant="ghost" className="h-6 gap-0.5 text-[10.5px]" disabled={!adding || busy}
                onClick={() => { add.mutate(adding); setAdding('') }}>
                <Plus className="size-3" />
                {add.isPending ? 'Checking…' : 'Add'}
              </Button>
            </div>
          )}

          {report && (
            <div className="text-[9.5px] text-muted-foreground mt-1.5">
              Checked {new Date(report.checkedAt).toLocaleDateString()}
              {checkedOnOlder && ' on an earlier version'}
              {canEdit && (
                <button type="button" onClick={() => extract.mutate(true)} disabled={busy} data-testid="compliance-rerun-btn" className="ml-2 underline hover:text-ink-950">
                  {extract.isPending ? 're-reading…' : 're-read the contract'}
                </button>
              )}
            </div>
          )}
          {a.checkError && <div className="mt-1 text-[10.5px] text-risk-700">The check didn’t finish: {a.checkError}</div>}
        </>
      )}
      {error && <div className="mt-1 text-[10.5px] text-risk-700">{errorText(error, 'Something went wrong.')}</div>}
    </RailSection>
  )
}
