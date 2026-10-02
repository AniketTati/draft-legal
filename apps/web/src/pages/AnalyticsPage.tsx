/**
 * AnalyticsPage — executive dashboard (Phase 09 Step 1).
 *
 * docs/41 Part 19: the page leads with sections organised by decision
 * (components/analytics/DecisionSections.tsx); the portfolio overview below
 * them is the earlier dashboard.
 *
 * Replaces the prior "Coming Soon" stub with a real KPI dashboard:
 * headline KPIs, contract status pie, contract type bar, risk
 * distribution, monthly volume trend, top counterparties by ACV.
 *
 * Backed by /api/v1/analytics/* endpoints. Each KPI card is clickable
 * — drills into the Contracts list pre-filtered (Step 3 will wire
 * the filter params on /contracts).
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  Cell, LineChart, Line, CartesianGrid, Legend, LabelList,
} from 'recharts'
import { api } from '@/lib/api'
import { ContractType, encodeFieldFilters, formatCurrencyTotals, type CurrencyTotal, type FieldFilter } from '@clm/types'
import { catalogSections, typesOf, useFieldCatalog } from '@/lib/field-catalog'
import { MEANING_CLASS, statusMeaning, statusMeta, type Meaning } from '@/lib/status'
import { Eyebrow } from '@/components/ui/primitives'
import { DecisionAnalytics } from '@/components/analytics/DecisionSections'
import { PAINT, TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, AXIS_TICK, LEGEND_STYLE } from '@/lib/chart-paint'
import {
  BarChart2, FileText, CheckCircle2, AlertTriangle, CalendarClock,
  Loader2, TrendingUp, ArrowRight, Sparkles, Building2, Clock,
} from 'lucide-react'

interface ApiSummary {
  totalContracts:    number
  executedContracts: number
  pendingApprovals:  number
  expiringSoon:      number
  highRiskOpen:      number
  /** docs/39 D4 — per currency, most common first (older APIs send only the two below). */
  executedTotals?: CurrencyTotal[]
  executedTotalValue: number
  executedTotalCurrency: string
  cycleTimeAvgDays:    number | null
  cycleTimeMedianDays: number | null
  approvalAcceptanceRate: number | null
  onTimeExecutionRate:    number | null
  withinTargetDays:        number
  windowDays:              number
}

interface ApiDistributions {
  byStatus: { key: string; count: number }[]
  byType:   { key: string; count: number }[]
  byRisk:   { key: string; count: number; label: string }[]
}

interface ApiTimeseries {
  series: { month: string; label: string; created: number; executed: number }[]
}

interface ApiTopCps {
  data: {
    counterparty: string
    counterpartyId: string | null
    /** How its contracts spell it (docs/39 A14): one row per company. */
    names?: string[]
    count: number
    /** D4 — per currency; value/currency are the largest one's. */
    totals?: CurrencyTotal[]
    value: number
    currency: string
  }[]
}

function formatMoney(n: number, currency = 'USD'): string {
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(0)}K`
  return `${currency} ${n.toFixed(0)}`
}
/**
 * docs/39 D4 — the executed total, one per currency: "USD 4.2M · EUR 1.1M total".
 * It used to add every currency together under the most common one's label.
 */
function executedSubtitle(s: Pick<ApiSummary, 'executedTotals' | 'executedTotalValue' | 'executedTotalCurrency'>): string {
  const totals = s.executedTotals ?? [{ currency: s.executedTotalCurrency, amount: s.executedTotalValue, count: 1 }]
  return totals.length ? `${formatCurrencyTotals(totals, { max: 2 })} total` : ''
}
function formatPct(p: number | null): string {
  if (p == null) return '—'
  return `${Math.round(p * 100)}%`
}
function formatDays(d: number | null): string {
  if (d == null) return '—'
  if (d < 1) return '<1d'
  return `${d.toFixed(1)}d`
}
/** Exact figure for the hover title — the card shows 6.38M, two rows can tie. */
function formatMoneyExact(n: number, currency = 'USD'): string {
  return `${currency} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
/**
 * DATA_PROCESSING → "Data processing". An axis tick is prose, not a DB value.
 *
 * Short all-caps tokens keep their case: this is a legal product, and "Nda",
 * "Msa" and "Sow" are not words. Anything four characters or under that arrived
 * upper-case is treated as the acronym it is.
 */
function humanizeEnum(key: string): string {
  return key
    .split('_')
    .map(w => (w.length <= 4 && w === w.toUpperCase() ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ')
    .replace(/^./, c => c.toUpperCase())
}

const MEANING_PAINT: Record<Meaning, string> = {
  neutral:  PAINT.neutral,
  inflight: PAINT.info,
  turn:     PAINT.attention,
  binding:  PAINT.brand,
  risk:     PAINT.risk,
}

/*
 * Risk bands keep four steps rather than collapsing high + critical into one
 * red: the distinction is the whole point of the chart. They stay inside the
 * risk family so the meaning never changes, only its depth.
 */
const RISK_PAINT: Record<string, string> = {
  low:      PAINT.brand,
  medium:   PAINT.attention,
  high:     PAINT.risk,
  critical: PAINT.riskDeep,
  none:     PAINT.neutral,
}


/**
 * Square points for the "Executed" series.
 *
 * WCAG 1.4.1: the two lines on the volume chart may not be told apart by hue
 * alone. Created is dashed with round points, Executed is solid with square
 * ones, and the legend keys use the matching shapes — so the chart still reads
 * in greyscale, in print, and to a deuteranope.
 */
function SquareDot({ cx, cy }: { cx?: number; cy?: number }) {
  if (cx == null || cy == null) return null
  return (
    <rect
      x={cx - 3.5} y={cy - 3.5} width={7} height={7}
      fill={PAINT.card} stroke={PAINT.brand} strokeWidth={2}
    />
  )
}

export function AnalyticsPage() {
  const [windowDays, setWindowDays] = useState(90)

  const { data: summary, isLoading: summaryLoading } = useQuery<ApiSummary>({
    queryKey: ['analytics-summary', windowDays],
    queryFn:  () => api.get(`/analytics/summary?days=${windowDays}`).then(r => r.data),
    refetchInterval: 60_000,
  })
  const { data: dists } = useQuery<ApiDistributions>({
    queryKey: ['analytics-distributions'],
    queryFn:  () => api.get('/analytics/distributions').then(r => r.data),
  })
  const { data: ts } = useQuery<ApiTimeseries>({
    queryKey: ['analytics-timeseries'],
    queryFn:  () => api.get('/analytics/timeseries').then(r => r.data),
  })
  const { data: tops } = useQuery<ApiTopCps>({
    queryKey: ['analytics-top-cps'],
    queryFn:  () => api.get('/analytics/top-counterparties?limit=10').then(r => r.data),
  })

  /*
   * Every distribution arrives in whatever order the group-by came back in —
   * i.e. physical row order. Plotted straight, a horizontal bar chart in
   * arbitrary order is unreadable: the eye can't rank, and `.slice(0, 10)` on
   * an unsorted array does not mean "top 10", it means "the ten the database
   * happened to hand us first". That silently dropped SOW — the third-largest
   * contract type in this org, 39 contracts — while keeping OTHER at 1.
   * Rank first, then cut, and say out loud when anything was cut.
   */
  const statusRows = useMemo(() => {
    /*
     * Two contract statuses (PENDING_REVIEW and IN_REVIEW) resolve to the same
     * label, "In review" — deliberately, because they mean the same thing to a
     * reader. Plotted raw that printed the category twice, which reads as a
     * data error and makes both bars unrankable. Rows that say the same thing
     * are summed; the meaning is part of the merge key so two labels can never
     * be fused into a bar whose colour is a lie.
     */
    const merged = new Map<string, { key: string; name: string; count: number }>()
    for (const s of dists?.byStatus ?? []) {
      const meta = statusMeta(s.key)
      const id = `${meta.label}|${meta.meaning}`
      const hit = merged.get(id)
      if (hit) hit.count += s.count
      else merged.set(id, { key: s.key, name: meta.label, count: s.count })
    }
    return [...merged.values()].sort((a, b) => b.count - a.count)
  }, [dists])

  const TYPE_LIMIT = 10
  const typeRowsAll = useMemo(
    () => (dists?.byType ?? [])
      .map(t => ({ key: t.key, name: humanizeEnum(t.key), count: t.count }))
      .sort((a, b) => b.count - a.count),
    [dists],
  )
  const typeRows = typeRowsAll.slice(0, TYPE_LIMIT)
  const typeHidden = typeRowsAll.length - typeRows.length

  /*
   * "Not scored" is not a risk level, so it does not get a bar beside the ones
   * that are. Plotted in the same series it reads as a fifth band, and here it
   * would be the second-tallest — 125 contracts the model never scored, shown
   * as though that were a finding about their risk. It becomes a coverage note
   * under the chart instead, which is the thing a reviewer actually needs to
   * know before trusting the other four bars.
   */
  const riskRows = (dists?.byRisk ?? []).filter(r => r.key !== 'none')
  const riskScored = riskRows.reduce((s, r) => s + r.count, 0)
  const riskUnscored = (dists?.byRisk ?? []).find(r => r.key === 'none')?.count ?? 0

  /*
   * The last bucket in the series is the month we are standing in, so it is a
   * partial count by construction. Left unmarked it reads as a collapse (or, as
   * here, a spike) rather than as "3 days of data against 30".
   */
  const volumeRows = useMemo(() => {
    const src = ts?.series ?? []
    return src.map((p, i) => ({
      ...p,
      label: i === src.length - 1 ? `${p.label} ▸` : p.label,
    }))
  }, [ts])

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="analytics-page">
      <div className="flex items-center gap-3 mb-1">
        <BarChart2 className="size-4 text-ink-400" />
        <h1 className="text-title text-ink-950">Analytics</h1>
      </div>
      <p className="text-dense text-ink-500 mb-5">
        Organised by the decision each figure helps you make. Click any bar to open its contracts.
      </p>

      <DecisionAnalytics />

      <h2 className="text-[17px] font-semibold text-ink-950 mb-3 pt-6 border-t border-paper-200" id="portfolio">Portfolio at a glance</h2>

      {/*
        The window selector used to sit in the page header, beside the title,
        which said it governed the page. It does not: it is a lookback for the
        three throughput metrics only — every count in the strip below and every
        chart on this page is the whole portfolio as of now. Changing "Last 90
        days" to "Last 30 days" and watching 420 contracts not move is how a
        user learns to distrust a dashboard. The two sections are now labelled
        with their own scope, and the control lives on the section it steers.
      */}
      <Eyebrow className="mb-2">
        Portfolio — as of now
      </Eyebrow>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <KpiCard
          label="Total contracts"
          value={summary?.totalContracts ?? 0}
          icon={FileText}
          tone="neutral"
          to="/contracts"
          loading={summaryLoading}
          data-testid="kpi-total"
        />
        <KpiCard
          label="Executed"
          value={summary?.executedContracts ?? 0}
          icon={CheckCircle2}
          tone="binding"
          subtitle={summary ? executedSubtitle(summary) : ''}
          to="/contracts?status=EXECUTED"
          loading={summaryLoading}
          data-testid="kpi-executed"
        />
        <KpiCard
          label="Pending approvals"
          value={summary?.pendingApprovals ?? 0}
          icon={Clock}
          /*
           * This is every pending approval in the org, not the viewer's queue —
           * lib/status is explicit that `turn` may only be used where the query
           * is already scoped to the current user, because amber that means
           * "somebody's turn" means nothing. The sidebar badge (8) is the one
           * that speaks for this user; this card is inflight, like the pill on
           * a contract awaiting someone else's approval.
           */
          tone="inflight"
          subtitle="Org-wide, every approver"
          to="/approvals"
          loading={summaryLoading}
          data-testid="kpi-approvals"
        />
        <KpiCard
          label="Expiring (90d)"
          value={summary?.expiringSoon ?? 0}
          icon={CalendarClock}
          // Renewals grades its own horizons: this week is risk, next 30 is a
          // turn, next 90 is neutral. This card links there, so it takes the
          // same reading — a 90-day runway is a diary entry, not an alarm.
          tone="neutral"
          subtitle="Executed, expiry inside 90d"
          to="/renewals?bucket=next_90"
          loading={summaryLoading}
          data-testid="kpi-expiring"
        />
        <KpiCard
          label="High risk + open"
          value={summary?.highRiskOpen ?? 0}
          icon={AlertTriangle}
          tone="risk"
          // Say the threshold out loud. The API counts score > 60 and excludes
          // executed/expired/terminated; the contracts list bands "high" at 67
          // and has no open-vs-closed filter, so the drill-through is a
          // neighbourhood, not the same set. Naming the rule is the difference
          // between a user calling that a discrepancy and calling it a bug.
          subtitle="Score > 60, not executed"
          to="/contracts?riskBand=high"
          loading={summaryLoading}
          data-testid="kpi-high-risk"
        />
      </div>

      {/* KPIs row 2: time-based metrics — the only section the window steers. */}
      <div className="flex items-center justify-between gap-4 mb-2">
        <Eyebrow className="flex-1">Throughput — decided in the window</Eyebrow>
        <div className="flex items-center gap-2">
          {/* The "Window:" text was a bare span, so the control announced
              itself as an unlabelled combobox. A real label also makes the
              word a click target for the select. */}
          <label htmlFor="analytics-window-select" className="text-[11px] text-ink-500">Window:</label>
          <select
            id="analytics-window-select"
            value={windowDays}
            onChange={e => setWindowDays(Number(e.target.value))}
            data-testid="analytics-window"
            className="h-8 rounded-md border border-input bg-card px-2.5 text-[13px] text-ink-950 transition-colors focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <MetricBar
          label="Cycle time"
          value={formatDays(summary?.cycleTimeAvgDays ?? null)}
          subtitle={`Median ${formatDays(summary?.cycleTimeMedianDays ?? null)} · created → executed`}
          icon={TrendingUp}
          tone="neutral"
        />
        <MetricBar
          label="Approval acceptance"
          value={formatPct(summary?.approvalAcceptanceRate ?? null)}
          subtitle="Approved ÷ (Approved + Rejected)"
          icon={CheckCircle2}
          // The one figure on this row that measures something binding.
          tone="binding"
        />
        <MetricBar
          label="On-time execution"
          value={formatPct(summary?.onTimeExecutionRate ?? null)}
          subtitle={`% executed within ${summary?.withinTargetDays ?? 14}d of creation`}
          icon={Sparkles}
          tone="neutral"
        />
      </div>

      <Eyebrow className="mb-2">Distribution — whole portfolio</Eyebrow>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard
          title="Monthly contract volume"
          subtitle="Last 12 months · ▸ marks the month in progress"
          empty={!volumeRows.length}
          emptyLabel="No contracts created in the last 12 months."
          data-testid="chart-volume"
        >
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={volumeRows}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} />
              <XAxis dataKey="label" tick={AXIS_TICK} stroke={PAINT.grid} />
              <YAxis tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ stroke: PAINT.grid }}
              />
              <Legend wrapperStyle={LEGEND_STYLE} />
              {/* Created is in flight; executed is binding. Colour says which
                  meaning; the dash and the point shape say which series, so
                  neither depends on the reader seeing hue (WCAG 1.4.1). A
                  dashed line for the provisional half of the pair and a solid
                  one for the executed half also happens to read correctly.

                  isAnimationActive={false} is not a taste call. Recharts draws
                  a line by animating stroke-dasharray from "0px, <length>" to
                  the full length — and here the animation never ran, so both
                  curves sat at zero length and the chart has been showing bare
                  dots. It also means the animation owns stroke-dasharray, so a
                  dash pattern cannot survive alongside it. The status bars on
                  this page already opt out for their own reasons. */}
              <Line
                type="monotone" dataKey="created" name="Created"
                stroke={PAINT.info} strokeWidth={2} strokeDasharray="5 4"
                legendType="circle" isAnimationActive={false}
                dot={{ r: 3, fill: PAINT.card, stroke: PAINT.info, strokeWidth: 2 }}
              />
              <Line
                type="monotone" dataKey="executed" name="Executed"
                stroke={PAINT.brand} strokeWidth={2}
                legendType="square" isAnimationActive={false}
                dot={<SquareDot />}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/*
          Eleven categories in a 250px plot: Recharts drops every category tick
          that would collide, and it drops them by position, not by importance —
          so the two tallest bars on this chart (189 executed, 131 draft) were
          the ones rendering with no label at all. A bar chart whose largest bars
          are anonymous is not a chart. interval={0} forces every tick, and the
          height is derived from the row count so there is room for them.
        */}
        <ChartCard
          title="Status distribution"
          subtitle={`${statusRows.length} states · ${statusRows.reduce((s, r) => s + r.count, 0)} contracts`}
          empty={!statusRows.length}
          data-testid="chart-status"
        >
          <ResponsiveContainer width="100%" height={Math.max(250, statusRows.length * 26 + 40)}>
            <BarChart data={statusRows} layout="vertical" margin={{ left: 8, right: 38, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} domain={[0, 'dataMax']} />
              <YAxis
                type="category" dataKey="name" tick={AXIS_TICK} stroke={PAINT.grid}
                width={126} interval={0}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              <Bar dataKey="count" name="Contracts" isAnimationActive={false}>
                {/* One source of truth: the bar takes the same meaning the
                    StatusPill would give this status. */}
                {statusRows.map((s, i) => (
                  <Cell key={i} fill={MEANING_PAINT[statusMeaning(s.key)]} />
                ))}
                {/* The counts that matter here are small integers, and half of
                    them draw as a two-pixel sliver. Printing the value beside
                    the bar means the chart answers "how many" without a hover,
                    which is the question a portfolio review actually asks. */}
                <LabelList dataKey="count" position="right" fontSize={11} fill={PAINT.inkMuted} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard
          title="Risk distribution"
          subtitle={`${riskScored} scored contracts`}
          empty={!riskScored && !riskUnscored}
          data-testid="chart-risk"
          footer={
            riskUnscored > 0 ? (
              <span className="flex items-center gap-2">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-ink-350" />
                <span>
                  <span className="tabular-nums font-medium text-ink-700">{riskUnscored}</span> more
                  {' '}({Math.round((riskUnscored / (riskScored + riskUnscored)) * 100)}% of the portfolio)
                  {' '}carry no risk score and are not plotted.
                </span>
              </span>
            ) : undefined
          }
        >
          <ResponsiveContainer width="100%" height={Math.max(180, riskRows.length * 34 + 40)}>
            <BarChart data={riskRows} layout="vertical" margin={{ left: 8, right: 38, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
              <YAxis
                type="category" dataKey="label" tick={AXIS_TICK} stroke={PAINT.grid}
                width={110} interval={0}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              <Bar dataKey="count" name="Contracts" isAnimationActive={false}>
                {riskRows.map((r, i) => (
                  <Cell key={i} fill={RISK_PAINT[r.key] ?? PAINT.neutral} />
                ))}
                <LabelList dataKey="count" position="right" fontSize={11} fill={PAINT.inkMuted} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Contract types"
          subtitle={typeHidden > 0 ? `Top ${typeRows.length} of ${typeRowsAll.length}` : `${typeRowsAll.length} types`}
          empty={!typeRows.length}
          data-testid="chart-types"
          footer={
            typeHidden > 0
              ? `${typeHidden} smaller ${typeHidden === 1 ? 'type is' : 'types are'} not shown: ` +
                typeRowsAll.slice(TYPE_LIMIT).map(t => `${t.name} (${t.count})`).join(', ')
              : undefined
          }
        >
          <ResponsiveContainer width="100%" height={Math.max(180, typeRows.length * 26 + 40)}>
            <BarChart data={typeRows} layout="vertical" margin={{ left: 8, right: 38, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
              <YAxis
                type="category" dataKey="name" tick={AXIS_TICK} stroke={PAINT.grid}
                width={126} interval={0}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              {/* Contract type carries no meaning — it is a category, so the
                  series stays neutral rather than borrowing someone's color. */}
              <Bar dataKey="count" fill={PAINT.neutral} name="Contracts" isAnimationActive={false}>
                <LabelList dataKey="count" position="right" fontSize={11} fill={PAINT.inkMuted} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* docs/39 D3 — any captured field, across the portfolio. */}
      <div className="mb-6">
        <FieldChart />
      </div>

      {/* Top counterparties */}
      <div className="bg-card border border-paper-200 rounded-card overflow-hidden mb-6">
        <header className="flex items-center justify-between px-5 py-3 border-b border-paper-200 bg-paper-50">
          <h3 className="text-section text-ink-950 flex items-center gap-2">
            <Building2 className="size-4 text-ink-400" />
            Top counterparties by executed value
          </h3>
        </header>
        {!tops?.data?.length ? (
          <div className="text-dense text-ink-500 px-5 py-8 text-center">No executed contracts yet.</div>
        ) : (
          <table className="w-full text-dense" data-testid="top-counterparties-table">
            <thead className="text-[10px] uppercase tracking-[0.09em] text-ink-400">
              <tr>
                <th className="text-left px-5 py-2 font-semibold">Counterparty</th>
                <th className="text-right px-5 py-2 font-semibold">Contracts</th>
                <th className="text-right px-5 py-2 font-semibold">Value</th>
                <th className="text-right px-5 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-100">
              {tops.data.map(cp => (
                <tr key={cp.counterparty} className="hover:bg-paper-50">
                  <td className="px-5 py-2 font-medium text-ink-950">{cp.counterparty}</td>
                  <td className="px-5 py-2 text-right text-ink-700 tabular-nums">{cp.count}</td>
                  {/* Rounded to 2dp, so two counterparties a few thousand apart
                      print the same figure and the sort looks arbitrary. The
                      exact number is one hover away. */}
                  <td
                    className="px-5 py-2 text-right font-medium text-ink-950 tabular-nums"
                    title={(cp.totals ?? [{ currency: cp.currency, amount: cp.value, count: cp.count }]).map(t => formatMoneyExact(t.amount, t.currency)).join(' · ')}
                  >
                    {/* D4 — one figure per currency: dollars and euros don't add up. */}
                    {cp.totals?.length ? formatCurrencyTotals(cp.totals, { max: 2 }) : formatMoney(cp.value, cp.currency)}
                  </td>
                  <td className="px-5 py-2 text-right">
                    {/* A14 — a company not in the directory opens the contracts that name it. */}
                    <Link
                      to={cp.counterpartyId
                        ? `/contracts?counterpartyId=${encodeURIComponent(cp.counterpartyId)}&filterLabel=${encodeURIComponent(cp.counterparty)}`
                        : `/contracts?ff=${encodeURIComponent(encodeFieldFilters([{ key: 'counterpartyName', op: 'any_of', value: cp.names?.length ? cp.names : [cp.counterparty] }]))}`}
                      className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-ink-950 hover:text-brand-700"
                    >
                      View <ArrowRight className="size-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function KpiCard({ label, value, subtitle, icon: Icon, tone, to, loading, ...rest }: {
  label:    string
  value:    number
  subtitle?: string
  icon:     React.ComponentType<{ className?: string }>
  tone:     Meaning
  to?:      string
  loading?: boolean
  'data-testid'?: string
}) {
  const m = MEANING_CLASS[tone]
  const card = (
    <div className="h-full border border-paper-200 rounded-card p-4 bg-card transition-colors hover:border-paper-300" {...rest}>
      <div className="flex items-start justify-between">
        <div className="text-[11px] text-ink-500">{label}</div>
        <div className={`size-6 rounded-md flex items-center justify-center ${m.wash} ${m.washFg}`}>
          <Icon className="size-3.5" />
        </div>
      </div>
      <div className="text-[24px] font-semibold tracking-[-0.02em] mt-1 tabular-nums text-ink-950">
        {loading ? <Loader2 className="size-5 animate-spin text-ink-400" /> : value}
      </div>
      {/* Two lines, not an ellipsis: these subtitles carry the definition of the
          number above them, and a truncated definition is worse than none. */}
      {subtitle && <div className="text-[10.5px] text-ink-500 mt-0.5 leading-snug line-clamp-2">{subtitle}</div>}
    </div>
  )
  return to ? <Link to={to} className="block h-full">{card}</Link> : card
}

function MetricBar({ label, value, subtitle, icon: Icon, tone }: {
  label:    string
  value:    string
  subtitle: string
  icon:     React.ComponentType<{ className?: string }>
  tone:     'neutral' | 'binding'
}) {
  const valueClass = tone === 'binding' ? 'text-brand-700' : 'text-ink-950'
  return (
    <div className="border border-paper-200 rounded-card p-4 bg-card flex items-center gap-3">
      <div className="size-9 rounded-card bg-paper-100 flex items-center justify-center text-ink-500">
        <Icon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-ink-500">{label}</div>
        <div className={`text-[20px] font-semibold tracking-[-0.015em] tabular-nums ${valueClass}`}>{value}</div>
        {/* Same reasoning as the KPI subtitle: this line defines the metric, and
            "Approved ÷ (Approved + Rej…" defines nothing. */}
        <div className="text-[10.5px] text-ink-500 leading-snug line-clamp-2">{subtitle}</div>
      </div>
    </div>
  )
}

interface FieldBucket { label: string; count: number; filters: FieldFilter[] }
interface FieldDistribution {
  key: string; label: string; type: string; kind: 'category' | 'range' | 'time'
  buckets: FieldBucket[]; empty: FieldBucket; total: number; other: number
  currency: string | null; currencies: Array<{ code: string; count: number }>; contractType: string | null
}

const CHARTABLE = new Set(['text', 'select', 'multiselect', 'boolean', 'number', 'percentage', 'currency', 'duration', 'date'])
const FIELD_CHART_KEY = 'clm.analytics.field'

/**
 * FieldChart (docs/39 D3) — how one captured field's values spread across the
 * portfolio: yes/no, each choice, the commonest words, ranges of amounts or
 * lengths of time, dates by month or year. Each bar opens its contracts in
 * the list; contracts the field was never found on are a bar of their own.
 */
function FieldChart() {
  const navigate = useNavigate()
  const { data: catalog = [] } = useFieldCatalog()
  const chartable = catalog.filter(f => CHARTABLE.has(f.type))
  const [picked, setPicked] = useState<string | null>(() => { try { return window.localStorage.getItem(FIELD_CHART_KEY) } catch { return null } })
  // First visit: governing law, the portfolio question every legal team asks first.
  const key = picked && chartable.some(f => f.key === picked) ? picked
    : chartable.some(f => f.key === 'governingLaw') ? 'governingLaw' : chartable[0]?.key
  const field = chartable.find(f => f.key === key)
  const [contractType, setContractType] = useState('')
  const [currency, setCurrency] = useState('')
  const { data, isLoading, isError } = useQuery<FieldDistribution>({
    queryKey: ['analytics-by-field', key, contractType, currency],
    queryFn: () => api.get('/analytics/by-field', { params: { key, contractType: contractType || undefined, currency: currency || undefined } }).then(r => r.data),
    enabled: !!key,
  })
  const pick = (k: string) => {
    setPicked(k); setContractType(''); setCurrency('')
    try { window.localStorage.setItem(FIELD_CHART_KEY, k) } catch { /* storage unavailable */ }
  }
  const open = (b: FieldBucket) => {
    const params = new URLSearchParams({ ff: encodeFieldFilters(b.filters) })
    if (data?.contractType) params.set('type', data.contractType)
    navigate(`/contracts?${params}`)
  }
  // "No value" is said under the chart, not drawn in it: on a field few
  // contracts hold it would dwarf the bars that answer the question.
  const rows = data?.buckets ?? []
  const types = field?.contractTypes ?? null
  const SELECT = 'h-8 rounded-md border border-input bg-card px-2 text-[12.5px] text-ink-950'

  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" data-testid="chart-by-field">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-section text-ink-950">By field</h3>
          <p className="text-[11px] tabular-nums text-ink-500 mt-0.5">
            {data ? `${data.total.toLocaleString()} ${data.contractType ? `${data.contractType.replace(/_/g, ' ')} ` : ''}contract${data.total === 1 ? '' : 's'} · click a bar to see them` : 'Any field your contracts hold'}
          </p>
        </div>
        <select value={key ?? ''} onChange={e => pick(e.target.value)} aria-label="Field to chart" className={`${SELECT} max-w-[16rem]`} data-testid="chart-field">
          {catalogSections(chartable).map(s => (
            <optgroup key={s.title} label={s.title}>
              {s.fields.map(f => <option key={f.key} value={f.key}>{f.label}{typesOf(f) ? ` (${typesOf(f)})` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {!types || types.length > 1 ? (
          <select value={contractType} onChange={e => setContractType(e.target.value)} aria-label="Contract type" className={SELECT}>
            <option value="">{types ? 'Its contract types' : 'Every contract type'}</option>
            {(types ?? Object.values(ContractType)).map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        ) : null}
        {data && data.currencies.length > 1 && (
          <select value={data.currency ?? ''} onChange={e => setCurrency(e.target.value)} aria-label="Currency" className={SELECT}>
            {data.currencies.map(c => <option key={c.code} value={c.code}>{c.code} ({c.count})</option>)}
          </select>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center h-[200px] text-dense text-ink-500 gap-2"><Loader2 className="size-4 animate-spin" /> Counting…</div>
      ) : isError || !data ? (
        <div className="flex items-center justify-center h-[200px] text-dense text-ink-500">Couldn&apos;t chart this field.</div>
      ) : !data.buckets.some(b => b.count) ? (
        <div className="flex items-center justify-center h-[200px] text-dense text-ink-500 text-center px-6">
          {data.total ? `No contract has a ${data.label.toLowerCase()} yet${data.empty.count ? ` — ${data.empty.count.toLocaleString()} could have one.` : '.'}` : 'No contracts this field applies to yet.'}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 28 + 40)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 44, top: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} horizontal={false} />
            <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
            <YAxis type="category" dataKey="label" tick={AXIS_TICK} stroke={PAINT.grid} width={170} interval={0} />
            <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(23,22,26,0.04)' }} />
            {/* A field's values are categories, not meanings: the series stays neutral. */}
            <Bar dataKey="count" name="Contracts" fill={PAINT.neutral} isAnimationActive={false} cursor="pointer" onClick={(d: unknown) => open((d as { payload: FieldBucket }).payload)}>
              <LabelList dataKey="count" position="right" fontSize={11} fill={PAINT.inkMuted} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      {data && (data.empty.count > 0 || data.other > 0) && (
        <div className="text-[11px] text-ink-500 mt-3 pt-3 border-t border-paper-100 space-y-1">
          {data.empty.count > 0 && (
            <p>
              No value on {data.empty.count.toLocaleString()} of {data.total.toLocaleString()} ({Math.round((data.empty.count / Math.max(data.total, 1)) * 100)}%) —{' '}
              <button type="button" className="text-ink-950 hover:underline underline-offset-2" onClick={() => open(data.empty)} data-testid="chart-empty">see them</button>
            </p>
          )}
          {data.other > 0 && (
            <p>
              {data.kind === 'range'
                ? `${data.other.toLocaleString()} contract${data.other === 1 ? '' : 's'} in other currencies — pick one above.`
                : `${data.other.toLocaleString()} contract${data.other === 1 ? '' : 's'} with less common values not shown.`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * ChartCard — title, the plot, and (where it matters) what the plot leaves out.
 *
 * `footer` exists because the honest thing to say about a distribution is often
 * not on the axes: which rows were cut, how many records were never scored. An
 * `empty` state matters for the same reason — Recharts renders bare axes for an
 * empty series, which looks like a working chart reporting zero rather than a
 * page that has no data yet.
 */
function ChartCard({ title, subtitle, footer, empty, emptyLabel, children, ...rest }: {
  title:    string
  subtitle?: string
  footer?:  React.ReactNode
  empty?:   boolean
  emptyLabel?: string
  children: React.ReactNode
  'data-testid'?: string
}) {
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" {...rest}>
      <div className="mb-4">
        <h3 className="text-section text-ink-950">{title}</h3>
        {subtitle && <p className="text-[11px] tabular-nums text-ink-500 mt-0.5">{subtitle}</p>}
      </div>
      {empty ? (
        <div className="flex items-center justify-center h-[200px] text-dense text-ink-500">
          {emptyLabel ?? 'Nothing to plot yet.'}
        </div>
      ) : (
        children
      )}
      {!empty && footer && (
        <p className="text-[11px] text-ink-500 mt-3 pt-3 border-t border-paper-100 leading-relaxed">{footer}</p>
      )}
    </div>
  )
}
