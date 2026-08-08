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
import { PenSquare, CheckCircle2, Clock, XCircle, Ban, AlertCircle, Loader2, ArrowRight } from 'lucide-react'

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

const STATUS_PILL: Record<SrStatus, { bg: string; fg: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  PENDING:   { bg: 'bg-amber-50 border-amber-200',   fg: 'text-amber-700',   icon: Clock,         label: 'Awaiting' },
  COMPLETED: { bg: 'bg-emerald-50 border-emerald-200', fg: 'text-emerald-700', icon: CheckCircle2, label: 'Completed' },
  VOIDED:    { bg: 'bg-gray-100 border-gray-200',     fg: 'text-gray-600',    icon: Ban,           label: 'Voided' },
  EXPIRED:   { bg: 'bg-red-50 border-red-200',        fg: 'text-red-700',     icon: XCircle,       label: 'Expired' },
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
      <div className="flex items-center gap-3 mb-1">
        <PenSquare className="h-5 w-5 text-emerald-600" />
        <h1 className="text-2xl font-semibold text-gray-900">Signatures</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Every contract sent for signature across your organization.
      </p>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
        {STATUS_FILTERS.map(f => {
          const isActive = filter === f.key
          const count = f.key === 'ALL' ? totalAll : counts[f.key] ?? 0
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              data-testid={`filter-${f.key.toLowerCase()}`}
              className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-emerald-600 text-emerald-700 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {f.label}
              {count > 0 && (
                <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${
                  isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          Failed to load signature requests.
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 px-6 border border-dashed border-gray-200 rounded-xl">
          <PenSquare className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500 mb-1">
            {filter === 'ALL' ? 'No signature requests yet.' : `No ${filter.toLowerCase()} signature requests.`}
          </p>
          <p className="text-xs text-gray-400">
            Open any contract and click <strong>Send for Signature</strong> to get started.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm" data-testid="signatures-table">
            <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Contract</th>
                <th className="text-left px-5 py-3 font-medium">Signers</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Sent</th>
                <th className="text-right px-5 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(it => {
                const pill = STATUS_PILL[it.status]
                const StatusIcon = pill.icon
                return (
                  <tr key={it.id} className="hover:bg-gray-50" data-testid={`signature-row-${it.id}`}>
                    <td className="px-5 py-3">
                      <Link
                        to={`/contracts/${it.contract?.id ?? ''}`}
                        className="font-medium text-gray-900 hover:text-blue-600 truncate block max-w-xs"
                        title={it.contract?.title}
                      >
                        {it.contract?.title ?? '(deleted contract)'}
                      </Link>
                      <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                        <span className="uppercase tracking-wide">{it.contract?.type?.replace(/_/g, ' ') ?? ''}</span>
                        {it.contract?.counterpartyName && <span>· {it.contract.counterpartyName}</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-xs text-gray-700">
                        <div className="font-medium">{it.signedCount} / {it.totalSigners} signed</div>
                        <div className="text-gray-500 mt-0.5 truncate max-w-[180px]">
                          {it.signers.slice(0, 3).map(s => s.name).join(', ')}
                          {it.signers.length > 3 && ` +${it.signers.length - 3}`}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${pill.bg} ${pill.fg}`}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {pill.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {relTime(it.createdAt)}
                      {it.completedAt && (
                        <div className="text-emerald-600 mt-0.5">
                          done {relTime(it.completedAt)}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {it.contract?.id && (
                        <Link
                          to={`/contracts/${it.contract.id}`}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Open
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
