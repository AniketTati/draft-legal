/**
 * MatterDetailPage (P4.2 / docs/30 D.7.2 + D.7.3)
 *
 * Workspace for a single matter — sidebar list of the matter's
 * contracts + requests + threads, with a title header showing
 * metadata + status toggle.
 */
import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import {
  Briefcase, FileText, ClipboardList, MessageSquare, ArrowLeft,
  Archive, CheckCircle2,
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

export function MatterDetailPage() {
  const qc = useQueryClient()
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<'contracts' | 'requests' | 'threads'>('contracts')

  const { data, isLoading } = useQuery({
    queryKey: ['matter', id],
    enabled: !!id,
    queryFn: async () => (await api.get<Detail>(`/matters/${id}`)).data,
  })

  const close = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'CLOSED' }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matter', id] }),
  })
  const archive = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'ARCHIVED' }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matter', id] }),
  })
  const reopen = useMutation({
    mutationFn: () => api.patch(`/matters/${id}`, { status: 'OPEN' }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matter', id] }),
  })

  if (isLoading || !data) {
    return <div className="p-6 text-dense text-muted-foreground">Loading…</div>
  }

  return (
    <div className="px-6 py-5 max-w-6xl mx-auto" data-testid="matter-detail-page">
      <Link to="/matters" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-ink-950 mb-3">
        <ArrowLeft className="size-3" /> Matters
      </Link>
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0">
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <Briefcase className="size-4 text-ink-400" />
            {data.name}
            <StatusPill status={data.status} />
          </h1>
          <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            {data.counterpartyName && <span>Counterparty: <span className="text-ink-950">{data.counterpartyName}</span></span>}
            {data.owner && <span>· Owner: <span className="text-ink-950">{data.owner.name}</span></span>}
            {/* User-authored tags, so neutral — indigo is the machine's. */}
            {data.tags.map(t => <span key={t} className="font-mono text-ink-700 bg-paper-100 border border-paper-200 rounded-chip px-1.5">#{t}</span>)}
          </div>
          {data.description && <p className="text-[12px] text-ink-700 mt-2 max-w-3xl">{data.description}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {data.status === 'OPEN' ? (
            <>
              <Button
                variant="outline" size="sm"
                onClick={() => close.mutate()}
                data-testid="matter-close-btn"
                className="gap-1 text-[12px]"
              >
                <CheckCircle2 className="size-3" /> Close
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => archive.mutate()}
                data-testid="matter-archive-btn"
                className="gap-1 text-[12px]"
              >
                <Archive className="size-3" /> Archive
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => reopen.mutate()} data-testid="matter-reopen-btn" className="gap-1 text-[12px]">
              Reopen
            </Button>
          )}
        </div>
      </div>

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
              <span className="text-[10.5px] tabular-nums opacity-70">{t.count}</span>
            </button>
          )
        })}
      </div>

      {tab === 'contracts' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-contracts-body">
          {data.contracts.length === 0 && <EmptyRow text="No contracts in this matter yet. Open a contract and assign it via the Matter picker in its header." />}
          {data.contracts.map(c => (
            <li key={c.id}>
              <Link to={`/contracts/${c.id}`} className="block px-4 py-2 hover:bg-muted/40">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-[12.5px] text-ink-950 truncate">{c.title}</span>
                  <span className="text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground font-mono">{c.type}</span>
                  <StatusPill status={c.status} />
                  {c.value != null && <span className="text-[11px] tabular-nums text-muted-foreground">{(c.currency ?? '$')}{Number(c.value).toLocaleString()}</span>}
                  {/* A bare risk score isn't "your turn" — it's a reading, so
                      it takes the meaning its own threshold implies. */}
                  {c.riskScore != null && (
                    <span className={cn(
                      'text-[10.5px] tabular-nums',
                      c.riskScore >= 0.67 ? 'text-risk-700'
                        : c.riskScore >= 0.34 ? 'text-attention-700'
                        : 'text-ink-500',
                    )}>risk {(c.riskScore * 100).toFixed(0)}%</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {tab === 'requests' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-requests-body">
          {data.requests.length === 0 && <EmptyRow text="No intake requests linked to this matter." />}
          {data.requests.map(r => (
            <li key={r.id} className="px-4 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[10.5px] text-muted-foreground">{r.requestNumber ?? r.id.slice(-6)}</span>
                <span className="font-medium text-[12.5px] text-ink-950 truncate">{r.title}</span>
                <span className="text-[10.5px] text-muted-foreground">· {r.status} · {r.priority}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'threads' && (
        <ul className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden" data-testid="matter-tab-threads-body">
          {data.threads.length === 0 && <EmptyRow text="No agent threads linked to this matter yet." />}
          {data.threads.map(t => (
            <li key={t.id} className="px-4 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <MessageSquare className="size-3 text-muted-foreground" />
                <span className="text-[12.5px] text-ink-950 truncate">{t.title}</span>
                <span className="text-[10.5px] text-muted-foreground">· last activity {new Date(t.updatedAt).toLocaleDateString()}</span>
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
