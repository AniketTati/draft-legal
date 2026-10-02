/**
 * docs/41 Part 19 — the Analytics page organised by the decision each figure
 * helps make: Speed, Bottlenecks, Workload, Negotiation, Risk and playbook,
 * Renewals, AI. One filter bar governs every section; each chart says in one
 * line what it helps you decide, each bar opens its contracts, and each
 * section downloads as CSV.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import { ContractType } from '@clm/types'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/button'
import { PAINT, TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, AXIS_TICK } from '@/lib/chart-paint'
import { Download, Loader2 } from 'lucide-react'

export interface ChartBar { key: string; label: string; value: number | null; n: number; extra?: Record<string, number | string | null> }
export interface SectionPart { headline: Record<string, number | string | null>; charts: Record<string, ChartBar[]>; available?: boolean }
export interface SectionResponse { section: string; parts: Record<string, SectionPart> }

export interface Filters { days: number; type: string; mine: boolean; paperSource: '' | 'ours' | 'theirs' }
export const DEFAULT_FILTERS: Filters = { days: 180, type: '', mine: false, paperSource: '' }

const DAY_MS = 86_400_000
const SELECT = 'h-8 rounded-md border border-input bg-card px-2.5 text-[13px] text-ink-950 transition-colors focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15'

/** The filters as the API's query string. The period ends now, so `from` is worked out once per change. */
export function filterQuery(f: Filters, userId?: string | null, now = Date.now()): string {
  const q = new URLSearchParams({ from: new Date(now - f.days * DAY_MS).toISOString().slice(0, 10) })
  if (f.type) q.set('type', f.type)
  if (f.mine && userId) q.set('ownerId', userId)
  if (f.paperSource) q.set('paperSource', f.paperSource)
  return q.toString()
}

export const sectionKey = (name: string, query: string) => ['analytics-section', name, query]

export function useSection(name: string, query: string) {
  return useQuery<SectionResponse>({
    queryKey: sectionKey(name, query),
    queryFn: () => api.get(`/analytics/${name}?${query}`).then(r => r.data),
    staleTime: 60_000,
  })
}

async function downloadCsv(name: string, query: string) {
  const res = await api.get(`/analytics/${name}?${query}&format=csv`, { responseType: 'blob' })
  const file = /filename="([^"]+)"/.exec(String(res.headers['content-disposition'] ?? ''))?.[1] ?? `analytics-${name}.csv`
  const href = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = href
  a.download = file
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export function FilterBar({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-6" data-testid="analytics-filters">
      <select aria-label="Period" className={SELECT} value={value.days} onChange={e => onChange({ ...value, days: Number(e.target.value) })}>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
        <option value={180}>Last 6 months</option>
        <option value={365}>Last year</option>
      </select>
      <select aria-label="Contract type" className={SELECT} value={value.type} onChange={e => onChange({ ...value, type: e.target.value })}>
        <option value="">All types</option>
        {Object.values(ContractType).map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <select aria-label="Whose paper" className={SELECT} value={value.paperSource} onChange={e => onChange({ ...value, paperSource: e.target.value as Filters['paperSource'] })}>
        <option value="">Any paper</option>
        <option value="ours">Our paper</option>
        <option value="theirs">Their paper or uploaded</option>
      </select>
      <label className="flex items-center gap-1.5 text-[13px] text-ink-700 ml-1">
        <input type="checkbox" checked={value.mine} onChange={e => onChange({ ...value, mine: e.target.checked })} />
        Only contracts I own
      </label>
    </div>
  )
}

/** One headline figure. */
export function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card border border-paper-200 rounded-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums text-ink-950 leading-tight mt-0.5">{value}</div>
      {hint && <div className="text-[11px] text-ink-500 mt-0.5">{hint}</div>}
    </div>
  )
}

export const days = (d: number | string | null | undefined) => d == null ? '—' : `${Number(d).toFixed(Number(d) < 10 ? 1 : 0)} d`
export const pct = (r: number | string | null | undefined) => r == null ? '—' : `${Math.round(Number(r) * 100)}%`
export const count = (n: number | string | null | undefined) => n == null ? '—' : String(n)

/** Where a bar's contracts open: the contract list, narrowed by the drill-down. */
export function drillHref(metric: string, bar: ChartBar, query: string): string {
  // The section's filters travel as one value, so they never mix with the list's own (its type filter, say).
  const q = new URLSearchParams({ drill: metric, drillKey: bar.key, drillLabel: bar.label, dq: query })
  return `/contracts?${q.toString()}`
}

/**
 * A horizontal bar chart whose bars open their contracts. `decide` is the
 * one line saying what it helps you decide; `format` writes a bar's value;
 * `detail` adds a line per bar to the tooltip.
 */
export function DecisionChart({ title, decide, metric, bars, query, format, color = PAINT.info, detail, emptyLabel, ...rest }: {
  title: string
  decide: string
  metric: string
  bars: ChartBar[] | undefined
  query: string
  format: (v: number | null) => string
  color?: string | ((b: ChartBar) => string)
  detail?: (b: ChartBar) => string | null
  emptyLabel?: string
  'data-testid'?: string
}) {
  const navigate = useNavigate()
  const rows = (bars ?? []).filter(b => b.n > 0 || (b.value ?? 0) > 0)
  const paint = (b: ChartBar) => typeof color === 'function' ? color(b) : color
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-metric={metric} {...rest}>
      <h3 className="text-section text-ink-950">{title}</h3>
      <p className="text-[12px] text-ink-500 mt-0.5 mb-4" data-role="decide">{decide}</p>
      {!rows.length ? (
        <div className="flex items-center justify-center h-[120px] text-dense text-ink-500">{emptyLabel ?? 'Nothing in this period.'}</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34 + 24)}>
            <BarChart data={rows.map(b => ({ ...b, v: b.value ?? 0 }))} layout="vertical" margin={{ left: 8, right: 24 }}>
              <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="label" width={150} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: PAINT.grid, opacity: 0.4 }}
                contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
                formatter={(_v, _n, item) => {
                  const b = item.payload as ChartBar
                  const more = detail?.(b)
                  return [`${format(b.value)} · ${b.n} contract${b.n === 1 ? '' : 's'}${more ? ` · ${more}` : ''}`, '']
                }}
              />
              <Bar dataKey="v" radius={[0, 3, 3, 0]} cursor="pointer" onClick={(d: unknown) => navigate(drillHref(metric, d as ChartBar, query))}>
                {rows.map(b => <Cell key={b.key} fill={paint(b)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* The same bars as links, for the keyboard and for anyone who reads rather than hovers. */}
          <ul className="mt-3 pt-3 border-t border-paper-100 grid gap-1">
            {rows.map(b => (
              <li key={b.key} className="flex items-baseline justify-between gap-3 text-[12px]">
                <a href={drillHref(metric, b, query)} onClick={e => { e.preventDefault(); navigate(drillHref(metric, b, query)) }} className="text-ink-700 hover:text-brand-700 hover:underline truncate">
                  {b.label}
                </a>
                <span className="tabular-nums text-ink-500 shrink-0">{format(b.value)}{detail?.(b) ? ` · ${detail(b)}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** A section: its heading, the question it answers, its CSV, and its figures and charts. */
export function DecisionSection({ id, title, question, name, query, loading, children }: {
  id: string; title: string; question: string; name: string; query: string; loading?: boolean; children: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)
  return (
    <section className="mb-10" id={id} data-testid={`analytics-section-${name}`} aria-labelledby={`${id}-title`}>
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h2 id={`${id}-title`} className="text-[17px] font-semibold text-ink-950">{title}</h2>
          <p className="text-dense text-ink-500">{question}</p>
        </div>
        <Button variant="outline" size="xs" disabled={busy} onClick={async () => { setBusy(true); try { await downloadCsv(name, query) } finally { setBusy(false) } }} data-testid={`analytics-csv-${name}`}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} CSV
        </Button>
      </div>
      {loading ? <div className="h-24 flex items-center text-dense text-ink-500"><Loader2 className="size-4 animate-spin mr-2" /> Working it out…</div> : children}
    </section>
  )
}

const part = (d: SectionResponse | undefined, p: string): SectionPart | undefined => d?.parts[p]
const extra = (k: string, f: (v: number | string | null | undefined) => string) => (b: ChartBar) => b.extra?.[k] != null ? `${k === 'p90Days' ? 'p90 ' : ''}${f(b.extra[k])}` : null

function Speed({ query }: { query: string }) {
  const { data, isLoading } = useSection('speed', query)
  const cycle = part(data, 'cycle'), tpl = part(data, 'templates')
  return (
    <DecisionSection id="speed" name="speed" query={query} loading={isLoading} title="Speed"
      question="How long a request takes to become a signed contract — where to invest in self-serve, templates or people.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Median cycle time" value={days(cycle?.headline.medianDays)} hint="request to executed" />
        <Figure label="9 in 10 signed within" value={days(cycle?.headline.p90Days)} hint="90th percentile" />
        <Figure label="Executed" value={count(cycle?.headline.executed)} hint="in this period" />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="Cycle time by contract type" decide="Which types to move to self-serve or a better template." metric="speed.cycle.byType" bars={cycle?.charts.byType} query={query} format={days} detail={extra('p90Days', days)} data-testid="chart-cycle-type" />
        <DecisionChart title="Our paper vs theirs" decide="Whether starting from our template is worth insisting on." metric="speed.cycle.byPaper" bars={cycle?.charts.byPaper} query={query} format={days} color={b => b.key === 'ours' ? PAINT.brand : PAINT.neutral} detail={extra('p90Days', days)} />
        <DecisionChart title="Cycle time by owner" decide="Who may need help or fewer contracts." metric="speed.cycle.byOwner" bars={cycle?.charts.byOwner} query={query} format={days} />
        <DecisionChart title="Templates in use" decide="Which templates to fix or retire: contracts drafted, with their cycle time and turns." metric="speed.templates.byTemplate" bars={tpl?.charts.byTemplate} query={query} format={v => `${v ?? 0} drafted`} color={PAINT.brand}
          detail={b => `${days(b.extra?.medianCycleDays)} to sign · ${b.extra?.medianTurns ?? '—'} turn${b.extra?.medianTurns === 1 ? '' : 's'}`} emptyLabel="No contracts drafted from a template in this period." />
      </div>
    </DecisionSection>
  )
}

function Bottlenecks({ query }: { query: string }) {
  const { data, isLoading } = useSection('bottlenecks', query)
  const stages = part(data, 'stages'), appr = part(data, 'approvals')
  const worst = stages?.headline.bottleneck
  return (
    <DecisionSection id="bottlenecks" name="bottlenecks" query={query} loading={isLoading} title="Bottlenecks"
      question="Which stage holds work longest, and which approvals wait — what to fix first.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Slowest stage" value={String(stages?.headline.bottleneckLabel ?? '—')} hint={stages?.headline.bottleneckMedianDays != null ? `median ${days(stages.headline.bottleneckMedianDays)}` : undefined} />
        <Figure label="Median approval" value={days(appr?.headline.medianDays)} hint="from the step becoming theirs" />
        <Figure label="Approvals waiting now" value={count(appr?.headline.waitingNow)} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="Time in each stage" decide="Which stage to fix first: the longest median is the bottleneck." metric="bottlenecks.stages.byStage" bars={stages?.charts.byStage} query={query} format={days}
          color={b => b.key === worst ? PAINT.attention : PAINT.info} detail={b => `${b.extra?.inStageNow ?? 0} there now`} data-testid="chart-time-in-stage" />
        <DecisionChart title="Approval time by approver" decide="Whom to re-route approvals away from, or give a deputy." metric="bottlenecks.approvals.byApprover" bars={appr?.charts.byApprover} query={query} format={days} detail={b => b.extra?.waitingNow ? `${b.extra.waitingNow} waiting` : null} />
        <DecisionChart title="Approval time by step" decide="Which steps to drop, merge or set a lower threshold for." metric="bottlenecks.approvals.byStep" bars={appr?.charts.byStep} query={query} format={days} />
      </div>
    </DecisionSection>
  )
}

function Workload({ query }: { query: string }) {
  const { data, isLoading } = useSection('workload', query)
  const mine = part(data, 'mine'), team = part(data, 'team')
  const ageColor = (b: ChartBar) => b.key === '15-30' || b.key === '30+' ? PAINT.risk : b.key === '8-14' ? PAINT.attention : PAINT.info
  return (
    <DecisionSection id="workload" name="workload" query={query} loading={isLoading} title="Workload"
      question="What is waiting, on whom, and for how long — who is overloaded and what is stuck. As of now.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Waiting on me" value={count(mine?.headline.waiting)} />
        <Figure label="Mine, over 2 weeks" value={count(mine?.headline.over14Days)} />
        {team && <Figure label="Team in flight" value={count(team.headline.waiting)} hint={`${team.headline.over14Days ?? 0} over 2 weeks`} />}
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="Needs my action, by age" decide="What to clear first." metric="workload.mine.byAge" bars={mine?.charts.byAge} query={query} format={v => `${v ?? 0}`} color={ageColor} emptyLabel="Nothing waits on you." />
        {team && <DecisionChart title="Team work in flight, by who has it" decide="Who is overloaded, and whether to chase the counterparty or the approvers." metric="workload.team.byHolder" bars={team.charts.byHolder} query={query} format={days} detail={b => `${b.n} waiting`} />}
        {team && <DecisionChart title="Team work in flight, by age" decide="How much is stuck." metric="workload.team.byAge" bars={team.charts.byAge} query={query} format={v => `${v ?? 0}`} color={ageColor} />}
      </div>
    </DecisionSection>
  )
}

function Negotiation({ query }: { query: string }) {
  const { data, isLoading } = useSection('negotiation', query)
  const turns = part(data, 'turns'), clauses = part(data, 'clauses')
  return (
    <DecisionSection id="negotiation" name="negotiation" query={query} loading={isLoading} title="Negotiation"
      question="How long counterparties keep a draft, how many rounds it takes, and which clauses get pushed back on.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Counterparty turnaround" value={days(turns?.headline.turnaroundMedianDays)} hint={`median of ${turns?.headline.turnsReturned ?? 0} returned`} />
        <Figure label="With a counterparty now" value={count(turns?.headline.withCounterpartyNow)} />
        <Figure label="Turns per contract" value={turns?.headline.medianTurnsPerContract == null ? '—' : String(turns.headline.medianTurnsPerContract)} hint="median" />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="Turnaround by counterparty" decide="Whom to chase or escalate, and when to expect a signature." metric="negotiation.turns.byCounterparty" bars={turns?.charts.byCounterparty} query={query} format={days} />
        <DecisionChart title="Turns per contract" decide="Whether drafts go out ready, or take rounds to settle." metric="negotiation.turns.turnsPerContract" bars={turns?.charts.turnsPerContract} query={query} format={v => `${v ?? 0}`} />
        <DecisionChart title="Most-negotiated clauses" decide="Which template wording or position to change because it always gets pushed back." metric="negotiation.clauses.byClause" bars={clauses?.charts.byClause} query={query} format={v => `${v ?? 0} contracts`} color={PAINT.attention}
          detail={b => `${b.extra?.countered ?? 0} countered · ${b.extra?.exception ?? 0} exceptions · ${b.extra?.accepted ?? 0} accepted`} data-testid="chart-negotiated-clauses" />
      </div>
    </DecisionSection>
  )
}

function Risk({ query }: { query: string }) {
  const { data, isLoading } = useSection('risk', query)
  const adh = part(data, 'adherence'), exc = part(data, 'exceptions')
  return (
    <DecisionSection id="risk" name="risk" query={query} loading={isLoading} title="Risk and playbook"
      question="How much risk was accepted at signature, and where exceptions are granted — whether to tighten or loosen the playbook.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Signed within the playbook" value={pct(adh?.headline.rate)} hint={`${adh?.headline.adherent ?? 0} of ${adh?.headline.reviewed ?? 0} reviewed`} />
        <Figure label="Exceptions granted" value={count(exc?.headline.granted)} hint={`of ${exc?.headline.requested ?? 0} asked for`} />
        <Figure label="Grant rate" value={pct(exc?.headline.grantRate)} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="At signature" decide="How many contracts were signed with a required clause missing or a critical issue open." metric="risk.adherence.atSignature" bars={adh?.charts.atSignature} query={query} format={v => `${v ?? 0}`}
          color={b => b.key === 'adherent' ? PAINT.brand : b.key === 'open_findings' ? PAINT.risk : PAINT.neutral} data-testid="chart-adherence" />
        <DecisionChart title="Open at signature, by clause" decide="Which clauses get signed unresolved most often." metric="risk.adherence.openByClause" bars={adh?.charts.openByClause} query={query} format={v => `${v ?? 0}`} color={PAINT.risk} emptyLabel="Nothing was signed with an open required or critical issue." />
        <DecisionChart title="Exceptions by clause" decide="Which positions to relax (always granted) or hold (rarely)." metric="risk.exceptions.byClause" bars={exc?.charts.byClause} query={query} format={v => `${v ?? 0} granted`}
          detail={b => `${b.n} asked · ${pct(b.extra?.grantRate)} granted`} />
        <DecisionChart title="Exceptions by approver" decide="Whether approvers apply the playbook the same way." metric="risk.exceptions.byApprover" bars={exc?.charts.byApprover} query={query} format={v => `${v ?? 0} granted`}
          detail={b => `${b.extra?.declined ?? 0} declined`} />
      </div>
    </DecisionSection>
  )
}

function Renewals({ query }: { query: string }) {
  const { data, isLoading } = useSection('renewals', query)
  const r = part(data, 'renewals')
  return (
    <DecisionSection id="renewals" name="renewals" query={query} loading={isLoading} title="Renewals"
      question="Which notice deadlines are coming with no decision, and which were missed — so nothing renews by accident.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Figure label="Undecided, next 90 days" value={count(r?.headline.upcoming)} />
        <Figure label="Deadlines missed" value={count(r?.headline.missed)} hint={`of ${r?.headline.deadlinesPassed ?? 0} that passed in this period`} />
        <Figure label="Missed and renewing on their own" value={count(r?.headline.missedAutoRenewing)} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DecisionChart title="Notice deadlines ahead, undecided" decide="What to decide this month." metric="renewals.renewals.upcoming" bars={r?.charts.upcoming} query={query} format={v => `${v ?? 0}`}
          color={b => b.key === '0-30' ? PAINT.attention : PAINT.info} emptyLabel="No undecided deadline in the next 90 days." data-testid="chart-renewals-upcoming" />
        <DecisionChart title="Deadlines that passed" decide="Whether reminders and owners are working." metric="renewals.renewals.outcome" bars={r?.charts.outcome} query={query} format={v => `${v ?? 0}`}
          color={b => b.key === 'missed' ? PAINT.risk : PAINT.brand} emptyLabel="No notice deadline passed in this period." />
      </div>
    </DecisionSection>
  )
}

function Ai({ query }: { query: string }) {
  const { data, isLoading } = useSection('ai', query)
  const a = part(data, 'acceptance')
  return (
    <DecisionSection id="ai" name="ai" query={query} loading={isLoading} title="AI suggestions"
      question="How often people take what the AI suggests, by feature — where it earns trust and which prompts to tune.">
      {a?.available === false ? (
        <p className="text-dense text-ink-500 bg-paper-50 border border-paper-200 rounded-card px-4 py-3" data-testid="ai-unavailable">
          Suggestion outcomes aren’t recorded yet, so there’s nothing to show here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Figure label="Accepted" value={pct(a?.headline.rate)} hint={`${a?.headline.accepted ?? 0} of ${a?.headline.shown ?? 0} shown`} />
          </div>
          <DecisionChart title="Acceptance by feature" decide="Which features to trust more, and which to improve." metric="ai.acceptance.byFeature" bars={a?.charts.byFeature} query={query} format={pct} color={PAINT.brand}
            detail={b => `${b.extra?.shown ?? 0} shown · ${pct(b.extra?.editedAfterAccept)} edited after`} />
        </>
      )}
    </DecisionSection>
  )
}

/** The decision-led sections, under one filter bar. */
export function DecisionAnalytics() {
  const userId = useAuthStore(s => s.user?.id)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  // Worked out when the filters change, not on every render, so the queries keep one key.
  const [query, setQuery] = useState(() => filterQuery(DEFAULT_FILTERS, userId))
  const change = (f: Filters) => { setFilters(f); setQuery(filterQuery(f, userId)) }
  return (
    <div data-testid="decision-analytics">
      <FilterBar value={filters} onChange={change} />
      <nav className="flex flex-wrap gap-x-4 gap-y-1 mb-6 text-[12.5px]" aria-label="Sections">
        {[['speed', 'Speed'], ['bottlenecks', 'Bottlenecks'], ['workload', 'Workload'], ['negotiation', 'Negotiation'], ['risk', 'Risk and playbook'], ['renewals', 'Renewals'], ['ai', 'AI']].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="text-ink-500 hover:text-brand-700">{label}</a>
        ))}
      </nav>
      <Speed query={query} />
      <Bottlenecks query={query} />
      <Workload query={query} />
      <Negotiation query={query} />
      <Risk query={query} />
      <Renewals query={query} />
      <Ai query={query} />
    </div>
  )
}
