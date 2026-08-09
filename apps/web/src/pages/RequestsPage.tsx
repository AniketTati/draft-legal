import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NewRequestModal } from '@/components/requests/NewRequestModal'
import { RequestDetailPanel } from '@/components/requests/RequestDetailPanel'
import { StatusPill } from '@/components/ui/status-pill'
import { Chip, CountBadge, EmptyState } from '@/components/ui/primitives'
import { AssistChip } from '@/components/ui/assist'
import { statusMeta } from '@/lib/status'
import { Plus, Search, ClipboardList, Loader2, ChevronRight } from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

/**
 * The tabs a legal-intake queue always wants, in workflow order.
 *
 * These used to be the *only* tabs, which quietly hid records: the seeded
 * queue contains a CANCELLED request, `/requests/counts` returns a CANCELLED
 * bucket, and no tab existed for it — the row was reachable from "All" and
 * nowhere else, and the tab strip implied the six listed statuses were the
 * whole vocabulary. Any status the server reports a count for and this list
 * doesn't name is now appended (see `tabs` below), so the strip can never
 * again be narrower than the data.
 */
const BASE_TABS = [
  { value: '',                 label: 'All' },
  { value: 'SUBMITTED',        label: 'Submitted' },
  { value: 'IN_REVIEW',        label: 'In review' },
  { value: 'MORE_INFO_NEEDED', label: 'Needs info' },
  { value: 'ACCEPTED',         label: 'Accepted' },
  { value: 'COMPLETED',        label: 'Completed' },
  { value: 'REJECTED',         label: 'Rejected' },
]

/** Colour comes from lib/status; the wording stays as this list has spelled it. */
const STATUS_LABEL: Record<string, string> = {
  SUBMITTED:        'Submitted',
  IN_REVIEW:        'In Review',
  ACCEPTED:         'Accepted',
  REJECTED:         'Rejected',
  MORE_INFO_NEEDED: 'More Info',
  COMPLETED:        'Completed',
}

/**
 * Priority, as prose and (almost always) without colour.
 *
 * This was `HIGH` in an amber wash and `URGENT` in a red one, printed as raw
 * database values. Both readings were wrong under the design system's own
 * rules: amber means "blocked on THIS USER", and a request's priority is a
 * property of the request, not of the pair (request, viewer) — HIGH is amber
 * for the requester who is waiting just as much as for the reviewer who owes
 * the work. Red means legal exposure, and "the deal is blocked" is urgency,
 * not exposure.
 *
 * The practical damage was that six of seven seeded rows carried a coloured
 * priority chip AND a coloured status pill, so every row had two colours and
 * the eye had nothing to land on. Priority now reads as ink at three of four
 * levels; URGENT keeps a single dot, because "blocking a deal" is the one
 * level a queue owner genuinely needs to spot from across the list.
 */
const PRIORITY: Record<string, { label: string; cls: string; dot?: string }> = {
  LOW:    { label: 'Low',    cls: 'text-ink-400' },
  MEDIUM: { label: 'Medium', cls: 'text-ink-500' },
  HIGH:   { label: 'High',   cls: 'text-ink-700 font-medium' },
  URGENT: { label: 'Urgent', cls: 'text-attention-700 font-medium', dot: 'bg-attention-600' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeTab, setActiveTab]     = useState('')
  const [search, setSearch]           = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showNew, setShowNew]         = useState(false)
  const [selectedRequest, setSelected] = useState<any>(null)

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const { data, isLoading } = useQuery({
    queryKey: ['requests', activeTab, debouncedSearch],
    queryFn:  () => api.get('/requests', {
      params: {
        status: activeTab || undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
      },
    }).then(r => r.data),
    // Poll every 5s while any request is freshly submitted (AI classification in flight)
    refetchInterval: (q) => {
      const items: any[] = q.state.data?.data ?? []
      return items.some((r: any) => r.status === 'SUBMITTED') ? 5000 : false
    },
  })

  // B.6.16 — per-tab counts so users can see where the work is.
  const { data: countsData } = useQuery({
    queryKey: ['requests-counts'],
    queryFn: () => api.get('/requests/counts').then(r => r.data) as Promise<{ counts: Record<string, number>; total: number }>,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const counts = countsData?.counts ?? {}
  const totalAllTabs = countsData?.total ?? 0

  /** Named tabs, plus any status the server counts that we forgot to name. */
  const tabs = useMemo(() => {
    const named = new Set(BASE_TABS.map(t => t.value))
    const extra = Object.keys(counts)
      .filter(s => !named.has(s) && (counts[s] ?? 0) > 0)
      .sort()
      .map(s => ({ value: s, label: statusMeta(s).label }))
    return [...BASE_TABS, ...extra]
  }, [counts])

  const requests: any[] = data?.data ?? []
  const serverTotal: number | undefined = data?.total
  // The list is capped at 50 and used to say nothing about it, so a queue of
  // 200 silently looked like a queue of 50. The API already reports `hasMore`.
  const truncated = Boolean(data?.hasMore) || requests.length >= PAGE_SIZE

  /*
   * Deep-linkable requests (?request=<id>).
   *
   * Rows opened a panel and changed nothing about the URL, so a reviewer could
   * not send a colleague "look at this one", could not reload without losing
   * their place, and Back closed the whole page rather than the panel. The
   * matter workspace now links here with this param too.
   */
  const focusId = searchParams.get('request')
  const { data: focusedFromUrl } = useQuery({
    queryKey: ['request', focusId],
    enabled: !!focusId && !selectedRequest,
    queryFn: () => api.get(`/requests/${focusId}`).then(r => r.data?.data ?? r.data),
  })
  useEffect(() => {
    if (focusId && !selectedRequest && focusedFromUrl) setSelected(focusedFromUrl)
  }, [focusId, focusedFromUrl, selectedRequest])

  const openRequest = (req: any) => {
    setSelected(req)
    const next = new URLSearchParams(searchParams)
    next.set('request', req.id)
    setSearchParams(next, { replace: true })
  }
  const closeRequest = () => {
    setSelected(null)
    const next = new URLSearchParams(searchParams)
    next.delete('request')
    setSearchParams(next, { replace: true })
  }

  const activeTabLabel = tabs.find(t => t.value === activeTab)?.label

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between px-6 py-4 border-b border-paper-200 bg-card gap-4">
        <div className="min-w-0">
          <h1 className="text-title text-ink-950">Contract Requests</h1>
          {/* B.6.16 — one-sentence explainer so first-time visitors
              understand what a "request" is before they hunt. */}
          <p className="text-dense text-ink-500 mt-1 max-w-xl">
            Ask Legal to draft a contract. Fill out what you need —
            type, counterparty, timeline — and they'll produce the
            first version for you.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowNew(true)}
          data-testid="requests-create-btn"
          className="shrink-0"
        >
          <Plus /> New Request
        </Button>
      </div>

      {/* Tabs — B.6.16 adds inline counts so users see where work is */}
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-paper-200 bg-card overflow-x-auto">
        {tabs.map(tab => {
          // For the "All" tab the count is the sum; otherwise look up
          // the specific status.
          const count = tab.value === '' ? totalAllTabs : counts[tab.value] ?? 0
          const isActive = activeTab === tab.value
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              data-testid={`requests-tab-${tab.value || 'all'}`}
              aria-current={isActive ? 'page' : undefined}
              className={`px-3 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5 whitespace-nowrap ${
                isActive
                  ? 'border-ink-950 text-ink-950'
                  : count === 0
                    // An empty bucket is still worth showing — it says "nothing
                    // is stuck here" — but it should not read as somewhere to go.
                    ? 'border-transparent text-ink-400 hover:text-ink-700'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
              }`}
            >
              <span>{tab.label}</span>
              {count > 0 && (
                <CountBadge tone={isActive ? 'ink' : 'neutral'}>{count}</CountBadge>
              )}
            </button>
          )
        })}
      </div>

      {/* Search */}
      <div className="px-6 py-3 bg-card border-b border-paper-200">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search requests…"
            aria-label="Search requests"
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto bg-paper-50">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 gap-2 text-ink-400 text-dense">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : requests.length === 0 ? (
          <div className="mx-6 my-4">
            {/*
              "No requests found" was shown for all three empty cases, so a
              user who had filtered to an empty tab was told the queue was
              empty. Each case now names its own cause and offers its own way
              out.
            */}
            <EmptyState
              icon={<ClipboardList />}
              title={
                debouncedSearch
                  ? `No requests match “${debouncedSearch}”`
                  : activeTab
                    ? `Nothing is sitting in ${activeTabLabel}`
                    : 'No requests yet'
              }
              description={
                debouncedSearch
                  ? 'Search covers the title, request number and counterparty.'
                  : activeTab
                    ? 'That is a clear queue, not an error.'
                    : 'When someone asks Legal for a contract, it lands here.'
              }
              action={
                debouncedSearch ? (
                  <Button size="sm" variant="outline" onClick={() => setSearch('')}>Clear search</Button>
                ) : activeTab ? (
                  <Button size="sm" variant="outline" onClick={() => setActiveTab('')}>Show all requests</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                    <Plus /> Submit your first request
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
          <div className="divide-y divide-paper-200 bg-card mx-6 my-4 rounded-card border border-paper-200 overflow-hidden">
            {requests.map(req => {
              const pri = PRIORITY[req.priority] ?? PRIORITY.MEDIUM
              const isClassifying = req.status === 'SUBMITTED' && !req.metadata?._aiClassification

              return (
                <button
                  key={req.id}
                  data-testid={`request-row-${req.id}`}
                  data-request-title={req.title}
                  onClick={() => openRequest(req)}
                  className="w-full flex items-center gap-4 px-5 py-2.5 text-left hover:bg-paper-50 transition-colors group focus:outline-none focus-visible:bg-paper-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {/* The leading dot is gone. It was `bg-paper-300` on every
                      row — a mark that carried no meaning, in a system whose
                      first rule is that colour means something. */}

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[13px] font-medium text-ink-950 truncate">{req.title}</p>
                      {isClassifying && (
                        // The machine is mid-work on this row.
                        <AssistChip
                          icon={<Loader2 className="size-2.5 animate-spin" />}
                          className="flex-shrink-0"
                        >
                          Classifying
                        </AssistChip>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {req.requestNumber && (
                        <span className="text-[10px] font-mono text-ink-400">{req.requestNumber}</span>
                      )}
                      {req.counterpartyName && (
                        <span className="text-[11px] text-ink-500">{req.counterpartyName}</span>
                      )}
                      <span className="text-[11px] tabular-nums text-ink-400">
                        {new Date(req.createdAt).toLocaleDateString()}
                      </span>
                      <span className={`text-[11px] inline-flex items-center gap-1 ${pri.cls}`}>
                        {pri.dot && <span className={`size-1.5 rounded-full ${pri.dot}`} aria-hidden />}
                        {pri.label} priority
                      </span>
                    </div>
                  </div>

                  {/* Badges — one colour on the row, and it is the status. */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Chip>{req.type.replace(/_/g, ' ')}</Chip>
                    <StatusPill status={req.status}>{STATUS_LABEL[req.status]}</StatusPill>
                    <ChevronRight className="size-4 text-ink-400 group-hover:text-ink-700 transition-colors" />
                  </div>
                </button>
              )
            })}
          </div>
          {truncated && (
            <p className="mx-6 mb-4 -mt-2 text-[11.5px] text-ink-500" data-testid="requests-truncated-note">
              Showing the {PAGE_SIZE} most recent
              {serverTotal ? ` of ${serverTotal}` : ''}. Narrow it with a status tab or search.
            </p>
          )}
          </>
        )}
      </div>

      {/* Modals */}
      {showNew && <NewRequestModal onClose={() => setShowNew(false)} />}
      {selectedRequest && (
        <RequestDetailPanel
          request={selectedRequest}
          onClose={closeRequest}
        />
      )}
    </div>
  )
}
