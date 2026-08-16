/**
 * MatterDetailPage (P4.2 / docs/30 D.7.2 + D.7.3)
 *
 * Workspace for a single matter — the matter's contracts, intake requests and
 * agent threads, with a header carrying its metadata and status controls.
 *
 * This page was built and reviewed while `matters` had zero rows, so it had
 * only ever been seen as an empty state. With 14 real matters and 80 linked
 * contracts the gaps showed up immediately:
 *
 *   • The Requests tab printed raw enum values — "· MORE_INFO_NEEDED · HIGH".
 *   • A failed fetch rendered "Loading…" forever, because the guard was
 *     `isLoading || !data` and never asked about `error`. A deleted matter was
 *     an infinite spinner.
 *   • Close / Archive / Reopen swallowed their errors: the button spun, the
 *     status didn't change, and nothing said why.
 *   • Counterparty and owner were plain text on a page whose whole job is to
 *     be the hub of a negotiation — both are now links.
 *   • Contract rows showed value and risk but not expiry or counterparty, so
 *     you could not tell two identically-named NDAs apart.
 */
import { useState } from 'react'
import { normalizeRisk, riskBand, RISK_BAND_CLASS } from '@/lib/status'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import { CountBadge, EmptyState } from '@/components/ui/primitives'
import { expiryLabel, relativeTime } from '@/components/contracts/dates'
import {
  Briefcase, FileText, ClipboardList, MessageSquare, ArrowLeft,
  Archive, CheckCircle2, AlertCircle,
} from 'lucide-react'

interface Detail {
  id: string
  name: string
  description: string | null
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED'
  counterpartyId: string | null
  counterpartyName: string | null
  owner: { id: string; name: string; email: string; avatarUrl: string | null } | null
  counterparty: { id: string; name: string; website: string | null } | null
  tags: string[]
  contracts: Array<{
    id: string; title: string; type: string; status: string
    value: number | null; currency: string | null; riskScore: number | null
    counterpartyName: string | null; effectiveDate: string | null; expiryDate: string | null
    updatedAt: string
  }>
  requests: Array<{
    id: string; requestNumber: string | null; title: string; type: string
    status: string; priority: string; counterpartyName: string | null
    createdAt: string
  }>
  threads: Array<{
    id: string; title: string; scopeType: string | null; scopeId: string | null
    userId: string; updatedAt: string
  }>
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

/** Priority as prose. `{r.priority}` rendered the database value, uppercase. */
const PRIORITY_LABEL: Record<string, string> = {
  LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent',
}

function money(value: number | null, currency: string | null): string | null {
  if (value == null) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  // `(c.currency ?? '$') + n.toLocaleString()` printed "USD75,945".
  const ccy = currency ?? 'USD'
  return ccy === 'USD' ? `$${n.toLocaleString()}` : `${ccy} ${n.toLocaleString()}`
}

export function MatterDetailPage() {
  const qc = useQueryClient()
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<'contracts' | 'requests' | 'threads'>('contracts')
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['matter', id],
    enabled: !!id,
    queryFn: async () => (await api.get<Detail>(`/matters/${id}`)).data,
  })

  const onMutationError = (e: unknown) =>
    setActionError((e as Error)?.message ?? 'That change did not save. Try again.')
  const onMutationSuccess = () => {
    setActionError(null)
    qc.invalidateQueries({ queryKey: ['matter', id] })
    qc.invalidateQueries({ queryKey: ['matters'] })
  }

  const close = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'CLOSED' }).then(r => r.data),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  })
  const archive = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'ARCHIVED' }).then(r => r.data),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  })
  const reopen = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'OPEN' }).then(r => r.data),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  })
  const busy = close.isPending || archive.isPending || reopen.isPending

  if (isLoading) {
    return <div className="p-6 text-dense text-muted-foreground">Loading…</div>
  }

  // A matter that 404s, or an API that is down, used to fall into the same
  // branch as "still loading" and spin forever.
  if (error || !data) {
    return (
      <div className="px-6 py-5 max-w-6xl mx-auto" data-testid="matter-detail-error">
        <Link to="/matters" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-ink-950 mb-4">
          <ArrowLeft className="size-3" /> Matters
        </Link>
        <EmptyState
          icon={<AlertCircle />}
          title="This matter could not be loaded"
          description={
            (error as { response?: { status?: number } })?.response?.status === 404
              ? 'It may have been deleted, or it belongs to another organisation.'
              : ((error as Error)?.message ?? 'The request failed.')
          }
          action={<Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>}
        />
      </div>
    )
  }

  return (
    <div className="px-6 py-5 max-w-6xl mx-auto" data-testid="matter-detail-page">
      <Link to="/matters" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-ink-950 mb-3">
        <ArrowLeft className="size-3" /> Matters
      </Link>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h1 className="text-title text-ink-950 flex items-center gap-2 flex-wrap">
            <Briefcase className="size-4 text-ink-400 shrink-0" />
            {data.name}
            <StatusPill status={data.status} />
          </h1>
          <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            {/* Both of these used to be dead text on the one page whose job is
                to be the hub of a negotiation. */}
            {data.counterpartyName && (
              <span>
                Counterparty:{' '}
                {data.counterpartyId ? (
                  <Link
                    to={`/counterparties/${data.counterpartyId}`}
                    className="text-ink-950 font-medium hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    data-testid="matter-counterparty-link"
                  >
                    {data.counterpartyName}
                  </Link>
                ) : (
                  <span className="text-ink-950">{data.counterpartyName}</span>
                )}
              </span>
            )}
            {data.owner && <span>· Owner: <span className="text-ink-950">{data.owner.name}</span></span>}
            {/* User-authored tags, so neutral — indigo is the machine's. */}
            {data.tags.map(t => <span key={t} className="font-mono text-ink-700 bg-paper-100 border border-paper-200 rounded-chip px-1.5">#{t}</span>)}
          </div>
          {data.description && <p className="text-[12px] text-ink-700 mt-2 max-w-3xl">{data.description}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {data.status === 'OPEN' ? (
            <>
              <Button
                variant="outline" size="sm"
                onClick={() => close.mutate()}
                disabled={busy}
                data-testid="matter-close-btn"
                className="gap-1 text-[12px]"
              >
                <CheckCircle2 className="size-3" /> {close.isPending ? 'Closing…' : 'Close'}
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => archive.mutate()}
                disabled={busy}
                data-testid="matter-archive-btn"
                className="gap-1 text-[12px]"
              >
                <Archive className="size-3" /> {archive.isPending ? 'Archiving…' : 'Archive'}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => reopen.mutate()} disabled={busy} data-testid="matter-reopen-btn" className="gap-1 text-[12px]">
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          data-testid="matter-action-error"
          className="mb-3 flex items-start justify-between gap-3 rounded-md border border-risk-200 bg-risk-50 px-3 py-2 text-dense text-risk-900"
        >
          <span className="min-w-0 break-words">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 font-semibold text-risk-700 hover:text-risk-900">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center border-b border-border gap-4 text-[13px] mb-3">
        {[
          { k: 'contracts', label: 'Contracts', icon: FileText,    count: data.contracts.length },
          { k: 'requests',  label: 'Requests',  icon: ClipboardList, count: data.requests.length },
          { k: 'threads',   label: 'Threads',   icon: MessageSquare, count: data.threads.length },
        ].map(t => {
          const Icon = t.icon
          const active = tab === t.k
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k as typeof tab)}
              data-testid={`matter-tab-${t.k}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-1.5 py-2 border-b-2 transition-colors',
                // Selected tab is an action state — ink, not a hue.
                active
                  ? 'text-ink-950 border-ink-950 font-semibold'
                  : 'text-muted-foreground border-transparent hover:text-ink-950',
              )}
            >
              <Icon className="size-3.5" />
              {t.label}
              {/* Was a bare opacity-70 number; the product has a primitive for
                  this and it reads the same here as on the Requests tabs. */}
              <CountBadge tone={active ? 'ink' : 'neutral'}>{t.count}</CountBadge>
            </button>
          )
        })}
      </div>

      {tab === 'contracts' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-contracts-body">
          {data.contracts.length === 0 && <EmptyRow text="No contracts in this matter yet. Open a contract and assign it via the Matter picker in its header." />}
          {data.contracts.map(c => {
            const risk = normalizeRisk(c.riskScore)
            const exp = expiryLabel(c.expiryDate)
            const amount = money(c.value, c.currency)
            return (
              <li key={c.id}>
                <Link to={`/contracts/${c.id}`} className="block px-4 py-2 hover:bg-muted/40 focus:outline-none focus-visible:bg-paper-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-medium text-[12.5px] text-ink-950 truncate">{c.title}</span>
                    <span className="text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground font-mono">{c.type}</span>
                    <StatusPill status={c.status} />
                    <span className="ml-auto text-[10.5px] text-muted-foreground whitespace-nowrap">{relativeTime(c.updatedAt)}</span>
                  </div>
                  {/* Second line: the facts that tell two identically-titled
                      NDAs apart. This row used to carry only value + risk. */}
                  <div className="mt-0.5 flex items-center gap-2.5 flex-wrap text-[11px] text-muted-foreground">
                    {c.counterpartyName && <span>{c.counterpartyName}</span>}
                    {amount && <span className="tabular-nums text-ink-700 font-medium">{amount}</span>}
                    {/*
                      Risk keeps the system's default treatment — a meaning dot
                      beside neutral text — instead of colouring the whole
                      label. With most of the portfolio in the medium band,
                      amber text on every row made amber mean nothing.
                    */}
                    {risk != null && (
                      <span className="inline-flex items-center gap-1 tabular-nums" title={`Risk score ${risk} of 100 — ${riskBand(risk)} band`}>
                        {/* Dot above the low band only — see the same note on
                            the counterparty profile. */}
                        {riskBand(risk) !== 'low' && (
                          <span className={cn('size-1.5 rounded-full', RISK_BAND_CLASS[riskBand(risk)])} aria-hidden />
                        )}
                        risk {risk}
                      </span>
                    )}
                    {exp && (
                      <span className={cn('tabular-nums', exp.tone === 'risk' && 'text-risk-700 font-medium')}>
                        {exp.label}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {tab === 'requests' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-requests-body">
          {data.requests.length === 0 && <EmptyRow text="No intake requests linked to this matter." />}
          {data.requests.map(r => (
            <li key={r.id}>
              {/*
                These rows were inert. RequestsPage now accepts ?request=<id>
                and opens that request's panel, so a matter can hand off to the
                intake queue instead of dead-ending.
              */}
              <Link
                to={`/requests?request=${r.id}`}
                data-testid={`matter-request-${r.id}`}
                className="block px-4 py-2 hover:bg-muted/40 focus:outline-none focus-visible:bg-paper-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-[10.5px] text-muted-foreground">{r.requestNumber ?? r.id.slice(-6)}</span>
                  <span className="font-medium text-[12.5px] text-ink-950 truncate">{r.title}</span>
                  {/* Was `· {r.status} · {r.priority}` — raw database values. */}
                  <StatusPill status={r.status} />
                  <span className="text-[11px] text-muted-foreground">
                    {PRIORITY_LABEL[r.priority] ?? r.priority.toLowerCase()} priority
                  </span>
                  <span className="ml-auto text-[10.5px] text-muted-foreground whitespace-nowrap">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {tab === 'threads' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-threads-body">
          {data.threads.length === 0 && <EmptyRow text="No agent threads linked to this matter yet." />}
          {data.threads.map(t => (
            <li key={t.id} className="px-4 py-2">
              <div className="flex items-baseline gap-2 flex-wrap">
                <MessageSquare className="size-3 text-muted-foreground self-center" />
                <span className="text-[12.5px] text-ink-950 truncate">{t.title}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground whitespace-nowrap">
                  last activity {relativeTime(t.updatedAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <li className="px-4 py-8 text-center text-[12px] text-muted-foreground italic">
      {text}
    </li>
  )
}

function cn(...c: Array<string | null | undefined | false>): string {
  return c.filter(Boolean).join(' ')
}
