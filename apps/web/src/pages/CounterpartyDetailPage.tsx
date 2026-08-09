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
import { EmptyState } from '@/components/ui/primitives'
import { StatusPill } from '@/components/ui/status-pill'
import { normalizeRisk, riskBand } from '@/lib/status'
import type { Meaning } from '@/lib/status'
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

/*
 * The local STATUS_PILL map is gone: statuses resolve through lib/status so a
 * contract row here reads the same as the same contract in the repository.
 * (Its PARTIALLY_EXECUTED / CANCELLED keys were dead — no enum emits them —
 * and statusMeta() humanises anything it hasn't seen anyway.)
 */

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
      <div className="px-6 py-12 max-w-6xl mx-auto text-center text-dense text-muted-foreground">
        <Loader2 className="size-4 animate-spin inline-block mr-2" /> Loading counterparty…
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
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-ink-950 mb-3"
        data-testid="cp-back-link"
      >
        <ArrowLeft className="size-3" /> Counterparties
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-title text-ink-950 flex items-center gap-2.5" data-testid="cp-name">
            <span className="inline-flex items-center justify-center size-9 rounded-card bg-paper-100 border border-paper-200">
              <Building2 className="size-4 text-ink-500" />
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
                className="inline-flex items-center gap-1.5 text-ink-700 hover:text-brand-700"
                data-testid="cp-website"
              >
                <Globe className="size-3.5 text-ink-400" />
                {cp.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                <ExternalLink className="size-2.5" />
              </a>
            )}
            {cp.email && (
              <a
                href={`mailto:${cp.email}`}
                className="inline-flex items-center gap-1.5 text-ink-700 hover:text-brand-700"
                data-testid="cp-email"
              >
                <Mail className="size-3.5 text-ink-400" />
                {cp.email}
              </a>
            )}
            {cp.phone && (
              <span className="inline-flex items-center gap-1.5 text-ink-700">
                <Phone className="size-3.5 text-ink-400" />
                {cp.phone}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 text-ink-500">
              <Clock className="size-3.5 text-ink-400" />
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
          tone="neutral"
        />
        <StatCard
          label={`Total value (${cp.stats.currency})`}
          value={formatMoney(cp.stats.totalValue, cp.stats.currency)}
          icon={TrendingUp}
          tone="neutral"
        />
        <StatCard
          label="In flight"
          value={String(cp.stats.activeCount)}
          sub={cp.stats.activeCount > 0 ? 'active negotiations' : 'all settled'}
          icon={Clock}
          // Live negotiations are moving but not on this user's desk — that is
          // "in flight", which is info, not the amber that means your turn.
          tone={cp.stats.activeCount > 0 ? 'inflight' : 'neutral'}
        />
        <StatCard
          label="High risk"
          value={String(cp.stats.highRiskCount)}
          sub={cp.stats.highRiskCount > 0 ? 'contracts ≥ 70%' : 'all in playbook'}
          icon={AlertTriangle}
          tone={cp.stats.highRiskCount > 0 ? 'risk' : 'neutral'}
        />
      </div>

      {/* Contracts + Activity — two column on wide, stacked on narrow */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5">
        <section className="border border-border rounded-card bg-card overflow-hidden" data-testid="cp-contracts">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-paper-50">
            <h2 className="text-eyebrow uppercase text-ink-700">
              Contracts ({cp.contracts.length})
            </h2>
            {cp.contracts.length > 0 && (
              <Link
                to={`/contracts?counterpartyId=${cp.id}&filterLabel=${encodeURIComponent(cp.name)}`}
                className="text-[11px] font-medium text-ink-950 hover:text-brand-700 hover:underline"
              >
                View in list →
              </Link>
            )}
          </div>
          {cp.contracts.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Briefcase />}
                title={`No contracts with ${cp.name} yet.`}
                action={
                  <Button
                    size="sm" variant="outline"
                    className="gap-1 text-[12px]"
                    onClick={() => navigate(`/contracts?new=1&counterpartyId=${cp.id}&counterpartyName=${encodeURIComponent(cp.name)}`)}
                  >
                    <Plus className="size-3" /> Create first contract
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {cp.contracts.map(c => {
                const v = c.value ? Number(c.value.toString()) : 0
                const expiryDays = c.expiryDate
                  ? Math.floor((new Date(c.expiryDate).getTime() - Date.now()) / 86_400_000)
                  : null
                return (
                  <li key={c.id} data-testid={`cp-contract-${c.id}`}>
                    <Link
                      to={`/contracts/${c.id}`}
                      className="block px-4 py-2 hover:bg-paper-50 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <FileText className="size-3.5 text-ink-400 flex-shrink-0" />
                            <span className="font-medium text-[13px] text-ink-950 group-hover:text-brand-700">
                              {c.title}
                            </span>
                            {c.contractNumber && (
                              <span className="font-mono text-[10px] text-ink-400">{c.contractNumber}</span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
                            <StatusPill status={c.status} />
                            <span className="font-mono uppercase text-[9.5px] tracking-[0.09em] text-ink-400">{c.type}</span>
                            {v > 0 && (
                              <span className="text-ink-700 font-medium tabular-nums">
                                {formatMoney(v, c.currency ?? 'USD')}
                              </span>
                            )}
                            {c.riskScore != null && riskBand(normalizeRisk(c.riskScore)!) === 'high' && (
                              <span className="inline-flex items-center gap-0.5 text-risk-700">
                                <AlertTriangle className="size-2.5" />
                                risk {normalizeRisk(c.riskScore)}
                              </span>
                            )}
                            {expiryDays != null && (
                              expiryDays < 0 ? (
                                // Already expired: exposure. Still inside the
                                // 90-day window: the user's turn to renew.
                                <span className="text-risk-700">expired {-expiryDays}d ago</span>
                              ) : expiryDays <= 90 ? (
                                <span className="text-attention-700">expires in {expiryDays}d</span>
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

        <aside className="border border-border rounded-card bg-card overflow-hidden h-fit" data-testid="cp-activity">
          <div className="px-4 py-2.5 border-b border-border bg-paper-50">
            <h2 className="text-eyebrow uppercase text-ink-700">
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
                    <p className="text-[12px] text-ink-950 group-hover:text-brand-700 line-clamp-2">
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
  tone: Extract<Meaning, 'neutral' | 'inflight' | 'risk'>
}) {
  const toneCls =
    tone === 'inflight' ? 'border-info-200 bg-info-50' :
    tone === 'risk' ? 'border-risk-200 bg-risk-50' :
    'border-border bg-card'
  const iconCls =
    tone === 'inflight' ? 'text-info-600' :
    tone === 'risk' ? 'text-risk-600' :
    'text-ink-400'
  return (
    <div className={`border rounded-card px-3.5 py-3 ${toneCls}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">{label}</p>
          <p className="text-[20px] font-semibold tracking-[-0.015em] text-ink-950 mt-1 tabular-nums">{value}</p>
        </div>
        <Icon className={`size-4 ${iconCls}`} />
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm">
      <div className="bg-card rounded-card shadow-e3 w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950">Edit Counterparty</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-paper-100 rounded-md">
            <X className="size-4 text-ink-500" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3.5">
          <Field label="Name *">
            <Input value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Legal name">
            <Input value={form.legalName} onChange={set('legalName')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={set('phone')} />
            </Field>
          </div>
          <Field label="Website">
            <Input value={form.website} onChange={set('website')} />
          </Field>
          <Field label="Address">
            <Input value={form.address} onChange={set('address')} />
          </Field>
          {save.isError && (
            <p className="text-[11.5px] text-risk-700">Failed to save changes.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-paper-200">
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
      <label className="block text-[11px] font-medium text-ink-700 mb-1.5">{label}</label>
      {children}
    </div>
  )
}
