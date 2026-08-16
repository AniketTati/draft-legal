/**
 * ObligationsPage — org-wide obligations list (Phase 08 Step 3).
 *
 * Replaces the per-contract rail-only view with a queryable table:
 * filter by bucket (open / due-soon / overdue / completed), free-text
 * search, sortable columns, and a stats strip showing pipeline health.
 *
 * Click an obligation row to jump to the contract; a "Mark complete"
 * button appears on the row hover (Step 4 wires the modal).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  CalendarClock, DollarSign, Shield, RefreshCw, FileSearch, Bell,
  Check, AlertTriangle, Loader2, AlertCircle, ListTodo,
  Search, CheckCircle2, Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill, MeaningDot } from '@/components/ui/status-pill'
import { CountBadge, EmptyState } from '@/components/ui/primitives'
import type { Meaning } from '@/lib/status'
import { CompleteObligationModal } from '@/components/contracts/CompleteObligationModal'

type Bucket = 'all' | 'open' | 'due_soon' | 'overdue' | 'completed'

interface ApiObligation {
  id:               string
  type:             string
  description:      string
  owner:            string
  dueDate:          string | null
  recurrence:       string
  trigger:          string | null
  quote:            string
  severity:         string
  sectionRef:       string | null
  status:           'OPEN' | 'COMPLETED' | 'OVERDUE' | 'WAIVED'
  completedAt:      string | null
  notifiedAt:       string | null
  contract: {
    id: string
    title: string
    status: string
    type: string
    counterpartyName: string | null
  } | null
}

interface ApiStats {
  open: number
  dueSoon: number
  overdue: number
  completedRecent: number
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

const BUCKETS: { key: Bucket; label: string; statKey?: keyof ApiStats }[] = [
  { key: 'all',       label: 'All' },
  { key: 'open',      label: 'Open',         statKey: 'open' },
  { key: 'due_soon',  label: 'Due soon',     statKey: 'dueSoon' },
  { key: 'overdue',   label: 'Overdue',      statKey: 'overdue' },
  { key: 'completed', label: 'Completed',    statKey: 'completedRecent' },
]

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((new Date(t).setHours(0,0,0,0) - today.getTime()) / (24 * 3600 * 1000))
}

function dueLabel(iso: string | null, status: string): { text: string; tone: string } {
  if (!iso) return { text: 'No due date', tone: 'text-ink-400' }
  const d = daysUntil(iso)
  // A completed obligation is discharged — binding, not "on time".
  if (status === 'COMPLETED') return { text: new Date(iso).toLocaleDateString(), tone: 'text-brand-700' }
  // A waived obligation was excused, so it cannot be late. Without this it
  // read "66d overdue" in red next to a neutral "Waived" pill — the Due and
  // Status columns contradicting each other on the same row.
  if (status === 'WAIVED') return { text: new Date(iso).toLocaleDateString(), tone: 'text-ink-500' }
  if (d == null) return { text: new Date(iso).toLocaleDateString(), tone: 'text-ink-700' }
  if (d < 0)  return { text: `${-d}d overdue`, tone: 'text-risk-700 font-medium' }
  if (d === 0) return { text: 'Due today',     tone: 'text-attention-700 font-medium' }
  if (d === 1) return { text: 'Due tomorrow',  tone: 'text-attention-700 font-medium' }
  if (d <= 14) return { text: `Due in ${d}d`,  tone: 'text-attention-700 font-medium' }
  return { text: `Due in ${d}d`, tone: 'text-ink-500' }
}

/**
 * Whether an obligation is past its due date and still owed.
 *
 * The stored status cannot answer this: the API leaves an obligation OPEN when
 * its date slips, and OPEN maps to `inflight` — so a commitment 66 days late
 * renders calm blue in the Status column, the one column users are trained to
 * scan. lib/status is deliberately date-neutral (a status is a property of the
 * record, overdue-ness is a property of the record AND today), so the page
 * applies the date it knows and overrides the meaning.
 *
 * Completed and waived obligations are exempt: a discharged commitment cannot
 * be overdue, however long ago its date was.
 */
function isOverdue(o: ApiObligation): boolean {
  if (o.status === 'COMPLETED' || o.status === 'WAIVED') return false
  const d = daysUntil(o.dueDate)
  return d != null && d < 0
}

// Severity is exposure, so it tiers the same way the risk meter does: high is
// real risk, medium is the owner's turn to act, low is just a fact.
const SEVERITY_MEANING: Record<string, Meaning> = {
  high:   'risk',
  medium: 'turn',
  low:    'neutral',
}

export function ObligationsPage() {
  // Landing on "All" sorted by due date ascending opened this page on a wall of
  // obligations discharged last February, with the 120-days-late ones a long
  // scroll below. A queue should open on the work: "Open" is every commitment
  // still owed, oldest due date first, which is the order you drain them in.
  const [bucket, setBucket] = useState<Bucket>('open')
  const [q, setQ] = useState('')
  const [completeTarget, setCompleteTarget] = useState<{ id: string; description: string } | null>(null)
  const qc = useQueryClient()

  const { data: stats } = useQuery<ApiStats>({
    queryKey: ['obligations-stats'],
    queryFn:  () => api.get('/obligations/stats').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data, isLoading, isError } = useQuery<{ data: ApiObligation[]; total: number }>({
    queryKey: ['obligations-list', bucket, q],
    queryFn:  () => api.get(`/obligations?bucket=${bucket}${q ? `&q=${encodeURIComponent(q)}` : ''}&limit=100`).then(r => r.data),
    refetchInterval: 60_000,
  })

  /*
   * The obligations whose STORED status is the literal 'OVERDUE'.
   *
   * The server's overdue bucket and its overdue KPI both compute
   * `status = 'OPEN' AND dueDate < now`, so a row stored as OVERDUE is in
   * neither: it is not OPEN, so it fails the bucket, and it is not COMPLETED,
   * so it never leaves. Eight commitments up to 94 days late rendered a red
   * "Overdue" pill on the All tab and matched no filter on the page whose whole
   * job is to find them.
   *
   * The real fix is one line of server predicate (see the note in the handover);
   * until then this page refuses to under-report lateness, and asks for the rows
   * the bucket drops so both the count and the list are true.
   */
  const { data: storedOverdue } = useQuery<{ data: ApiObligation[]; total: number }>({
    queryKey: ['obligations-list', 'stored-overdue', q],
    queryFn:  () => api.get(`/obligations?status=OVERDUE${q ? `&q=${encodeURIComponent(q)}` : ''}&limit=100`).then(r => r.data),
    refetchInterval: 60_000,
  })
  const storedOverdueRows  = storedOverdue?.data ?? []
  // Disjoint by construction: the KPI counts status OPEN, these are status
  // OVERDUE, so the two can be added without double-counting.
  const storedOverdueTotal = storedOverdue?.total ?? 0
  const overdueTotal = (stats?.overdue ?? 0) + storedOverdueTotal

  const rows  = data?.data ?? []
  const items = bucket === 'overdue'
    ? [...rows, ...storedOverdueRows].sort((a, b) => {
        const at = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
        const bt = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
        return at - bt
      })
    : rows
  const total = bucket === 'overdue' ? overdueTotal : (data?.total ?? 0)

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="obligations-page">
      <div className="flex items-center justify-between gap-4 mb-1">
        <div className="flex items-center gap-2">
          <ListTodo className="size-4 text-ink-400" />
          <h1 className="text-title text-ink-950">Obligations</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const r = await api.get(`/obligations/export?bucket=${bucket}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { responseType: 'blob' })
            const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }))
            const a = document.createElement('a'); a.href = url; a.download = `obligations-${new Date().toISOString().slice(0,10)}.csv`
            document.body.appendChild(a); a.click(); a.remove()
            URL.revokeObjectURL(url)
          }}
          data-testid="export-obligations-btn"
        >
          <Download />
          Export CSV
        </Button>
      </div>
      <p className="text-body text-ink-500 mb-5">
        Every commitment extracted from your executed contracts — payments, SLAs, renewals, audits, and reports.
      </p>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Open"        value={stats?.open ?? 0}         meaning="inflight" data-testid="stat-open" />
        <StatCard label="Due in 30d"  value={stats?.dueSoon ?? 0}      meaning="turn"     data-testid="stat-due-soon" />
        <StatCard label="Overdue"     value={overdueTotal}             meaning="risk"     data-testid="stat-overdue" />
        <StatCard label="Completed (30d)" value={stats?.completedRecent ?? 0} meaning="binding" data-testid="stat-completed" />
      </div>

      {/* Filter tabs + search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-paper-200 pb-2">
        <div className="flex items-center gap-1 -mb-2 overflow-x-auto">
          {BUCKETS.map(b => {
            const isActive = bucket === b.key
            const count = b.key === 'overdue'
              ? overdueTotal
              : b.statKey ? stats?.[b.statKey] ?? 0 : null
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(b.key)}
                data-testid={`bucket-${b.key}`}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-ink-950 text-ink-950 font-medium'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
                }`}
              >
                {b.label}
                {count != null && count > 0 && (
                  // Bucket counts are informational — none of them is "your
                  // turn", so none of them earns a meaning colour.
                  <CountBadge tone={isActive ? 'ink' : 'neutral'}>{count}</CountBadge>
                )}
              </button>
            )
          })}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2 size-4 text-ink-400" />
          <Input
            type="search"
            placeholder="Search description or contract"
            value={q}
            onChange={e => setQ(e.target.value)}
            data-testid="obligations-search"
            className="pl-8 w-full sm:w-72"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-body text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Failed to load obligations.
        </div>
      ) : items.length === 0 ? (
        <div data-testid="obligations-empty">
          <EmptyState
            icon={<ListTodo />}
            title={
              q
                ? `No obligations match "${q}".`
                : bucket === 'completed'
                  ? 'No obligations completed in the last 30 days.'
                  : bucket === 'overdue'
                    ? 'Nothing overdue — well done.'
                    : bucket === 'due_soon'
                      ? 'Nothing due in the next 30 days.'
                      : bucket === 'open'
                        ? 'Nothing outstanding — every extracted commitment is discharged.'
                        : 'No obligations extracted yet.'
            }
            description="Obligations are auto-extracted when a contract is signed; you can also run extraction manually from any contract page."
          />
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <div className="px-5 py-2 text-[11px] text-ink-500 bg-paper-50 border-b border-paper-200 flex items-center justify-between">
            <span className="tabular-nums">{total} {total === 1 ? 'obligation' : 'obligations'}</span>
          </div>
          {/* Fixed layout, not content-driven. Six auto-width columns measured
              1116px inside a 730px shell with the assistant rail open, so
              Status and the Complete button — the status you scan for and the
              only action on the page — sat off-screen behind a horizontal
              scrollbar on every row. Severity moved into the description's meta
              line, where it reads as the property of the commitment it is. */}
          <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[13px]" data-testid="obligations-table">
            <thead className="bg-paper-50 text-eyebrow uppercase text-ink-500">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Description</th>
                <th className="text-left px-3 py-2 font-semibold w-[24%]">Contract</th>
                <th className="text-left px-3 py-2 font-semibold w-[104px]">Due</th>
                <th className="text-left px-3 py-2 font-semibold w-[112px]">Status</th>
                <th className="text-right px-4 py-2 font-semibold w-[122px]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {items.map(o => {
                const TypeIcon = TYPE_ICON[o.type] ?? Bell
                const due = dueLabel(o.dueDate, o.status)
                const sevMeaning = SEVERITY_MEANING[o.severity] ?? 'turn'
                const overdue = isOverdue(o)
                return (
                  <tr key={o.id} className="hover:bg-paper-50 align-top" data-testid={`obligation-row-${o.id}`}>
                    <td className="px-4 py-2">
                      <div className="flex items-start gap-2">
                        <TypeIcon className="size-3.5 text-ink-400 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-ink-950 truncate" title={o.description}>
                            {o.description}
                          </div>
                          <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1.5 truncate">
                            {/* Severity used to own a column of its own, which
                                cost 107px to say one word. It is a property of
                                the commitment, so it rides with the commitment —
                                one dot, named for screen readers. */}
                            <span className="inline-flex items-center gap-1 shrink-0">
                              <MeaningDot meaning={sevMeaning} label={`${o.severity} severity`} />
                              <span className="capitalize">{o.severity}</span>
                            </span>
                            <span className="uppercase font-mono tracking-[0.08em] text-[10px] shrink-0">· {o.type}</span>
                            <span className="truncate">· {o.owner}</span>
                            {o.sectionRef && <span className="font-mono shrink-0">§{o.sectionRef}</span>}
                            {o.recurrence !== 'one-time' && o.recurrence !== 'unknown' && (
                              // Recurrence is a property of the obligation, not a
                              // state — it gets no meaning colour.
                              <span className="text-ink-700 shrink-0">↻ {o.recurrence}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {o.contract ? (
                        <Link
                          to={`/contracts/${o.contract.id}`}
                          className="text-[11.5px] block truncate hover:underline underline-offset-2 decoration-paper-300"
                          title={`${o.contract.title}${o.contract.counterpartyName ? ` · ${o.contract.counterpartyName}` : ''}`}
                        >
                          <span className="font-medium text-ink-950">{o.contract.title}</span>
                          {o.contract.counterpartyName && (
                            <div className="text-ink-500 truncate">{o.contract.counterpartyName}</div>
                          )}
                        </Link>
                      ) : (
                        <span className="text-[11.5px] text-ink-400">(deleted)</span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-[11.5px] tabular-nums ${due.tone}`}>
                      {due.text}
                    </td>
                    <td className="px-3 py-2">
                      {/* An overdue obligation reads as risk here whatever the
                          stored status says — see isOverdue. */}
                      <StatusPill status={o.status} meaning={overdue ? 'risk' : undefined} />
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {/* Anything not yet discharged can be completed. Gating on
                          status === 'OPEN' hid the button from exactly the rows
                          stored as OVERDUE — the latest ones in the org, and the
                          only ones the endpoint would still accept.

                          Outlined, not filled: completing IS binding, but this
                          is a hundred-row queue, and a filled emerald button
                          repeated down every row makes the brand colour the
                          loudest thing on a page whose loudest thing should be
                          "120d overdue". The fill stays on single-decision
                          surfaces, including the confirmation modal this opens. */}
                      {o.status !== 'COMPLETED' && o.status !== 'WAIVED' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="text-brand-700 border-brand-200 hover:bg-brand-50"
                          onClick={() => setCompleteTarget({ id: o.id, description: o.description })}
                          data-testid={`complete-btn-${o.id}`}
                        >
                          <CheckCircle2 />
                          Complete
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {completeTarget && (
        <CompleteObligationModal
          obligationId={completeTarget.id}
          description={completeTarget.description}
          open={!!completeTarget}
          onClose={() => setCompleteTarget(null)}
          onCompleted={() => {
            qc.invalidateQueries({ queryKey: ['obligations-list'] })
            qc.invalidateQueries({ queryKey: ['obligations-stats'] })
            qc.invalidateQueries({ queryKey: ['contract-obligations'] })
          }}
        />
      )}
    </div>
  )
}

// The figure stays ink; the meaning rides on the dot beside the label. Four
// large coloured numbers would put four competing accents in one strip.
function StatCard({ label, value, meaning, ...rest }: {
  label: string
  value: number
  meaning: Meaning
  'data-testid'?: string
}) {
  return (
    <div className="border border-paper-200 rounded-card p-3 bg-card" {...rest}>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
        <MeaningDot meaning={meaning} label={label} />
        {label}
      </div>
      <div className="text-[24px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink-950 mt-1.5">
        {value}
      </div>
    </div>
  )
}
