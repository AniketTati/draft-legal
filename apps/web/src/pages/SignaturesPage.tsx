/**
 * SignaturesPage — org-wide signature requests admin (Phase 07).
 *
 * Replaces the previous "Coming Soon" stub. Shows every SignatureRequest
 * in the user's org with contract title, signer roster, status, and timing.
 * Filter by status; click a row to jump to the contract detail page where
 * the SignatureStatusRailSection has the full controls (void / copy link).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PenSquare, AlertCircle, Loader2, ArrowRight } from 'lucide-react'
import { StatusPill } from '@/components/ui/status-pill'
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
 */
const STATUS_LABEL: Record<SrStatus, string> = {
  PENDING:   'Awaiting',
  COMPLETED: 'Completed',
  VOIDED:    'Voided',
  EXPIRED:   'Expired',
}

function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

export function SignaturesPage() {
  const [filter, setFilter] = useState<SrStatus | 'ALL'>('ALL')

  const { data, isLoading, isError } = useQuery<{ data: ApiSignatureRequest[]; total: number }>({
    queryKey: ['signatures', filter],
    queryFn: () => api.get(`/signature-requests${filter !== 'ALL' ? `?status=${filter}` : ''}`).then(r => r.data),
    refetchInterval: 30_000,
  })

  const items = data?.data ?? []

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

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto" data-testid="signatures-page">
      <div className="flex items-center gap-2 mb-1">
        <PenSquare className="size-4 text-ink-400" />
        <h1 className="text-title text-ink-950">Signatures</h1>
      </div>
      <p className="text-body text-ink-500 mb-5">
        Every contract sent for signature across your organization.
      </p>

      {/* Filter tabs — the selected tab is a selection, so it is ink, not brand. */}
      <div className="flex items-center gap-1 mb-5 border-b border-paper-200">
        {STATUS_FILTERS.map(f => {
          const isActive = filter === f.key
          const count = f.key === 'ALL' ? totalAll : counts[f.key] ?? 0
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              data-testid={`filter-${f.key.toLowerCase()}`}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-[13px] border-b-2 -mb-px transition-colors ${
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
          title={filter === 'ALL' ? 'No signature requests yet.' : `No ${filter.toLowerCase()} signature requests.`}
          description={<>Open any contract and click <strong>Send for Signature</strong> to get started.</>}
        />
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <table className="w-full text-[13px]" data-testid="signatures-table">
            <thead className="bg-paper-50 text-eyebrow uppercase text-ink-500">
              <tr>
                <th className="text-left px-5 py-2 font-semibold">Contract</th>
                <th className="text-left px-5 py-2 font-semibold">Signers</th>
                <th className="text-left px-5 py-2 font-semibold">Status</th>
                <th className="text-left px-5 py-2 font-semibold">Sent</th>
                <th className="text-right px-5 py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {items.map(it => (
                <tr key={it.id} className="hover:bg-paper-50" data-testid={`signature-row-${it.id}`}>
                  <td className="px-5 py-2">
                    <Link
                      to={`/contracts/${it.contract?.id ?? ''}`}
                      className="font-medium text-ink-950 truncate block max-w-xs hover:underline underline-offset-2 decoration-paper-300"
                      title={it.contract?.title}
                    >
                      {it.contract?.title ?? '(deleted contract)'}
                    </Link>
                    <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1.5">
                      <span className="uppercase tracking-[0.08em]">{it.contract?.type?.replace(/_/g, ' ') ?? ''}</span>
                      {it.contract?.counterpartyName && <span>· {it.contract.counterpartyName}</span>}
                    </div>
                  </td>
                  <td className="px-5 py-2">
                    <div className="text-[11.5px] text-ink-700">
                      <div className="font-medium tabular-nums">{it.signedCount} / {it.totalSigners} signed</div>
                      <div className="text-ink-500 mt-0.5 truncate max-w-[180px]">
                        {it.signers.slice(0, 3).map(s => s.name).join(', ')}
                        {it.signers.length > 3 && ` +${it.signers.length - 3}`}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-2">
                    <StatusPill status={it.status}>{STATUS_LABEL[it.status]}</StatusPill>
                  </td>
                  <td className="px-5 py-2 text-[11.5px] text-ink-500">
                    {relTime(it.createdAt)}
                    {it.completedAt && (
                      // Fully executed — the one binding fact in this row.
                      <div className="text-brand-700 mt-0.5">
                        done {relTime(it.completedAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-2 text-right">
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
