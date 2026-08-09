import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import {
  FileText, ClipboardList, CheckSquare, AlertCircle,
  Upload, Plus, ArrowRight, Loader2, CircleCheckBig, FileEdit, Clock,
  MessageSquareWarning, Repeat, AlertTriangle, Building2,
} from 'lucide-react'
import { toast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MEANING_CLASS, normalizeRisk, riskBand, type Meaning } from '@/lib/status'
import { UploadModal } from '@/components/contracts/UploadModal'
import { NewRequestModal } from '@/components/requests/NewRequestModal'
import { WelcomeChecklist } from '@/components/onboarding/WelcomeChecklist'
// U.4.2 — HeroAgent deleted. The right Ask rail is the AI surface on dashboard.

// ─── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function absoluteTime(dateStr: string) {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function resourceLink(entityType: string, entityId: string): string {
  if (entityType === 'contract') return `/contracts/${entityId}`
  if (entityType === 'contract_request') return `/requests`
  if (entityType === 'approval_instance') return `/approvals`
  return '/dashboard'
}

// The per-actor colour hash is gone: activity avatars are one neutral paper
// chip. A rainbow of identity colours down the feed competes with the five
// meaning colours, and identity is already carried by the initials.

// Severity band → meaning. Kept as a local literal on purpose: lib/status.ts
// declines to export this map so a RiskBand can never be typed as a Meaning and
// handed to <StatusPill> (see riskBand's docstring). It is the same literal the
// contract detail page and the approval strip use, so a score that turns amber
// there cannot stay calm here.
const RISK_TO_MEANING = { low: 'binding', medium: 'turn', high: 'risk' } as const

// ─── Component ─────────────────────────────────────────────────────────────────

interface ActivityEntry {
  id: string
  actorId: string
  actorName: string
  actorInitials: string
  verb: string
  entityType: string
  entityId: string
  entityTitle: string
  entityStatus?: string
  secondary?: string
  createdAt: string
}

// P7.1.1 — Per-user "your day" surface. Counts + inline rows for the
// items that need the user's attention TODAY. The arrays let the
// dashboard render persona-aware cards instead of dumping the user
// into the org-wide list view.
export interface YourDayContractRow {
  id: string
  title: string
  type: string
  status: string
  counterpartyName: string | null
  value: number | null
  currency: string | null
  // Negotiations only:
  riskScore?: number | null
  daysSinceUpdate?: number | null
  // Renewals only:
  expiryDate?: string | null
  daysToExpiry?: number | null
}

interface YourDay {
  approvalsWaiting: number
  requestsWaiting: number
  contractsExpiring: number
  draftsInProgress: number
  // P7.1.1 — F-78 fix: surface contracts the user owns that are in
  // negotiation, so Legal lands on dashboard and immediately sees
  // their headline contract instead of "all caught up".
  negotiationsInFlight?: number
  total: number
  // P7.1.1 — Inline cards for the dashboard. Each array max 5 entries.
  negotiations?: YourDayContractRow[]
  renewals?: YourDayContractRow[]
}

interface DashboardStats {
  activeContracts: number
  openRequests: number
  pendingApprovals: number
  // P7.2.3 — Org-wide pending approval count, used by admin / legal-ops
  // who don't typically appear in step queues but need the oversight signal.
  orgPendingApprovals?: number
  expiringSoon: number
  yourDay?: YourDay
  recentActivity: ActivityEntry[]
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // P7.2.3 — Admin-like roles get the org-wide oversight KPI variant.
  const isAdminLike = (user?.roles ?? []).some(r => r === 'ADMIN' || r === 'LEGAL_OPS')

  // B.6.6 — Quick Actions open their modals inline instead of routing
  // away. "Upload Contract" on the dashboard should upload a contract,
  // not take me on a detour through the list page first.
  const [showUpload, setShowUpload] = useState(false)
  const [showNewRequest, setShowNewRequest] = useState(false)

  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get('/dashboard').then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  // KPI icon tints: a headline count is a fact, not a state, so the icons are
  // quiet ink. "Expiring Soon" is the exception — expiry is real exposure.
  const cards = [
    {
      label: 'Active Contracts',
      value: stats?.activeContracts,
      icon: FileText,
      color: 'text-ink-500',
      bg: 'bg-paper-100',
      to: '/contracts',
    },
    {
      label: 'Open Requests',
      value: stats?.openRequests,
      icon: ClipboardList,
      color: 'text-ink-500',
      bg: 'bg-paper-100',
      to: '/requests',
    },
    {
      // P7.2.3 — Admin / legal-ops see the ORG-WIDE pending count
      // ("how many deals are stuck somewhere in my org?"); everyone
      // else sees their personal queue ("what needs my decision?").
      // The `to` deep-link mirrors that — admins land on the All
      // approvals tab, others on My Queue.
      label: isAdminLike ? 'Org Approvals' : 'Pending Approvals',
      value: isAdminLike ? (stats?.orgPendingApprovals ?? 0) : stats?.pendingApprovals,
      icon: CheckSquare,
      color: 'text-ink-500',
      bg: 'bg-paper-100',
      to: '/approvals',
    },
    {
      label: 'Expiring Soon',
      value: stats?.expiringSoon,
      icon: AlertCircle,
      // Dim the red when count is zero so we don't cry-wolf about
      // a category that's actually empty.
      color: (stats?.expiringSoon ?? 0) > 0 ? 'text-risk-600' : 'text-ink-500',
      bg: (stats?.expiringSoon ?? 0) > 0 ? 'bg-risk-50' : 'bg-paper-100',
      // B.6.5 — deep-link with the same 30-day window the KPI count
      // uses on the server. ContractsPage reads this on mount and
      // shows a dismissable "Expiring by <date>" chip so the user
      // understands why the list is scoped.
      to: (() => {
        const d = new Date()
        d.setDate(d.getDate() + 30)
        return `/contracts?expiryDateTo=${d.toISOString().slice(0, 10)}&filterLabel=Expiring+within+30+days`
      })(),
    },
  ]

  return (
    <div className="p-6 space-y-6">
      {/* Greeting — the "Your day" heading: 22/600, one line of summary under it. */}
      <div>
        <h1 className="text-[22px] font-semibold leading-[1.25] tracking-[-0.02em] text-ink-950">
          Welcome back, {user?.name?.split(' ')[0]}
        </h1>
        <p className="text-body text-ink-700 mt-1.5">
          Here's what's happening with your contracts today.
        </p>
      </div>

      {/* Welcome checklist — surfaces deferred onboarding tasks for admins
          who finished the 2-step wizard. Auto-hides when complete or
          dismissed; persists dismissal to org.settings. */}
      <WelcomeChecklist />

      {/* D.2.1 — Hero agent. Hidden behind AGENT_SIDE_PANEL_V2 flag.
          Above Your Day because "what can I ask AI to do" is the new
          first-of-day orientation; the stats below still answer "what
          needs me" for users who prefer checking queues.
          U.4.2 — HeroAgent deleted (doc 32 §11b item 6). Decision 14a
          locked AI to two surfaces only: the rail (companion) and the
          /agent route (studio). The dashboard's HeroAgent input was
          the third — confused users and competed with the rail. */}

      {/* B.6.15 — Your day band. Renders before KPIs because "what
          needs me" beats "what's the state of the org" for a user's
          first-of-day orientation. */}
      {!isLoading && stats?.yourDay && (
        <YourDayBand yourDay={stats.yourDay} />
      )}

      {/* Quick Actions — promoted above KPIs so the action-oriented buttons
          land in the first eye-stop (was buried below the cards). Same
          three actions, same selectors — only the position moved. */}
      <div className="flex items-center gap-2" data-testid="dashboard-quick-actions">
        <Button onClick={() => setShowUpload(true)} data-testid="quick-upload-contract">
          <Upload /> Upload Contract
        </Button>
        <Button
          variant="outline"
          onClick={() => setShowNewRequest(true)}
          data-testid="quick-new-request"
        >
          <Plus /> New Request
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate('/approvals')}
          data-testid="quick-view-approvals"
        >
          <CheckSquare /> View Approvals
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="dashboard-kpi-cards">
        {cards.map(({ label, value, icon: Icon, color, bg, to }) => {
          // P18 — derive a stable testid slug per card so probes can
          // target each KPI deterministically (label varies by role).
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          return (
            <button
              key={label}
              onClick={() => navigate(to)}
              data-testid={`kpi-card-${slug}`}
              data-kpi-label={label}
              data-kpi-value={value ?? ''}
              className="rounded-card border border-paper-200 bg-card p-5 space-y-3 text-left transition-colors hover:border-paper-300 hover:bg-paper-50 group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-500">{label}</span>
                <div className={`p-1.5 rounded-chip ${bg}`}>
                  <Icon size={16} className={color} />
                </div>
              </div>
              {isLoading ? (
                <Loader2 className="size-5 animate-spin text-ink-400" />
              ) : (
                <div className="flex items-end justify-between">
                  <p
                    className="text-[24px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink-950"
                    data-testid={`kpi-value-${slug}`}
                  >
                    {value ?? 0}
                  </p>
                  <ArrowRight className="size-4 text-ink-400 group-hover:text-ink-700 transition-colors" />
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Recent Activity */}
      <div className="rounded-card border border-paper-200 bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-section text-ink-950">Recent Activity</h2>
          {stats?.recentActivity && stats.recentActivity.length > 0 && (
            <span className="text-[11px] tabular-nums text-ink-400">
              {stats.recentActivity.length} event{stats.recentActivity.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-ink-400 py-4">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-dense">Loading activity...</span>
          </div>
        ) : !stats?.recentActivity?.length ? (
          // P7.4.10 / F-05 — empty-state copy adapts to whether the org
          // is brand-new (0 contracts) vs has contracts but no audit
          // events yet. The previous copy ("Upload a contract to get
          // started") was misleading for orgs with 15+ contracts but
          // direct-DB seed (no AuditEvent rows yet).
          (stats?.activeContracts ?? 0) > 0 ? (
            <div className="text-center py-10" data-testid="activity-empty-warm">
              <p className="text-[13.5px] font-semibold text-ink-950">
                No recent activity to show.
              </p>
              <p className="text-dense text-ink-500 mt-1">
                Edits, comments, approvals and signatures will appear here as your team works.
              </p>
            </div>
          ) : (
            <div className="text-center py-10" data-testid="activity-empty-cold">
              <p className="text-[13.5px] font-semibold text-ink-950">
                No team activity yet.
              </p>
              <p className="text-dense text-ink-500 mt-1">
                Upload a contract or submit a request to get started.
              </p>
            </div>
          )
        ) : (
          <ul className="divide-y divide-paper-200">
            {stats.recentActivity.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => navigate(resourceLink(event.entityType, event.entityId))}
                  className="w-full flex items-start gap-2.5 py-2 text-left hover:bg-paper-50 -mx-2 px-2 rounded-md transition-colors group"
                >
                  {/* Actor avatar */}
                  <div
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border border-paper-200 bg-paper-100 text-[9.5px] font-semibold text-ink-700"
                    aria-hidden
                  >
                    {event.actorInitials}
                  </div>

                  {/* Sentence */}
                  <div className="min-w-0 flex-1">
                    <p className="text-dense leading-[1.5] text-ink-700">
                      <span className="font-medium text-ink-950">{event.actorName}</span>
                      {' '}
                      <span>{event.verb}</span>
                      {' '}
                      <span className="font-medium text-ink-950 underline-offset-2 group-hover:underline decoration-paper-300 truncate">
                        {event.entityTitle}
                      </span>
                    </p>
                    {event.secondary && (
                      <p className="mt-0.5 text-[11px] text-ink-500">{event.secondary}</p>
                    )}
                  </div>

                  {/* Relative time */}
                  <time
                    className="text-[11px] text-ink-400 whitespace-nowrap shrink-0 pt-0.5"
                    dateTime={event.createdAt}
                    title={absoluteTime(event.createdAt)}
                  >
                    {relativeTime(event.createdAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        B.6.6 — Dashboard Quick Actions now open their modals in place,
        matching the Gmail-Compose / Linear-New-Issue pattern. Upload
        success invalidates the dashboard-stats query so the KPI tiles +
        activity feed reflect the new contract without a reload.
      */}
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false)
            queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
            // Sonner toast — gives users immediate feedback that the upload
            // landed and that extraction is now running. Previously the modal
            // just closed silently, leaving the user wondering if anything
            // happened.
            toast.success('Contract uploaded', {
              description: 'Extraction started — facts and clauses will populate in a few seconds.',
            })
          }}
        />
      )}
      {showNewRequest && (
        <NewRequestModal
          onClose={() => {
            setShowNewRequest(false)
            queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
          }}
        />
      )}
    </div>
  )
}

// ─── "Your day" band (B.6.15) ─────────────────────────────────────────────────

interface YourDayBandProps { yourDay: YourDay }

function YourDayBand({ yourDay }: YourDayBandProps) {
  const navigate = useNavigate()

  // All-clear state — reassuring rather than empty. Brand green survives the
  // migration here because "all caught up" is the healthy state, not a
  // decorative success; it is the one all-clear this screen can show.
  if (yourDay.total === 0 && yourDay.draftsInProgress === 0) {
    return (
      <div
        data-testid="your-day-band"
        className="rounded-card border border-brand-200 bg-brand-50 px-5 py-4 flex items-center gap-3"
      >
        <div className="size-8 rounded-full bg-brand-100 flex items-center justify-center">
          <CircleCheckBig className="size-4 text-brand-700" />
        </div>
        <div>
          <p className="text-body font-medium text-brand-700">You're all caught up.</p>
          <p className="text-dense text-ink-700 mt-0.5">
            No approvals, requests, or expiring contracts need your attention today.
          </p>
        </div>
      </div>
    )
  }

  // Each chip carries a MEANING, not a colour, and the colour comes from
  // MEANING_CLASS. "Your day" is one of the few surfaces that genuinely knows
  // the viewer is the blocker — the query behind it is already scoped to this
  // user — so it states `turn` outright instead of asking a status map that is
  // deliberately viewer-neutral (see the header comment in lib/status.ts).
  const chips: Array<{
    key: string
    icon: typeof CheckSquare
    count: number
    label: string
    verb: string
    to: string
    meaning: Meaning
  }> = []

  if (yourDay.approvalsWaiting > 0) chips.push({
    key: 'approvals',
    icon: CheckSquare,
    count: yourDay.approvalsWaiting,
    label: yourDay.approvalsWaiting === 1 ? 'approval' : 'approvals',
    verb: 'waiting on your decision',
    to: '/approvals',
    meaning: 'turn',
  })

  if (yourDay.requestsWaiting > 0) chips.push({
    key: 'requests',
    icon: ClipboardList,
    count: yourDay.requestsWaiting,
    label: yourDay.requestsWaiting === 1 ? 'request' : 'requests',
    verb: 'assigned to you',
    to: '/requests',
    // Assigned to you is your turn, not merely in flight — so turn, not inflight.
    meaning: 'turn',
  })

  if (yourDay.contractsExpiring > 0) chips.push({
    key: 'expiring',
    icon: Clock,
    count: yourDay.contractsExpiring,
    label: yourDay.contractsExpiring === 1 ? 'contract' : 'contracts',
    verb: yourDay.contractsExpiring === 1 ? 'you own expires in 90 days' : 'you own expire in 90 days',
    to: (() => {
      const d = new Date()
      d.setDate(d.getDate() + 90)
      return `/contracts?expiryDateTo=${d.toISOString().slice(0, 10)}&filterLabel=${encodeURIComponent('Your contracts expiring in 90 days')}`
    })(),
    meaning: 'risk',
  })

  // P7.1.1 — F-78 fix: negotiations chip for the Legal persona, whose
  // primary JTBD is "review contracts in flight".
  const negCount = yourDay.negotiationsInFlight ?? 0
  if (negCount > 0) chips.push({
    key: 'negotiations',
    icon: MessageSquareWarning,
    count: negCount,
    label: negCount === 1 ? 'negotiation' : 'negotiations',
    verb: negCount === 1 ? 'in flight you own' : 'in flight you own',
    to: '/contracts?status=UNDER_NEGOTIATION',
    // "In flight you own" is movement, not a block on this user.
    meaning: 'inflight',
  })

  if (yourDay.draftsInProgress > 0) chips.push({
    key: 'drafts',
    icon: FileEdit,
    count: yourDay.draftsInProgress,
    label: yourDay.draftsInProgress === 1 ? 'draft' : 'drafts',
    verb: 'in progress',
    to: '/contracts?status=DRAFT',
    meaning: 'neutral',
  })

  return (
    <div data-testid="your-day-band" className="rounded-card border border-paper-200 bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          {/* The one eyebrow in the product allowed a meaning colour — but only
              when something is actually blocked on the user. */}
          <p className={`text-eyebrow uppercase ${yourDay.total > 0 ? MEANING_CLASS.turn.fg : 'text-ink-500'}`}>
            {yourDay.total > 0 ? 'Your day' : 'In progress'}
          </p>
          <p className="text-dense text-ink-500 mt-1">
            {yourDay.total > 0
              ? `${yourDay.total} item${yourDay.total === 1 ? '' : 's'} need${yourDay.total === 1 ? 's' : ''} your attention.`
              : "Nothing is blocking on you — just your ongoing drafts."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => {
          // One coloured element per chip — the leading dot. The chip body stays
          // paper so a row of five doesn't read as five competing washes.
          const s = MEANING_CLASS[c.meaning]
          return (
            <button
              key={c.key}
              onClick={() => navigate(c.to)}
              data-testid={`your-day-chip-${c.key}`}
              className="inline-flex items-center gap-2 rounded-md border border-paper-200 bg-card px-3 py-2 text-left text-ink-950 transition-colors hover:border-paper-300 hover:bg-paper-50"
            >
              <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
              <c.icon className={`size-3.5 ${s.fg}`} />
              <span className="text-dense">
                <span className="font-semibold tabular-nums">{c.count}</span>{' '}
                <span className="font-medium">{c.label}</span>{' '}
                <span className="text-ink-500">{c.verb}</span>
              </span>
              <ArrowRight className="size-3.5 text-ink-400" />
            </button>
          )
        })}
      </div>

      {/* P7.1.1 — Inline cards. The chips above tell the user "you
          have 1 negotiation"; these cards tell them WHICH ONE so they
          can act in one click. Each row links straight to the contract
          detail. Surface negotiations + renewals (the two persona
          JTBDs that the chips alone don't satisfy). */}
      {((yourDay.negotiations?.length ?? 0) > 0 || (yourDay.renewals?.length ?? 0) > 0) && (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="your-day-cards">
          {(yourDay.negotiations?.length ?? 0) > 0 && (
            <YourDayList
              title="Negotiations in flight"
              icon={MessageSquareWarning}
              meaning="inflight"
              rows={yourDay.negotiations!}
              renderMeta={(r) => {
                // The gate used to be `riskScore > 0.4` against data that
                // arrives 0-100, so it badged every negotiation and printed
                // percentages in the thousands. normalizeRisk absorbs both
                // scales and riskBand decides — the same call the repository
                // and the risk meters make, so the two can't disagree.
                const riskPct = normalizeRisk(r.riskScore)
                const band = riskPct == null ? null : riskBand(riskPct)
                // Only a scored-up contract earns a badge; "low" is the resting
                // state and gets no mark at all.
                const riskMeaning = band && band !== 'low' ? RISK_TO_MEANING[band] : null
                return (
                  <>
                    {r.value && (
                      <span className="font-medium tabular-nums text-ink-950">
                        {(r.currency ?? 'USD')} {r.value.toLocaleString()}
                      </span>
                    )}
                    {riskMeaning && (
                      <span className={cn(
                        'inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] rounded-chip border',
                        MEANING_CLASS[riskMeaning].wash,
                        MEANING_CLASS[riskMeaning].washFg,
                        MEANING_CLASS[riskMeaning].washBorder,
                      )}>
                        <AlertTriangle className="size-2.5" />
                        RISK {riskPct}%
                      </span>
                    )}
                    {typeof r.daysSinceUpdate === 'number' && (
                      <span className="text-ink-500">
                        updated {r.daysSinceUpdate === 0 ? 'today' : `${r.daysSinceUpdate}d ago`}
                      </span>
                    )}
                  </>
                )
              }}
              onClickRow={(r) => navigate(`/contracts/${r.id}`)}
            />
          )}
          {(yourDay.renewals?.length ?? 0) > 0 && (
            <YourDayList
              title="Renewals coming up"
              icon={Repeat}
              meaning="risk"
              rows={yourDay.renewals!}
              renderMeta={(r) => (
                <>
                  {r.value && (
                    <span className="font-medium tabular-nums text-ink-950">
                      {(r.currency ?? 'USD')} {r.value.toLocaleString()}
                    </span>
                  )}
                  {typeof r.daysToExpiry === 'number' && (
                    // Inside 30 days is exposure; inside 60 it is the owner's
                    // turn to act; beyond that it is just a date — so the
                    // thresholds name meanings and MEANING_CLASS colours them.
                    <span className={r.daysToExpiry <= 30 ? `${MEANING_CLASS.risk.fg} font-medium` : r.daysToExpiry <= 60 ? `${MEANING_CLASS.turn.fg} font-medium` : 'text-ink-500'}>
                      {r.daysToExpiry < 0 ? `${-r.daysToExpiry}d overdue` :
                       r.daysToExpiry === 0 ? 'expires today' :
                       `expires in ${r.daysToExpiry}d`}
                    </span>
                  )}
                </>
              )}
              onClickRow={(r) => navigate(`/contracts/${r.id}`)}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── YourDayList — inline contract-row card section (P7.1.1) ────────────────

interface YourDayListProps {
  title: string
  icon: typeof MessageSquareWarning
  meaning: Meaning
  rows: YourDayContractRow[]
  renderMeta: (r: YourDayContractRow) => React.ReactNode
  onClickRow: (r: YourDayContractRow) => void
}

function YourDayList({ title, icon: Icon, meaning, rows, renderMeta, onClickRow }: YourDayListProps) {
  const headerColor = MEANING_CLASS[meaning].fg

  return (
    <div className="rounded-card border border-paper-200 bg-paper-50 overflow-hidden" data-testid={`your-day-list-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="px-3 py-2 border-b border-paper-200 bg-paper-100 flex items-center gap-1.5">
        <Icon className={`size-3.5 ${headerColor}`} />
        <h3 className="text-eyebrow uppercase text-ink-700">{title}</h3>
        <span className="text-[11px] tabular-nums text-ink-400">· {rows.length}</span>
      </div>
      <ul className="divide-y divide-paper-200">
        {rows.map(r => (
          <li
            key={r.id}
            onClick={() => onClickRow(r)}
            className="px-3 py-2 hover:bg-paper-100 cursor-pointer transition-colors"
            data-testid={`your-day-row-${r.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink-950 truncate">{r.title}</div>
                <div className="text-[11.5px] text-ink-500 flex items-center gap-2 mt-0.5 flex-wrap">
                  {r.counterpartyName && (
                    <span className="inline-flex items-center gap-1">
                      <Building2 className="size-3" />
                      {r.counterpartyName}
                    </span>
                  )}
                  {renderMeta(r)}
                </div>
              </div>
              <ArrowRight className="size-3.5 text-ink-400 flex-shrink-0" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
