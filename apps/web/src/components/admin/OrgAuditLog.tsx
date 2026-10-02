/**
 * OrgAuditLog (X3) — the org's whole audit trail, newest first.
 *
 * Every write in the product lands a hash-chained audit event, but only the
 * AI-settings slice could be read back (AiConfigTab). This lists all of them
 * from GET /admin/audit, pages with its cursor, and re-verifies the chain on
 * request (GET /admin/audit/verify). Admin only, like the endpoint.
 */
import { useState } from 'react'
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query'
import { ScrollText, ShieldCheck, ShieldAlert, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, EmptyState } from '@/components/ui/primitives'

interface AuditEvent {
  id: string
  action: string
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown> | null
  /** Too large to list: fetched from /admin/audit/:id when the row is opened. */
  metadataTruncated?: boolean
  ipAddress: string | null
  createdAt: string
  actor: { id: string; name: string | null; email: string | null } | null
}

interface AuditPage { events: AuditEvent[]; nextCursor: string | null }

interface ChainCheck {
  ok: boolean
  total: number
  verified: number
  truncated: boolean
  firstBreak: { eventId: string; reason: string } | null
}

const PAGE = 50

export function OrgAuditLog() {
  const [action, setAction] = useState('')
  const [resourceType, setResourceType] = useState('')
  const [applied, setApplied] = useState({ action: '', resourceType: '' })
  const [open, setOpen] = useState<string | null>(null)

  // Each page's cursor comes from the page before it, so a refetch re-derives
  // them from fresh data: events landing meanwhile can't push rows out of view.
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['org-audit', applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) })
      if (applied.action) q.set('action', applied.action)
      if (applied.resourceType) q.set('resourceType', applied.resourceType)
      if (pageParam) q.set('cursor', pageParam)
      return api.get<AuditPage>(`/admin/audit?${q}`).then(r => r.data)
    },
    getNextPageParam: last => last.nextCursor,
  })
  const pages = data?.pages
  const events = (pages ?? []).flatMap(p => p.events)

  const verify = useMutation({
    // Shown where it happened; the global error toast stays out (lib/api.ts).
    meta: { errorHandled: true },
    mutationFn: () => api.get<ChainCheck>('/admin/audit/verify').then(r => r.data),
  })

  const apply = () => {
    setApplied({ action: action.trim().toUpperCase(), resourceType: resourceType.trim() })
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <ScrollText className="size-5" />
            Audit Log
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            Every change in this organization, newest first. Entries are hash-chained: verifying finds a stored entry that was altered.
          </p>
        </div>
        <Button variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending} data-testid="audit-verify">
          <ShieldCheck />
          {verify.isPending ? 'Checking…' : 'Verify integrity'}
        </Button>
      </div>

      {verify.data && (
        <Card className="px-4 py-3 text-dense flex items-center gap-2" data-testid="audit-verify-result">
          {verify.data.ok
            ? <><ShieldCheck className="size-4 text-ink-500" /> Chain intact — {verify.data.verified} events checked{verify.data.truncated ? ' (the oldest 200,000)' : ''}.</>
            : <><ShieldAlert className="size-4 text-risk-600" /> <span className="text-risk-700">Chain broken at event {verify.data.firstBreak?.eventId} ({verify.data.firstBreak?.reason}).</span></>}
        </Card>
      )}
      {verify.isError && <p className="text-dense text-risk-700">The check could not run. Try again.</p>}

      <form className="flex items-end gap-2 flex-wrap" onSubmit={e => { e.preventDefault(); apply() }}>
        <label className="text-[11.5px] text-ink-700">
          Action
          <Input value={action} onChange={e => setAction(e.target.value)} placeholder="e.g. CONTRACT_UPDATED" className="w-56 mt-1" />
        </label>
        <label className="text-[11.5px] text-ink-700">
          Resource type
          <Input value={resourceType} onChange={e => setResourceType(e.target.value)} placeholder="e.g. contract" className="w-44 mt-1" />
        </label>
        <Button type="submit" variant="outline">Filter</Button>
      </form>

      {isLoading && <p className="text-dense text-ink-400">Loading…</p>}
      {isError && <p className="text-dense text-risk-700">The audit log could not be loaded.</p>}
      {pages && events.length === 0 && (
        <EmptyState icon={<ScrollText />} title="No matching events" description="Change the filter, or check back after the next change in the organization." />
      )}

      {events.length > 0 && (
        <Card className="divide-y divide-paper-200" data-testid="audit-events">
          {events.map(ev => (
            <div key={ev.id} className="px-4 py-2.5">
              <button type="button" className="w-full flex items-start gap-2 text-left" onClick={() => setOpen(open === ev.id ? null : ev.id)}>
                <ChevronRight className={`size-3.5 mt-0.5 text-ink-400 transition-transform ${open === ev.id ? 'rotate-90' : ''}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[12px] text-ink-950">{ev.action}</span>
                    <span className="text-[11.5px] text-ink-500 truncate">{ev.resourceType} · {ev.resourceId}</span>
                    <span className="text-[10.5px] text-ink-400 tabular-nums ml-auto flex-shrink-0" title={new Date(ev.createdAt).toLocaleString()}>
                      {formatRelativeTime(ev.createdAt)}
                    </span>
                  </div>
                  <div className="text-[10.5px] text-ink-400 mt-0.5 truncate">
                    {ev.actor ? (ev.actor.name ?? ev.actor.email ?? ev.actor.id) : 'system'}
                    {ev.ipAddress && <> · {ev.ipAddress}</>}
                  </div>
                </div>
              </button>
              {open === ev.id && <EventMetadata event={ev} />}
            </div>
          ))}
        </Card>
      )}

      {hasNextPage && (
        <div className="text-center">
          <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** An event's metadata; one too large to list is fetched when opened. */
function EventMetadata({ event }: { event: AuditEvent }) {
  const { data, isLoading } = useQuery({
    queryKey: ['org-audit-event', event.id],
    queryFn: () => api.get<AuditEvent>(`/admin/audit/${event.id}`).then(r => r.data),
    enabled: !!event.metadataTruncated,
  })
  const metadata = event.metadataTruncated ? data?.metadata : event.metadata
  return (
    <pre className="mt-2 ml-5 text-[11px] text-ink-700 bg-paper-50 border border-paper-200 rounded-md p-2.5 overflow-x-auto max-h-96">
      {isLoading ? 'Loading…' : JSON.stringify(metadata ?? {}, null, 2)}
    </pre>
  )
}
