/**
 * AnalyticsPage — executive dashboard (Phase 09 Step 1).
 *
 * Replaces the prior "Coming Soon" stub with a real KPI dashboard:
 * headline KPIs, contract status pie, contract type bar, risk
 * distribution, monthly volume trend, top counterparties by ACV.
 *
 * Backed by /api/v1/analytics/* endpoints. Each KPI card is clickable
 * — drills into the Contracts list pre-filtered (Step 3 will wire
 * the filter params on /contracts).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  Cell, LineChart, Line, CartesianGrid, Legend,
} from 'recharts'
import { api } from '@/lib/api'
import { MEANING_CLASS, statusMeaning, type Meaning } from '@/lib/status'
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
  data: { counterparty: string; counterpartyId: string | null; count: number; value: number; currency: string }[]
}

function formatMoney(n: number, currency = 'USD'): string {
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(0)}K`
  return `${currency} ${n.toFixed(0)}`
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

/*
 * Recharts paints with literal colors, not classes, so the palette has to be
 * restated as hex. Every value below is a stop from tailwind.config.ts — a bar
 * on this page carries exactly the same five meanings as a pill anywhere else,
 * so a reader who has learned the colors once does not relearn them here.
 */
const PAINT = {
  brand:     '#047857', // brand-700  — binding: approved, executed
  info:      '#2563EB', // info-600   — in flight: someone else's turn
  attention: '#CC7005', // attention-600 — your turn
  risk:      '#DC2626', // risk-600   — exposure
  riskDeep:  '#B91C1C', // risk-700   — the far end of the same family
  neutral:   '#757369', // ink-400    — nothing is happening
  grid:      '#E7E6E3', // paper-200
  // Axis ticks are text, so they answer to 4.5:1, not the 3:1 a bar or a dot
  // gets. ink-400 measures 4.76:1 on white but only 4.56:1 on paper-50, and at
  // 11px inside a busy plot it reads as a smudge — ink-500 is the same voice
  // with 5.6:1 behind it.
  axis:      '#6A6862', // ink-500
  ink:       '#17161A', // ink-950
  inkMuted:  '#57554F', // ink-700
  card:      '#FFFFFF', // paper-0
} as const

/** Meaning → series color, so status bars agree with the status pills. */
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

/*
 * Recharts styles the tooltip inline, so the tokens are restated literally:
 * paper-200 border, rounded-md (6px), shadow-e2. A tooltip floats above the
 * page but is not a dialog, so it stops at e2 — e3 stays for overlays.
 */
const TOOLTIP_CONTENT: React.CSSProperties = {
  background:   PAINT.card,
  border:       `1px solid ${PAINT.grid}`,
  borderRadius: 6,
  boxShadow:    '0 4px 12px -2px rgba(23,22,26,0.08)',
  fontSize:     12.5,
  padding:      '8px 10px',
}
const TOOLTIP_LABEL: React.CSSProperties = { color: PAINT.ink, fontWeight: 600, marginBottom: 2 }
const TOOLTIP_ITEM:  React.CSSProperties = { color: PAINT.inkMuted }
const AXIS_TICK = { fontSize: 11.5, fill: PAINT.axis }
const LEGEND_STYLE: React.CSSProperties = { fontSize: 11.5, color: PAINT.inkMuted }

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

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="analytics-page">
      <div className="flex items-center justify-between mb-1 gap-4">
        <div className="flex items-center gap-3">
          <BarChart2 className="size-4 text-ink-400" />
          <h1 className="text-title text-ink-950">Analytics</h1>
        </div>
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
      <p className="text-dense text-ink-500 mb-5">
        Portfolio KPIs, cycle time, and contract distribution at a glance.
      </p>

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
          subtitle={summary ? formatMoney(summary.executedTotalValue, summary.executedTotalCurrency) + ' total' : ''}
          to="/contracts?status=EXECUTED"
          loading={summaryLoading}
          data-testid="kpi-executed"
        />
        <KpiCard
          label="Pending approvals"
          value={summary?.pendingApprovals ?? 0}
          icon={Clock}
          tone="turn"
          to="/approvals"
          loading={summaryLoading}
          data-testid="kpi-approvals"
        />
        <KpiCard
          label="Expiring (90d)"
          value={summary?.expiringSoon ?? 0}
          icon={CalendarClock}
          // Not yet exposure — a 90-day runway is a renewal the user still has
          // time to act on, so it reads as "your turn", not as risk.
          tone="turn"
          to="/renewals?bucket=next_90"
          loading={summaryLoading}
          data-testid="kpi-expiring"
        />
        <KpiCard
          label="High risk + open"
          value={summary?.highRiskOpen ?? 0}
          icon={AlertTriangle}
          tone="risk"
          to="/contracts?riskBand=high"
          loading={summaryLoading}
          data-testid="kpi-high-risk"
        />
      </div>

      {/* KPIs row 2: time-based metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <MetricBar
          label="Cycle time"
          value={formatDays(summary?.cycleTimeAvgDays ?? null)}
          subtitle={`Median ${formatDays(summary?.cycleTimeMedianDays ?? null)} · over last ${summary?.windowDays ?? 90} days`}
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

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard title="Monthly contract volume" data-testid="chart-volume">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={ts?.series ?? []}>
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

        <ChartCard title="Status distribution" data-testid="chart-status">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart
              data={(dists?.byStatus ?? []).map(s => ({ name: s.key.replace(/_/g, ' '), count: s.count, key: s.key }))}
              layout="vertical"
              margin={{ left: 100, right: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} domain={[0, 'dataMax']} />
              <YAxis type="category" dataKey="name" tick={AXIS_TICK} stroke={PAINT.grid} width={90} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              <Bar dataKey="count" name="Contracts" isAnimationActive={false}>
                {/* One source of truth: the bar takes the same meaning the
                    StatusPill would give this status. */}
                {(dists?.byStatus ?? []).map((s, i) => (
                  <Cell key={i} fill={MEANING_PAINT[statusMeaning(s.key)]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard title="Risk distribution" data-testid="chart-risk">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={dists?.byRisk ?? []} layout="vertical" margin={{ left: 80 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
              <YAxis type="category" dataKey="label" tick={AXIS_TICK} stroke={PAINT.grid} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              <Bar dataKey="count" name="Contracts">
                {(dists?.byRisk ?? []).map((r, i) => (
                  <Cell key={i} fill={RISK_PAINT[r.key] ?? PAINT.neutral} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Contract types" data-testid="chart-types">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={(dists?.byType ?? []).slice(0, 10)} layout="vertical" margin={{ left: 80 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={PAINT.grid} />
              <XAxis type="number" tick={AXIS_TICK} stroke={PAINT.grid} allowDecimals={false} />
              <YAxis type="category" dataKey="key" tick={AXIS_TICK} stroke={PAINT.grid} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT}
                labelStyle={TOOLTIP_LABEL}
                itemStyle={TOOLTIP_ITEM}
                cursor={{ fill: 'rgba(23,22,26,0.04)' }}
              />
              {/* Contract type carries no meaning — it is a category, so the
                  series stays neutral rather than borrowing someone's color. */}
              <Bar dataKey="count" fill={PAINT.neutral} name="Contracts" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
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
                <th className="text-right px-5 py-2 font-semibold">Total ACV</th>
                <th className="text-right px-5 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-100">
              {tops.data.map(cp => (
                <tr key={cp.counterparty} className="hover:bg-paper-50">
                  <td className="px-5 py-2 font-medium text-ink-950">{cp.counterparty}</td>
                  <td className="px-5 py-2 text-right text-ink-700 tabular-nums">{cp.count}</td>
                  <td className="px-5 py-2 text-right font-medium text-ink-950 tabular-nums">{formatMoney(cp.value, cp.currency)}</td>
                  <td className="px-5 py-2 text-right">
                    {cp.counterpartyId ? (
                      <Link
                        to={`/contracts?counterpartyId=${encodeURIComponent(cp.counterpartyId)}&filterLabel=${encodeURIComponent(cp.counterparty)}`}
                        className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-ink-950 hover:text-brand-700"
                      >
                        View <ArrowRight className="size-3" />
                      </Link>
                    ) : (
                      <span className="text-[11.5px] text-ink-400">—</span>
                    )}
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
    <div className="border border-paper-200 rounded-card p-4 bg-card transition-colors hover:border-paper-300" {...rest}>
      <div className="flex items-start justify-between">
        <div className="text-[11px] text-ink-500">{label}</div>
        <div className={`size-6 rounded-md flex items-center justify-center ${m.wash} ${m.washFg}`}>
          <Icon className="size-3.5" />
        </div>
      </div>
      <div className="text-[24px] font-semibold tracking-[-0.02em] mt-1 tabular-nums text-ink-950">
        {loading ? <Loader2 className="size-5 animate-spin text-ink-400" /> : value}
      </div>
      {subtitle && <div className="text-[10.5px] text-ink-500 mt-0.5 truncate">{subtitle}</div>}
    </div>
  )
  return to ? <Link to={to} className="block">{card}</Link> : card
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
        <div className="text-[10.5px] text-ink-500 truncate">{subtitle}</div>
      </div>
    </div>
  )
}

function ChartCard({ title, children, ...rest }: {
  title:    string
  children: React.ReactNode
  'data-testid'?: string
}) {
  return (
    <div className="bg-card border border-paper-200 rounded-card p-5" {...rest}>
      <h3 className="text-section text-ink-950 mb-4">{title}</h3>
      {children}
    </div>
  )
}
