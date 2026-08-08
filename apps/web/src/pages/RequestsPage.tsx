import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NewRequestModal } from '@/components/requests/NewRequestModal'
import { RequestDetailPanel } from '@/components/requests/RequestDetailPanel'
import { StatusPill } from '@/components/ui/status-pill'
import { Chip, CountBadge, EmptyState } from '@/components/ui/primitives'
import { AssistChip } from '@/components/ui/assist'
import { Plus, Search, ClipboardList, Loader2, ChevronRight } from 'lucide-react'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { value: '',                label: 'All' },
  { value: 'SUBMITTED',       label: 'Submitted' },
  { value: 'IN_REVIEW',       label: 'In Review' },
  { value: 'MORE_INFO_NEEDED',label: 'More Info' },
  { value: 'ACCEPTED',        label: 'Accepted' },
  { value: 'REJECTED',        label: 'Rejected' },
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

// Priority is urgency: high is the assignee's turn, urgent is exposure.
const PRIORITY_CLS: Record<string, string> = {
  LOW:    'bg-paper-100 text-ink-500',
  MEDIUM: 'bg-paper-100 text-ink-700',
  HIGH:   'bg-attention-100 text-attention-700',
  URGENT: 'bg-risk-100 text-risk-700',
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RequestsPage() {
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
        limit: 50,
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

  const requests: any[] = data?.data ?? []

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
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-paper-200 bg-card">
        {STATUS_TABS.map(tab => {
          // For the "All" tab the count is the sum; otherwise look up
          // the specific status.
          const count = tab.value === '' ? totalAllTabs : counts[tab.value] ?? 0
          const isActive = activeTab === tab.value
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              data-testid={`requests-tab-${tab.value || 'all'}`}
              className={`px-3 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px inline-flex items-center gap-1.5 ${
                isActive
                  ? 'border-ink-950 text-ink-950'
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
            <EmptyState
              icon={<ClipboardList />}
              title={debouncedSearch ? 'No requests match your search' : 'No requests found'}
              action={!activeTab && !debouncedSearch ? (
                <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                  <Plus /> Submit your first request
                </Button>
              ) : undefined}
            />
          </div>
        ) : (
          <div className="divide-y divide-paper-200 bg-card mx-6 my-4 rounded-card border border-paper-200 overflow-hidden">
            {requests.map(req => {
              const priCls  = PRIORITY_CLS[req.priority] ?? PRIORITY_CLS.MEDIUM
              const isClassifying = req.status === 'SUBMITTED' && !req.metadata?._aiClassification

              return (
                <button
                  key={req.id}
                  data-testid={`request-row-${req.id}`}
                  data-request-title={req.title}
                  onClick={() => setSelected(req)}
                  className="w-full flex items-center gap-4 px-5 py-2.5 text-left hover:bg-paper-50 transition-colors group"
                >
                  {/* Row marker. It used to be tinted by contract type; type is a
                      fact about the document and carries no meaning colour here. */}
                  <div className="size-1.5 rounded-full flex-shrink-0 bg-paper-300" />

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
                    </div>
                  </div>

                  {/* Badges */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Chip>{req.type.replace(/_/g, ' ')}</Chip>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${priCls}`}>
                      {req.priority}
                    </span>
                    <StatusPill status={req.status}>{STATUS_LABEL[req.status]}</StatusPill>
                    <ChevronRight className="size-4 text-ink-400 group-hover:text-ink-700 transition-colors" />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {showNew && <NewRequestModal onClose={() => setShowNew(false)} />}
      {selectedRequest && (
        <RequestDetailPanel
          request={selectedRequest}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
