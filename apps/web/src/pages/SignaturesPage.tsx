/**
 * SignaturesPage — org-wide signature requests admin (Phase 07).
 *
 * Shows every SignatureRequest in the user's org with contract title, signer
 * roster, status, and timing. Filter by status; click a row to jump to the
 * contract detail page where the SignatureStatusRailSection has the full
 * controls (void / copy link).
 *
 * This is a chase queue, so it is built around one question: who are we waiting
 * on, and for how long. The roster used to render as an undifferentiated list
 * of names — the people who had already signed sat beside the people holding
 * the deal up, in the same weight and colour.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { PenSquare, AlertCircle, Loader2, ArrowRight, Search } from 'lucide-react'
import { StatusPill } from '@/components/ui/status-pill'
import { Input } from '@/components/ui/input'
import { CountBadge, EmptyState } from '@/components/ui/primitives'

type SrStatus = 'PENDING' | 'COMPLETED' | 'VOIDED' | 'EXPIRED'

interface ApiSigner {
  id: string
  name: string
  email: string
  role: string | null
  status: 'PENDING' | 'SIGNED' | 'DECLINED'
  signedAt: string | null
  signOrder: number
}
interface ApiSignatureRequest {
  id: string
  status: SrStatus
  signOrder: 'ANY' | 'SEQUENTIAL'
  createdAt: string
  completedAt: string | null
  voidedAt: string | null
  expiresAt: string | null
  signedCount: number
  totalSigners: number
  signers: ApiSigner[]
  contract: { id: string; title: string; type: string; counterpartyName: string | null } | null
}

const STATUS_FILTERS: { key: SrStatus | 'ALL'; label: string }[] = [
  { key: 'ALL',       label: 'All' },
  { key: 'PENDING',   label: 'Awaiting' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'VOIDED',    label: 'Voided' },
  { key: 'EXPIRED',   label: 'Expired' },
]

/**
 * Colour and icon now come from lib/status via <StatusPill/>. Only the wording
 * stays local: this screen has always called a PENDING request "Awaiting", and
 * the shared map's "Pending" would be a copy change.
 *
 * "Partially signed" is NOT a stored status — lib/status maps the key but the
 * API never writes it. A request with some signers in is a PENDING request with
 * signedCount > 0, and that is the shape this page reads. See rowStatus().
 */
const STATUS_LABEL: Record<SrStatus, string> = {
  PENDING:   'Awaiting',
  COMPLETED: 'Completed',
  VOIDED:    'Voided',
  EXPIRED:   'Expired',
}

const DAY_MS = 24 * 60 * 60 * 1000

function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

/**
 * The label the status column shows.
 *
 * A PENDING request with one of two signatures in is materially different from
 * one with none: the counterparty has engaged, and chasing it is a different
 * conversation. The stored enum cannot express that (the API only ever writes
 * PENDING / COMPLETED / VOIDED / EXPIRED), but signedCount can, so the page
 * derives the wording rather than inventing a status the backend never sets.
 * The meaning stays `inflight` either way — nothing has bound yet.
 */
function rowStatus(sr: ApiSignatureRequest): string {
  if (sr.status === 'PENDING' && sr.signedCount > 0 && sr.signedCount < sr.totalSigners) {
    return 'Partly signed'
  }
  return STATUS_LABEL[sr.status]
}

/**
 * Who the request is actually waiting on.
 *
 * Sequential requests are blocked on exactly one person — the lowest-order
 * signer still outstanding — and naming the rest is noise that hides them.
 * Parallel ("ANY") requests are blocked on everyone outstanding at once.
 */
function outstanding(sr: ApiSignatureRequest): ApiSigner[] {
  const pending = sr.signers
    .filter(s => s.status === 'PENDING')
    .sort((a, b) => a.signOrder - b.signOrder)
  if (sr.signOrder === 'SEQUENTIAL') return pending.slice(0, 1)
  return pending
}

function declined(sr: ApiSignatureRequest): ApiSigner[] {
  return sr.signers.filter(s => s.status === 'DECLINED')
}

/** Days until the request lapses; negative once it has. */
function expiryDays(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.round((t - Date.now()) / DAY_MS)
}

export function SignaturesPage() {
  const [filter, setFilter] = useState<SrStatus | 'ALL'>('ALL')
  const [q, setQ] = useState('')
  const myEmail = useAuthStore(s => s.user?.email)?.toLowerCase()

  const { data, isLoading, isError } = useQuery<{ data: ApiSignatureRequest[]; total: number }>({
    queryKey: ['signatures', filter],
    queryFn: () => api.get(`/signature-requests${filter !== 'ALL' ? `?status=${filter}` : ''}`).then(r => r.data),
    refetchInterval: 30_000,
  })

  // L6 #12 — badge counts must come from an UNFILTERED query. They used to be
  // reduced over `items`, which is the CURRENT tab's response, so selecting any
  // tab zeroed every other badge; and the ALL badge was `items.length`, the
  // page length, while the query's own `total` was never read. Cached under its
  // own key, so switching tabs does not refetch it.
  const { data: allData } = useQuery<{ data: ApiSignatureRequest[]; total: number }>({
    queryKey: ['signatures', 'ALL'],
    queryFn: () => api.get('/signature-requests').then(r => r.data),
    refetchInterval: 30_000,
  })
  const allItems = allData?.data ?? []
  const counts = allItems.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1
    return acc
  }, {})
  const totalAll = allData?.total ?? allItems.length

  const rows = data?.data ?? []

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(sr =>
      (sr.contract?.title ?? '').toLowerCase().includes(needle) ||
      (sr.contract?.counterpartyName ?? '').toLowerCase().includes(needle) ||
      sr.signers.some(s =>
        s.name.toLowerCase().includes(needle) || s.email.toLowerCase().includes(needle),
      ),
    )
  }, [rows, q])

  // "Which of these are on me?" is the question the sidebar badge answers and
  // this page never did — a signer can only act on the requests where they are
  // the one outstanding.
  const mineCount = useMemo(
    () => (myEmail
      ? allItems.filter(sr =>
          sr.status === 'PENDING' && outstanding(sr).some(s => s.email.toLowerCase() === myEmail),
        ).length
      : 0),
    [allItems, myEmail],
  )

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto" data-testid="signatures-page">
      <div className="flex items-center gap-2 mb-1">
        <PenSquare className="size-4 text-ink-400" />
        <h1 className="text-title text-ink-950">Signatures</h1>
      </div>
      <p className="text-body text-ink-500 mb-5">
        Every contract sent for signature across your organization.
        {mineCount > 0 && (
          <>
            {' '}
            <span className="font-medium text-attention-700">
              {mineCount} {mineCount === 1 ? 'is' : 'are'} waiting on your signature.
            </span>
          </>
        )}
      </p>

      {/* Filter tabs — the selected tab is a selection, so it is ink, not brand. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-paper-200">
        <div className="flex items-center gap-0.5 shrink-0 overflow-x-auto">
          {STATUS_FILTERS.map(f => {
            const isActive = filter === f.key
            const count = f.key === 'ALL' ? totalAll : counts[f.key] ?? 0
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                data-testid={`filter-${f.key.toLowerCase()}`}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-ink-950 text-ink-950 font-medium'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
                }`}
              >
                {f.label}
                {count > 0 && (
                  <CountBadge tone={isActive ? 'ink' : 'neutral'}>{count}</CountBadge>
                )}
              </button>
            )
          })}
        </div>
        <div className="relative min-w-0 pb-2 sm:pb-1.5">
          <Search className="absolute left-2.5 top-2 size-4 text-ink-400" />
          <Input
            type="search"
            placeholder="Search contract or signer"
            value={q}
            onChange={e => setQ(e.target.value)}
            data-testid="signatures-search"
            className="pl-8 w-full sm:w-56"
          />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-body text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Failed to load signature requests.
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<PenSquare />}
          title={
            q
              ? `No signature requests match "${q}".`
              : filter === 'ALL' ? 'No signature requests yet.' : `No ${filter.toLowerCase()} signature requests.`
          }
          description={<>Open any contract and click <strong>Send for Signature</strong> to get started.</>}
        />
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          {/* The card clipped its own table: five columns needed ~870px inside a
              730px shell, so "Sent" and the Open link were silently cut off with
              no way to scroll to them. Fixed layout keeps every column reachable
              at any width; the scroller is the belt to that braces. */}
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-[13px]" data-testid="signatures-table">
              <thead className="bg-paper-50 text-eyebrow uppercase text-ink-500">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Contract</th>
                  <th className="text-left px-4 py-2 font-semibold w-[32%]">Waiting on</th>
                  <th className="text-left px-3 py-2 font-semibold w-[132px]">Status</th>
                  <th className="text-left px-3 py-2 font-semibold w-[104px]">Sent</th>
                  <th className="text-right px-4 py-2 font-semibold w-[74px]">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-200">
                {items.map(it => {
                  // Only a live request is waiting on anybody. A voided or
                  // expired one still has PENDING signers on it, and naming them
                  // would tell a chaser to go chase a dead request.
                  const waitingOn = it.status === 'PENDING' ? outstanding(it) : []
                  const declinedBy = declined(it)
                  const isMine = !!myEmail && waitingOn.some(s => s.email.toLowerCase() === myEmail)
                  const expIn = it.status === 'PENDING' ? expiryDays(it.expiresAt) : null
                  return (
                    <tr key={it.id} className="hover:bg-paper-50 align-top" data-testid={`signature-row-${it.id}`}>
                      <td className="px-5 py-2.5">
                        <Link
                          to={`/contracts/${it.contract?.id ?? ''}`}
                          className="font-medium text-ink-950 truncate block hover:underline underline-offset-2 decoration-paper-300"
                          title={it.contract?.title}
                        >
                          {it.contract?.title ?? '(deleted contract)'}
                        </Link>
                        <div className="text-[11px] text-ink-500 mt-0.5 truncate">
                          <span className="uppercase tracking-[0.08em]">{it.contract?.type?.replace(/_/g, ' ') ?? ''}</span>
                          {it.contract?.counterpartyName && <span> · {it.contract.counterpartyName}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-[11.5px] text-ink-700">
                          {/* Progress first: "1 / 2" is the fact a chaser needs
                              before any name. */}
                          <div className="font-medium tabular-nums">
                            {it.signedCount} / {it.totalSigners} signed
                            {it.signOrder === 'SEQUENTIAL' && it.totalSigners > 1 && (
                              <span className="font-normal text-ink-400"> · in order</span>
                            )}
                          </div>
                          {declinedBy.length > 0 && (
                            // A decline is the one thing on this row that kills
                            // the deal, so it outranks everything else.
                            <div className="text-risk-700 font-medium mt-0.5 truncate">
                              Declined by {declinedBy.map(s => s.name).join(', ')}
                            </div>
                          )}
                          {waitingOn.length > 0 ? (
                            <div className="text-ink-500 mt-0.5 truncate" title={waitingOn.map(s => `${s.name} <${s.email}>`).join(', ')}>
                              {isMine ? (
                                <span className="font-semibold text-attention-700">You</span>
                              ) : (
                                waitingOn[0].name
                              )}
                              {waitingOn.length > 1 && ` +${waitingOn.length - 1} more`}
                              {waitingOn[0].role && waitingOn.length === 1 && (
                                <span className="text-ink-400"> · {waitingOn[0].role}</span>
                              )}
                            </div>
                          ) : (
                            it.status === 'PENDING' && (
                              <div className="text-ink-400 mt-0.5 italic">no one outstanding</div>
                            )
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusPill status={it.status} className="whitespace-nowrap">{rowStatus(it)}</StatusPill>
                        {expIn != null && expIn <= 7 && (
                          // A signature request that lapses has to be re-sent and
                          // re-countersigned; a week out that is real exposure.
                          <div className="text-[10.5px] text-risk-700 font-medium mt-1 tabular-nums">
                            {expIn < 0 ? `lapsed ${-expIn}d ago` : expIn === 0 ? 'lapses today' : `lapses in ${expIn}d`}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[11.5px] text-ink-500 tabular-nums">
                        {relTime(it.createdAt)}
                        {it.completedAt && (
                          // Fully executed — the one binding fact in this row.
                          <div className="text-brand-700 mt-0.5">
                            done {relTime(it.completedAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {it.contract?.id && (
                          <Link
                            to={`/contracts/${it.contract.id}`}
                            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-950 hover:text-ink-700"
                          >
                            Open
                            <ArrowRight className="size-3.5" />
                          </Link>
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
    </div>
  )
}
