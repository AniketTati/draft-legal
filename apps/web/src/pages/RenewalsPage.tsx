/**
 * RenewalsPage — org-wide renewal calendar (Phase 08 Step 7).
 *
 * Lists every EXECUTED contract whose expiryDate falls inside the
 * lookahead window, grouped by month. Each month shows count + total
 * ACV; each row shows counterparty, value, expiryDate, decision state,
 * and links to the contract detail page where the user records a
 * decision (renew | renegotiate | let_lapse | terminate) via the
 * RenewalAdviceRailSection.
 *
 * "Calendar" here means a month-grouped timeline, not a Google-style
 * grid — for legal portfolios, the relevant question is "what
 * decisions are needed in the next N days," not "what date is May 17."
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatCurrencyTotals, totalsByCurrency, type CurrencyTotal } from '@clm/types'
import {
  CalendarDays, ArrowRight, Loader2, AlertCircle, RefreshCw,
  Clock, AlertTriangle, Search, Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/status-pill'
import { CountBadge, EmptyState } from '@/components/ui/primitives'
import { AssistChip } from '@/components/ui/assist'
import { MEANING_CLASS, type Meaning } from '@/lib/status'
import { RenewalDecisionDialog } from '@/components/contracts/RenewalDecisionDialog'

type Bucket = 'all' | 'this_week' | 'next_30' | 'next_60' | 'next_90' | 'overdue'
type StatusFilter = 'all' | 'pending' | 'decided'

/** AI-extracted term sheet. Every field is best-effort and may be missing. */
interface KeyTerms {
  autoRenew?: boolean | null
  /**
   * Days of notice-to-terminate required before expiry.
   *
   * Four writers, four spellings, and no migration ever unified them:
   * `noticePeriodDays` is what the extraction agent emits (review_agent.py
   * rawFields), `noticePeriod` is what a human writes when they correct the
   * field in the review queue (FIELD_LABELS in api/routes/review-queue.ts) and
   * is a phrase like "90 days", `renewalNoticeDays` comes from the audit seed,
   * and `noticeDays` from the demo portfolio seed. The server reads all four
   * (apps/api/src/lib/renewal-notice.ts) and returns the result as `notice`.
   */
  noticeDays?:       number | string | null
  noticePeriodDays?: number | string | null
  renewalNoticeDays?: number | string | null
  noticePeriod?:     number | string | null
}

interface RenewalRow {
  id:               string
  title:            string
  type:             string
  counterpartyName: string | null
  expiryDate:       string | null
  effectiveDate:    string | null
  value:            string | null
  /** docs/39 F3 — value per year, when the contract says what its value is. */
  annualValue?:     number | null
  currency:         string | null
  ownerId:          string
  ownerName:        string | null
  keyTerms:         KeyTerms | null
  /**
   * The auto-renewal notice deadline, derived server-side (C6) by the same
   * function the daily renewal scan alerts on, so this row and the alert agree.
   * docs/39 F1 — `label` is the notice as written ("3 months"); `confirmed`
   * is false for a notice found before notices were told apart, which may be
   * the notice to end early: the row asks someone to confirm it.
   */
  notice?: { autoRenew: boolean; days: number | null; label?: string | null; confirmed?: boolean; deadline: string | null }
  /** docs/39 G3 — an amendment ending it on another date, not set on it yet. */
  pendingAmendment?: { id: string; title: string; expiryDate: string } | null
  renewalDecision:    string | null
  renewalDecisionAt:  string | null
  noticeSentAt?:      string | null
  /** docs/41 Part 14 — in its renewal window: "Start renewal". */
  inWindow?:          boolean
  renewalAdvice: {
    recommendation: string
    confidence:     string
    rationale:      string
  } | null
}

interface MonthGroup {
  month:      string
  label:      string
  rows:       RenewalRow[]
  /** docs/39 D4 — per currency (older APIs send only totalValue + currency). */
  totals?:    CurrencyTotal[]
  totalValue: number
  currency:   string
}

interface ApiList {
  data:    RenewalRow[]
  months:  MonthGroup[]
  total:   number
  window:  { from: string; to: string }
}

interface ApiStats {
  overdue:        number
  thisWeek:       number
  next30:         number
  next60:         number
  next90:         number
  undecided:      number
  totalAcvNext90: number
  /** docs/39 D4 — per currency (older APIs send only totalAcvNext90). */
  acvNext90?: CurrencyTotal[]
}

const BUCKETS: { key: Bucket; label: string; statKey?: 'overdue' | 'thisWeek' | 'next30' | 'next60' | 'next90' | 'undecided' }[] = [
  { key: 'all',       label: 'Next year' },
  { key: 'this_week', label: 'This week',  statKey: 'thisWeek' },
  { key: 'next_30',   label: 'Next 30d',   statKey: 'next30' },
  { key: 'next_60',   label: 'Next 60d',   statKey: 'next60' },
  { key: 'next_90',   label: 'Next 90d',   statKey: 'next90' },
  { key: 'overdue',   label: 'Overdue',    statKey: 'overdue' },
]

// A recorded renewal decision IS the outcome: renew binds, let-expire is the
// contract lapsing, renegotiate puts the ball back with the owner.
const DECISION_PILL: Record<string, { meaning: Meaning; label: string }> = {
  renew:        { meaning: 'binding', label: 'Renew' },
  renegotiate:  { meaning: 'turn',    label: 'Renegotiate' },
  // docs/41 Part 14 — not renewing: let it lapse, or end it.
  let_lapse:    { meaning: 'risk',    label: 'Let it lapse' },
  terminate:    { meaning: 'risk',    label: 'End it' },
}

// The model's advice is not the decision, so it wears the assist mark instead of
// the meaning colour the real decision would earn.
const ADVICE_LABEL: Record<string, string> = {
  RENEW:        'AI: Renew',
  RENEGOTIATE:  'AI: Renegotiate',
  LET_EXPIRE:   'AI: Let expire',
  PAUSE:        'AI: Pause',
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((new Date(t).setHours(0, 0, 0, 0) - today.getTime()) / (24 * 3600 * 1000))
}

function dueText(iso: string | null): { text: string; tone: string } {
  if (!iso) return { text: 'No date', tone: 'text-ink-400' }
  const d = daysUntil(iso)
  const dateStr = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (d == null) return { text: dateStr, tone: 'text-ink-700' }
  if (d < 0)  return { text: `${dateStr} · ${-d}d ago`,        tone: 'text-risk-700 font-medium' }
  if (d === 0) return { text: `${dateStr} · today`,             tone: 'text-attention-700 font-medium' }
  if (d <= 7)  return { text: `${dateStr} · in ${d}d`,          tone: 'text-attention-700 font-medium' }
  if (d <= 30) return { text: `${dateStr} · in ${d}d`,          tone: 'text-attention-700' }
  return { text: `${dateStr} · in ${d}d`, tone: 'text-ink-500' }
}

/**
 * The auto-renewal notice deadline: expiry minus the notice-to-terminate
 * period — the last day anyone can stop the contract renewing.
 *
 * This cannot be read off the expiry date the row already shows, and that is
 * exactly why it needs its own line: the two run on different clocks. A
 * contract expiring in 40 days with a 90-day notice period is 50 days past the
 * point of no return, while the expiry column still reads a calm "in 40d" —
 * the renewal is already locked in and nothing on the row said so. Once the
 * deadline has passed or is close it is live exposure, so it takes the risk
 * colour rather than the expiry date's chrome, and carries an icon so the
 * colour is not the only signal.
 *
 * Returns null for contracts that do not auto-renew: there is no deadline to
 * miss, and a line on every row would spend the risk colour as decoration.
 */
function noticeDeadline(r: RenewalRow): {
  text: string
  tone: string
  title: string
  atRisk: boolean
} | null {
  const n = r.notice
  if (!n?.autoRenew) return null

  const days = n.days

  // Auto-renewing, but there is no notice period (or no expiry) to subtract.
  // Say so — a fabricated date is worse than an admitted gap, because this is
  // a date people diarise against.
  if (days == null || !n.deadline) {
    return {
      text:   'Auto-renews · notice period unknown',
      tone:   'text-ink-500',
      title:  'This contract auto-renews, but no notice-to-terminate period was extracted, so the deadline to stop it is unknown.',
      atRisk: false,
    }
  }

  const deadline = new Date(n.deadline)
  const dateStr  = deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const d        = daysUntil(deadline.toISOString())
  // docs/39 F1 — the notice as the contract writes it: "3 months" counts back by the calendar.
  const period   = n.label ?? `${days} days`
  const title    = `Auto-renews. ${period}' notice to stop it renewing, so notice must be served by ${dateStr}.`
  const risky    = 'text-risk-700 font-medium'

  if (d == null) return { text: `Notice by ${dateStr}`, tone: 'text-ink-500', title, atRisk: false }
  if (d < 0)     return { text: `Notice deadline passed · ${dateStr}`, tone: risky, title, atRisk: true }
  if (d === 0)   return { text: `Notice due today · ${dateStr}`,       tone: risky, title, atRisk: true }
  if (d <= 30)   return { text: `Notice by ${dateStr} · ${d}d left`,   tone: risky, title, atRisk: true }
  return { text: `Notice by ${dateStr}`, tone: 'text-ink-500', title, atRisk: false }
}

function formatMoney(n: number, currency = 'USD'): string {
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(0)}K`
  return `${currency} ${n.toFixed(0)}`
}

export function RenewalsPage() {
  const [bucket, setBucket] = useState<Bucket>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')

  const { data: stats } = useQuery<ApiStats>({
    queryKey: ['renewals-stats'],
    queryFn:  () => api.get('/renewals/stats').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data, isLoading, isError } = useQuery<ApiList>({
    queryKey: ['renewals-list', bucket, statusFilter],
    queryFn:  () => api.get(`/renewals?bucket=${bucket}&status=${statusFilter}`).then(r => r.data),
    refetchInterval: 60_000,
  })

  /*
   * The notice-to-terminate deadline is the only irreversible date on this
   * page: once it passes, an auto-renewing contract renews whatever anyone
   * decides afterwards. It was computed per row and shown in red, but there was
   * no way to ask for just those rows — so finding them meant reading every
   * month group. This is the filter a renewals owner actually wants.
   */
  const [noticeOnly, setNoticeOnly] = useState(false)
  // docs/41 Part 14 — the decision dialog, for a row.
  const [deciding, setDeciding] = useState<{ id: string; title: string } | null>(null)
  const noticeAtRiskCount = (data?.data ?? []).filter(r => noticeDeadline(r)?.atRisk).length
  // docs/39 F1/B4 — notice periods found before the notices were told apart.
  const unconfirmedCount = (data?.data ?? []).filter(r => r.notice?.confirmed === false).length

  // Client-side text filter — server endpoint doesn't support `q` for renewals yet.
  const needle = q.trim().toLowerCase()
  const clientFiltered = noticeOnly || !!needle
  const filteredMonths = (data?.months ?? []).map(m => {
    const rows = m.rows.filter(r => {
      if (noticeOnly && !noticeDeadline(r)?.atRisk) return false
      if (!needle) return true
      return (
        r.title.toLowerCase().includes(needle) ||
        (r.counterpartyName ?? '').toLowerCase().includes(needle)
      )
    })
    // The month header's ACV is a sum of the rows under it. When a client-side
    // filter drops rows the server's total stops describing what is on screen —
    // "8 renewals · USD 7.77M ACV" over eight rows that add up to less is the
    // kind of number a renewals owner will quote in a QBR. Re-sum what is shown.
    // docs/39 D4 — one total per currency: rows in EUR and USD were summed.
    return {
      ...m,
      rows,
      totals: clientFiltered || !m.totals ? totalsByCurrency(rows.map(r => ({ value: r.annualValue ?? r.value, currency: r.currency }))) : m.totals,
    }
  }).filter(m => m.rows.length > 0)

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="renewals-page">
      <div className="flex items-center justify-between gap-4 mb-1">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-ink-400" />
          <h1 className="text-title text-ink-950">Renewals</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const r = await api.get('/renewals/export', { responseType: 'blob' })
            const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }))
            const a = document.createElement('a'); a.href = url; a.download = `renewals-${new Date().toISOString().slice(0,10)}.csv`
            document.body.appendChild(a); a.click(); a.remove()
            URL.revokeObjectURL(url)
          }}
          data-testid="export-renewals-btn"
        >
          <Download />
          Export CSV
        </Button>
      </div>
      <p className="text-body text-ink-500 mb-5">
        Every executed contract heading toward its expiry — grouped by month so you can see what decisions are needed when.
      </p>
      {unconfirmedCount > 0 && (
        <div className="flex items-center gap-2 mb-5 rounded-md border border-attention-200 bg-attention-50 px-3 py-2 text-dense text-ink-950" data-testid="renewals-unconfirmed-banner">
          <AlertTriangle className="size-3.5 text-attention-600 shrink-0" />
          <span>
            {unconfirmedCount} renewal{unconfirmedCount === 1 ? ' has a notice period' : 's have notice periods'} whose type isn&apos;t confirmed, so {unconfirmedCount === 1 ? 'its' : 'their'} opt-out deadline{unconfirmedCount === 1 ? '' : 's'} may be wrong.
          </span>
          <Link to="/review-queue?reason=notice_type" className="ml-auto shrink-0 font-medium text-ink-950 hover:underline underline-offset-2" data-testid="renewals-unconfirmed-link">
            Sort them out →
          </Link>
        </div>
      )}

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="This week"    value={stats?.thisWeek ?? 0} meaning="risk"    icon={Clock}        data-testid="stat-this-week" />
        <StatCard label="Next 30 days" value={stats?.next30 ?? 0}   meaning="turn"    icon={CalendarDays} data-testid="stat-next-30" />
        <StatCard label="Next 90 days" value={stats?.next90 ?? 0}   meaning="neutral" icon={CalendarDays} data-testid="stat-next-90" />
        <StatCard
          label="Decisions needed"
          value={stats?.undecided ?? 0}
          meaning="turn"
          icon={AlertTriangle}
          data-testid="stat-undecided"
          subtitle={stats?.acvNext90?.length ? `next 90d · ${formatCurrencyTotals(stats.acvNext90, { max: 2 })} ACV` : stats?.totalAcvNext90 ? `next 90d · ${formatMoney(stats.totalAcvNext90)} ACV` : 'next 90d'}
        />
      </div>

      {/* Filter rows. Buckets and controls used to share one line, which at
          sidebar-plus-rail width scrolled four of the six windows out of sight —
          including Overdue. Two rows, each free to use the full width. */}
      <div className="flex flex-col gap-2 mb-5 border-b border-paper-200 pb-2">
        <div className="flex items-center gap-1 overflow-x-auto">
          {BUCKETS.map(b => {
            const active = bucket === b.key
            const count = b.statKey ? stats?.[b.statKey] ?? 0 : null
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(b.key)}
                data-testid={`renewal-bucket-${b.key}`}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-ink-950 text-ink-950 font-medium'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
                }`}
              >
                {b.label}
                {count != null && count > 0 && (
                  <CountBadge tone={active ? 'ink' : 'neutral'}>{count}</CountBadge>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {noticeAtRiskCount > 0 && (
            <button
              type="button"
              onClick={() => setNoticeOnly(v => !v)}
              aria-pressed={noticeOnly}
              data-testid="renewal-notice-filter"
              title="Auto-renewing contracts whose notice-to-terminate deadline has passed or is within 30 days"
              className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-[11.5px] font-medium whitespace-nowrap transition-colors ${
                noticeOnly
                  ? 'border-risk-600 bg-risk-50 text-risk-700'
                  : 'border-input bg-card text-ink-700 hover:bg-paper-100'
              }`}
            >
              <AlertTriangle className="size-3.5 text-risk-600" />
              Notice at risk
              <span className="tabular-nums">{noticeAtRiskCount}</span>
            </button>
          )}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Filter by renewal decision"
            data-testid="renewal-decision-filter"
            className="h-8 text-[13px] text-ink-950 border border-input rounded-md px-2 bg-card focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
          >
            <option value="all">All decisions</option>
            <option value="pending">No decision yet</option>
            <option value="decided">Decided</option>
          </select>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-2 size-4 text-ink-400" />
            <Input
              type="search"
              placeholder="Search title or counterparty"
              value={q}
              onChange={e => setQ(e.target.value)}
              data-testid="renewals-search"
              className="pl-8 w-full"
            />
          </div>
        </div>
      </div>

      {/* Month groups */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-body text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Failed to load renewals.
        </div>
      ) : filteredMonths.length === 0 ? (
        <div data-testid="renewals-empty">
          <EmptyState
            icon={<CalendarDays />}
            title={
              noticeOnly
                ? 'No notice deadlines at risk in this window.'
                : q ? `No renewals match "${q}".` : 'No upcoming renewals in this window.'
            }
            description={
              noticeOnly
                ? 'Every auto-renewing contract here still has time to serve notice.'
                : 'Renewals appear here once a contract is executed and the expiry date is set.'
            }
          />
        </div>
      ) : (
        <div className="space-y-5">
          {filteredMonths.map(m => (
            <section
              key={m.month}
              data-testid={`renewal-month-${m.month}`}
              className="bg-card border border-paper-200 rounded-card overflow-hidden"
            >
              <header className="flex items-center justify-between bg-paper-50 px-5 py-2 border-b border-paper-200">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-section text-ink-950">{m.label}</h3>
                  <span className="text-[11px] tabular-nums text-ink-500">
                    {m.rows.length} {m.rows.length === 1 ? 'renewal' : 'renewals'}
                  </span>
                </div>
                {(m.totals?.length ?? 0) > 0 && (
                  <span className="text-[11px] font-medium text-ink-700 tabular-nums" data-testid={`renewal-month-total-${m.month}`}>
                    {formatCurrencyTotals(m.totals ?? [], { max: 2 })} ACV
                  </span>
                )}
              </header>
              <ul className="divide-y divide-paper-200">
                {m.rows.map(r => {
                  const due = dueText(r.expiryDate)
                  const notice = noticeDeadline(r)
                  const decisionPill = r.renewalDecision ? DECISION_PILL[r.renewalDecision] : null
                  const adviceLabel = r.renewalAdvice
                    ? ADVICE_LABEL[r.renewalAdvice.recommendation?.toUpperCase() ?? '']
                    : null
                  return (
                    <li
                      key={r.id}
                      data-testid={`renewal-row-${r.id}`}
                      data-decision={r.renewalDecision ?? 'none'}
                      className="flex items-center px-5 py-2 gap-3 hover:bg-paper-50"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/contracts/${r.id}`}
                            className="text-[13px] font-medium text-ink-950 hover:underline underline-offset-2 decoration-paper-300 truncate max-w-[400px]"
                            title={r.title}
                          >
                            {r.title}
                          </Link>
                          <span className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400">
                            {r.type.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-2">
                          {r.counterpartyName && <span>{r.counterpartyName}</span>}
                          {r.value && <span>· {formatMoney(Number(r.value), r.currency ?? 'USD')}</span>}
                          {r.ownerName && <span>· {r.ownerName}</span>}
                        </div>
                        {/* docs/39 G3 — the date above may be the one an amendment replaced. */}
                        {r.pendingAmendment && (
                          <Link
                            to={`/contracts/${r.pendingAmendment.id}`}
                            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-attention-700 hover:underline underline-offset-2"
                            title="Its amendment's terms aren't set on it yet: open the amendment to set them"
                            data-testid={`renewal-amended-${r.id}`}
                          >
                            <AlertTriangle className="size-3 shrink-0" />
                            {r.pendingAmendment.title} ends it on {new Date(r.pendingAmendment.expiryDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} — not set on it yet
                          </Link>
                        )}
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <div className={`text-[11.5px] tabular-nums ${due.tone}`}>
                          {due.text}
                        </div>
                        {notice && (
                          <div
                            className={`mt-0.5 flex items-center justify-end gap-1 text-[10.5px] tabular-nums ${notice.tone}`}
                            title={notice.title}
                            data-testid={`renewal-notice-${r.id}`}
                          >
                            {notice.atRisk && <AlertTriangle className="size-3 shrink-0" />}
                            {notice.text}
                          </div>
                        )}
                        {notice && r.notice?.confirmed === false && (
                          <Link
                            to={`/contracts/${r.id}?panel=fields&field=noticePeriodDays`}
                            className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] text-attention-700 hover:underline underline-offset-2"
                            title="This notice period was found before the AI told the notice to stop a renewal apart from the notice to end early. Confirm which it is."
                            data-testid={`renewal-notice-unconfirmed-${r.id}`}
                          >
                            Notice type unconfirmed · check
                          </Link>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {adviceLabel && !decisionPill && (
                          <span title={r.renewalAdvice?.rationale ?? ''}>
                            <AssistChip>{adviceLabel}</AssistChip>
                          </span>
                        )}
                        {decisionPill ? (
                          <button type="button" onClick={() => setDeciding(r)} title="Change the decision" data-testid={`renewal-decided-${r.id}`}>
                            <StatusPill meaning={decisionPill.meaning}>{decisionPill.label}{(r.renewalDecision === 'let_lapse' || r.renewalDecision === 'terminate') && !r.noticeSentAt ? ' · notice not sent' : ''}</StatusPill>
                          </button>
                        ) : (
                          <Button
                            size="xs"
                            variant={r.inWindow ? 'default' : 'outline'}
                            onClick={() => setDeciding(r)}
                            data-testid={`renewal-start-${r.id}`}
                          >
                            <RefreshCw />
                            Start renewal
                          </Button>
                        )}
                        <Link
                          to={`/contracts/${r.id}`}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-950 hover:text-ink-700 ml-2"
                        >
                          Open
                          <ArrowRight className="size-3" />
                        </Link>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {deciding && <RenewalDecisionDialog contractId={deciding.id} title={deciding.title} onClose={() => setDeciding(null)} />}
    </div>
  )
}

// The figure stays ink; only the label's icon carries the meaning, so a strip of
// four does not put four large coloured numbers side by side.
function StatCard({ label, value, meaning, icon: Icon, subtitle, ...rest }: {
  label: string
  value: number
  meaning: Meaning
  icon: React.ComponentType<{ className?: string }>
  subtitle?: string
  'data-testid'?: string
}) {
  return (
    <div className="border border-paper-200 rounded-card p-3 bg-card" {...rest}>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
        <Icon className={`size-3.5 ${MEANING_CLASS[meaning].fg}`} />
        {label}
      </div>
      <div className="text-[24px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink-950 mt-1.5">
        {value}
      </div>
      {subtitle && <div className="text-[10.5px] tabular-nums text-ink-500 mt-1">{subtitle}</div>}
    </div>
  )
}
