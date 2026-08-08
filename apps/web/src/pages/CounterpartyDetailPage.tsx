/**
 * CounterpartyDetailPage (P7.4.5 / F-49)
 *
 * The audit (F-49) flagged that clicking a counterparty went to a
 * filtered-contracts list with no profile, no activity, no aggregate
 * signal. This page replaces that dead-end with a real CRM-style
 * profile:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← Counterparties / Zynga Holdings                              │
 *   │ ────────────────────────────────────────────────────────────── │
 *   │ 🏢 Zynga Holdings                  [+ New contract] [Edit]    │
 *   │    Zynga Holdings Limited                                       │
 *   │    🌐 zynga.com  ✉ legal@zynga.com  Member since Jan 2024      │
 *   │ ────────────────────────────────────────────────────────────── │
 *   │ ┌──────┬───────┬──────┬──────┐                                  │
 *   │ │ 5    │ $12M  │ 2    │ 1    │ contracts | TCV | active | high │
 *   │ └──────┴───────┴──────┴──────┘                                  │
 *   │ ────────────────────────────────────────────────────────────── │
 *   │ CONTRACTS (5)                                                   │
 *   │ ────────────────────────                                        │
 *   │ • MSA  · $5.2M · UNDER_NEGOTIATION · risk 78%   →               │
 *   │ • SOW#1 · $1.8M · EXECUTED · expires Mar 27     →               │
 *   │ ...                                                             │
 *   │ ────────────────────────────────────────────────────────────── │
 *   │ RECENT ACTIVITY                                                 │
 *   │ • SOW#2 added · 3w ago                                          │
 *   └──────────────────────────────────────────────────────────────┘
 */
import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ArrowLeft, Building2, Globe, Mail, Phone, FileText, Plus,
  TrendingUp, AlertTriangle, Clock, Edit, Loader2, X,
  Briefcase, ExternalLink,
} from 'lucide-react'

interface ContractRow {
  id: string
  title: string
  type: string
  status: string
  value: number | string | null
  currency: string | null
  riskScore: number | null
  effectiveDate: string | null
  expiryDate: string | null
  createdAt: string
  updatedAt: string
  ownerId: string
  owner: { id: string; name: string } | null
  contractNumber: string | null
}

interface CpDetail {
  id: string
  name: string
  legalName: string | null
  email: string | null
  phone: string | null
  address: string | null
  website: string | null
  createdAt: string
  contracts: ContractRow[]
  stats: {
    contractCount: number
    totalValue: number
    currency: string
    activeCount: number
    executedCount: number
    draftCount: number
    highRiskCount: number
    statusBreakdown: Record<string, number>
    firstContractAt: string | null
    lastContractAt: string | null
  }
  recentActivity: Array<{
    kind: string
    when: string
    contractId: string
    contractTitle: string
    label: string
  }>
}

const STATUS_PILL: Record<string, string> = {
  DRAFT:               'bg-blue-50 text-blue-700 border-blue-200',
  PENDING_REVIEW:      'bg-amber-50 text-amber-800 border-amber-200',
  UNDER_NEGOTIATION:   'bg-amber-50 text-amber-800 border-amber-200',
  PENDING_APPROVAL:    'bg-purple-50 text-purple-700 border-purple-200',
  APPROVED:            'bg-purple-50 text-purple-700 border-purple-200',
  PENDING_SIGNATURE:   'bg-indigo-50 text-indigo-700 border-indigo-200',
  EXECUTED:            'bg-emerald-50 text-emerald-700 border-emerald-200',
  PARTIALLY_EXECUTED:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  EXPIRED:             'bg-gray-100 text-gray-600 border-gray-200',
  TERMINATED:          'bg-red-50 text-red-700 border-red-200',
  CANCELLED:           'bg-gray-100 text-gray-600 border-gray-200',
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d < 1)   return 'today'
  if (d === 1) return 'yesterday'
  if (d < 7)   return `${d}d ago`
  if (d < 30)  return `${Math.floor(d / 7)}w ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return new Date(iso).toLocaleDateString()
}

function formatMoney(n: number | string | null | undefined, ccy = 'USD'): string {
  if (n == null) return '—'
  const v = typeof n === 'string' ? Number(n) : n
  if (!isFinite(v)) return '—'
  if (v >= 1_000_000) return `${ccy === 'USD' ? '$' : ccy + ' '}${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `${ccy === 'USD' ? '$' : ccy + ' '}${(v / 1_000).toFixed(0)}K`
  return `${ccy === 'USD' ? '$' : ccy + ' '}${v.toLocaleString()}`
}

export function CounterpartyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)

  const { data, isLoading } = useQuery<CpDetail>({
    queryKey: ['counterparty', id],
    enabled: !!id,
    queryFn: async () => (await api.get<CpDetail>(`/counterparties/${id}`)).data,
  })

  if (isLoading || !data) {
    return (
      <div className="px-6 py-12 max-w-6xl mx-auto text-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" /> Loading counterparty…
      </div>
    )
  }

  const cp = data
  const yearsActive = cp.stats.firstContractAt
    ? Math.max(1, Math.floor((Date.now() - new Date(cp.stats.firstContractAt).getTime()) / (365 * 86_400_000)))
    : 0

  return (
    <div className="px-6 py-5 max-w-6xl mx-auto" data-testid="counterparty-detail-page">
      {/* Breadcrumb */}
      <Link
        to="/counterparties"
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-gray-900 mb-3"
        data-testid="cp-back-link"
      >
        <ArrowLeft className="h-3 w-3" /> Counterparties
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2.5" data-testid="cp-name">
            <span className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-blue-50 border border-blue-100">
              <Building2 className="h-5 w-5 text-blue-600" />
            </span>
            {cp.name}
          </h1>
          {cp.legalName && cp.legalName !== cp.name && (
            <p className="text-[13px] text-muted-foreground mt-1 ml-12" data-testid="cp-legal-name">
              {cp.legalName}
            </p>
          )}

          {/* Contact row */}
          <div className="ml-12 mt-2.5 flex items-center gap-4 flex-wrap text-[12.5px]">
            {cp.website && (
              <a
                href={cp.website.startsWith('http') ? cp.website : `https://${cp.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-gray-700 hover:text-blue-700"
                data-testid="cp-website"
              >
                <Globe className="h-3.5 w-3.5 text-gray-400" />
                {cp.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {cp.email && (
              <a
                href={`mailto:${cp.email}`}
                className="inline-flex items-center gap-1.5 text-gray-700 hover:text-blue-700"
                data-testid="cp-email"
              >
                <Mail className="h-3.5 w-3.5 text-gray-400" />
                {cp.email}
              </a>
            )}
            {cp.phone && (
              <span className="inline-flex items-center gap-1.5 text-gray-700">
                <Phone className="h-3.5 w-3.5 text-gray-400" />
                {cp.phone}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 text-gray-500">
              <Clock className="h-3.5 w-3.5 text-gray-400" />
              Member since {new Date(cp.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
              {yearsActive > 0 && ` · ${yearsActive} ${yearsActive === 1 ? 'yr' : 'yrs'} of business`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            variant="outline" size="sm"
            onClick={() => setEditing(true)}
            data-testid="cp-edit-btn"
            className="gap-1 text-[12px]"
          >
            <Edit className="h-3 w-3" /> Edit
          </Button>
          <Button
            size="sm"
            onClick={() => navigate(`/contracts?new=1&counterpartyId=${cp.id}&counterpartyName=${encodeURIComponent(cp.name)}`)}
            data-testid="cp-new-contract-btn"
            className="gap-1 text-[12px]"
          >
            <Plus className="h-3 w-3" /> New contract
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-3 mb-6" data-testid="cp-stats">
        <StatCard
          label="Contracts"
          value={String(cp.stats.contractCount)}
          icon={FileText}
          tone="default"
        />
        <StatCard
          label={`Total value (${cp.stats.currency})`}
          value={formatMoney(cp.stats.totalValue, cp.stats.currency)}
          icon={TrendingUp}
          tone="default"
        />
        <StatCard
          label="In flight"
          value={String(cp.stats.activeCount)}
          sub={cp.stats.activeCount > 0 ? 'active negotiations' : 'all settled'}
          icon={Clock}
          tone={cp.stats.activeCount > 0 ? 'amber' : 'default'}
        />
        <StatCard
          label="High risk"
          value={String(cp.stats.highRiskCount)}
          sub={cp.stats.highRiskCount > 0 ? 'contracts ≥ 70%' : 'all in playbook'}
          icon={AlertTriangle}
          tone={cp.stats.highRiskCount > 0 ? 'red' : 'default'}
        />
      </div>

      {/* Contracts + Activity — two column on wide, stacked on narrow */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5">
        <section className="border border-border rounded-xl bg-card overflow-hidden" data-testid="cp-contracts">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-gray-50/60">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-600">
              Contracts ({cp.contracts.length})
            </h2>
            {cp.contracts.length > 0 && (
              <Link
                to={`/contracts?counterpartyId=${cp.id}&filterLabel=${encodeURIComponent(cp.name)}`}
                className="text-[11px] text-blue-700 hover:underline"
              >
                View in list →
              </Link>
            )}
          </div>
          {cp.contracts.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Briefcase className="h-7 w-7 text-gray-300 mx-auto mb-2" />
              <p className="text-[12.5px] text-muted-foreground">
                No contracts with {cp.name} yet.
              </p>
              <Button
                size="sm" variant="outline"
                className="mt-3 gap-1 text-[12px]"
                onClick={() => navigate(`/contracts?new=1&counterpartyId=${cp.id}&counterpartyName=${encodeURIComponent(cp.name)}`)}
              >
                <Plus className="h-3 w-3" /> Create first contract
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {cp.contracts.map(c => {
                const v = c.value ? Number(c.value.toString()) : 0
                const pill = STATUS_PILL[c.status] ?? STATUS_PILL.DRAFT
                const expiryDays = c.expiryDate
                  ? Math.floor((new Date(c.expiryDate).getTime() - Date.now()) / 86_400_000)
                  : null
                return (
                  <li key={c.id} data-testid={`cp-contract-${c.id}`}>
                    <Link
                      to={`/contracts/${c.id}`}
                      className="block px-4 py-3 hover:bg-blue-50/40 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <FileText className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                            <span className="font-medium text-[13px] text-gray-900 group-hover:text-blue-700">
                              {c.title}
                            </span>
                            {c.contractNumber && (
                              <span className="font-mono text-[10px] text-gray-400">{c.contractNumber}</span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
                            <span className={`inline-flex items-center text-[9.5px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${pill}`}>
                              {c.status.replace(/_/g, ' ')}
                            </span>
                            <span className="font-mono uppercase text-[9.5px] tracking-wider text-gray-400">{c.type}</span>
                            {v > 0 && (
                              <span className="text-gray-700 font-medium tabular-nums">
                                {formatMoney(v, c.currency ?? 'USD')}
                              </span>
                            )}
                            {c.riskScore != null && c.riskScore >= 0.7 && (
                              <span className="inline-flex items-center gap-0.5 text-red-700">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                risk {Math.round(c.riskScore * 100)}%
                              </span>
                            )}
                            {expiryDays != null && (
                              expiryDays < 0 ? (
                                <span className="text-red-700">expired {-expiryDays}d ago</span>
                              ) : expiryDays <= 90 ? (
                                <span className="text-amber-700">expires in {expiryDays}d</span>
                              ) : (
                                <span className="text-muted-foreground">expires {new Date(c.expiryDate!).toLocaleDateString()}</span>
                              )
                            )}
                            {c.owner && (
                              <span className="text-muted-foreground">· {c.owner.name}</span>
                            )}
                          </div>
                        </div>
                        <span className="text-[10.5px] text-muted-foreground whitespace-nowrap mt-0.5">
                          {relTime(c.updatedAt)}
                        </span>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <aside className="border border-border rounded-xl bg-card overflow-hidden h-fit" data-testid="cp-activity">
          <div className="px-4 py-2.5 border-b border-border bg-gray-50/60">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-600">
              Recent activity
            </h2>
          </div>
          {cp.recentActivity.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
              No activity yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {cp.recentActivity.map((e, i) => (
                <li key={i} className="px-4 py-2.5">
                  <Link
                    to={`/contracts/${e.contractId}`}
                    className="block group"
                  >
                    <p className="text-[12px] text-gray-800 group-hover:text-blue-700 line-clamp-2">
                      {e.label}
                    </p>
                    <p className="text-[10.5px] text-muted-foreground mt-0.5">
                      {relTime(e.when)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {editing && (
        <EditModal
          cp={cp}
          onClose={() => setEditing(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['counterparty', id] })
            qc.invalidateQueries({ queryKey: ['counterparties'] })
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}

function StatCard({
  label, value, sub, icon: Icon, tone,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ComponentType<{ className?: string }>
  tone: 'default' | 'amber' | 'red'
}) {
  const toneCls =
    tone === 'amber' ? 'border-amber-200 bg-amber-50/40' :
    tone === 'red' ? 'border-red-200 bg-red-50/40' :
    'border-border bg-card'
  const iconCls =
    tone === 'amber' ? 'text-amber-600' :
    tone === 'red' ? 'text-red-600' :
    'text-gray-400'
  return (
    <div className={`border rounded-lg px-3.5 py-3 ${toneCls}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
          <p className="text-xl font-semibold text-gray-900 mt-1 tabular-nums">{value}</p>
        </div>
        <Icon className={`h-4 w-4 ${iconCls}`} />
      </div>
      {sub && <p className="text-[10.5px] text-muted-foreground mt-1.5">{sub}</p>}
    </div>
  )
}

function EditModal({
  cp, onClose, onSaved,
}: {
  cp: CpDetail
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: cp.name,
    legalName: cp.legalName ?? '',
    email: cp.email ?? '',
    phone: cp.phone ?? '',
    website: cp.website ?? '',
    address: cp.address ?? '',
  })

  const save = useMutation({
    mutationFn: () => api.patch(`/counterparties/${cp.id}`, {
      name:      form.name,
      // We send empty strings as undefined so we don't accidentally
      // null out a field by leaving it blank.
      legalName: form.legalName || undefined,
      email:     form.email || undefined,
      phone:     form.phone || undefined,
      website:   form.website || undefined,
      address:   form.address || undefined,
    }).then(r => r.data),
    onSuccess: onSaved,
  })

  const set = (f: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [f]: e.target.value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Edit Counterparty</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3.5">
          <Field label="Name *">
            <Input value={form.name} onChange={set('name')} className="h-9 text-sm" />
          </Field>
          <Field label="Legal name">
            <Input value={form.legalName} onChange={set('legalName')} className="h-9 text-sm" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set('email')} className="h-9 text-sm" />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={set('phone')} className="h-9 text-sm" />
            </Field>
          </div>
          <Field label="Website">
            <Input value={form.website} onChange={set('website')} className="h-9 text-sm" />
          </Field>
          <Field label="Address">
            <Input value={form.address} onChange={set('address')} className="h-9 text-sm" />
          </Field>
          {save.isError && (
            <p className="text-xs text-red-500">Failed to save changes.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={!form.name.trim() || save.isPending}
            data-testid="cp-edit-save"
            className="gap-1.5"
          >
            {save.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1.5">{label}</label>
      {children}
    </div>
  )
}
