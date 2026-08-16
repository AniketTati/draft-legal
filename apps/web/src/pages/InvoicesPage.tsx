/**
 * InvoicesPage — invoice reconciliation (Phase 08 Step 9).
 *
 * Customers track vendor invoices against payment obligations
 * extracted from executed contracts. The page shows every invoice with
 * its match status; users confirm via "Reconcile", flag mismatches via
 * "Dispute", or open the contract for context.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AssistCard, AssistChip, AssistMark } from '@/components/ui/assist'
import { CountBadge } from '@/components/ui/primitives'
import { StatusPill, MeaningDot } from '@/components/ui/status-pill'
import type { Meaning } from '@/lib/status'
import {
  Receipt, Plus, Loader2, AlertCircle, CheckCircle2,
  Search, Sparkles, RotateCw, Flag, FileText, X,
} from 'lucide-react'

type Status = 'all' | 'PENDING' | 'MATCHED' | 'RECONCILED' | 'DISPUTED'

interface ApiInvoice {
  id:                  string
  vendorName:          string
  invoiceNumber:       string | null
  amount:              string  // Prisma Decimal serialized
  currency:            string
  invoiceDate:         string
  dueDate:             string | null
  description:         string | null
  status:              'PENDING' | 'MATCHED' | 'RECONCILED' | 'DISPUTED'
  matchScore:          number | null
  reconciledAt:        string | null
  /** Why someone disputed it. Stored and returned, but never rendered before. */
  disputeReason:       string | null
  contract: { id: string; title: string; counterpartyName: string | null } | null
  matchedObligation: {
    id: string; type: string; description: string; dueDate: string | null
  } | null
}

interface ApiStats {
  pending:    number
  matched:    number
  reconciled: number
  disputed:   number
  openTotal:  number
}

/*
 * The local STATUS_PILL map is gone — all four states live in lib/status now,
 * with no local exception. MATCHED reads as binding here exactly as it does
 * everywhere else; the "still waiting on a human to reconcile" story is told
 * by the Reconciled column and the filter tabs, not by a second colour for a
 * status the rest of the product has already coloured.
 */

const FILTERS: { key: Status; label: string; statKey?: keyof ApiStats }[] = [
  { key: 'all',        label: 'All' },
  { key: 'PENDING',    label: 'Pending',    statKey: 'pending' },
  { key: 'MATCHED',    label: 'Matched',    statKey: 'matched' },
  { key: 'RECONCILED', label: 'Reconciled', statKey: 'reconciled' },
  { key: 'DISPUTED',   label: 'Disputed',   statKey: 'disputed' },
]

function formatMoney(amount: string | number, currency = 'USD'): string {
  const n = typeof amount === 'string' ? Number(amount) : amount
  if (isNaN(n)) return `${currency} 0`
  return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
}

/**
 * A KPI figure, not a ledger entry. "$1,637,321.00" spent four characters on
 * cents nobody reads at a glance and pushed the number into the card border.
 */
function formatMoneyCompact(amount: number, currency = 'USD'): string {
  if (!Number.isFinite(amount)) return '—'
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })}M`
  }
  if (Math.abs(amount) >= 10_000) {
    return `${Math.round(amount / 1_000).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })}K`
  }
  return amount.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The payment-due reading for an invoice that is still owed.
 *
 * The table showed the invoice DATE and nothing else, so "this one is three
 * weeks past its payment terms" — the single fact that decides whether an AP
 * queue is healthy — was not on the page at all. Reconciled and disputed
 * invoices are exempt: they are settled or contested, not late.
 */
function dueReading(inv: ApiInvoice): { text: string; tone: string } {
  if (!inv.dueDate) return { text: '—', tone: 'text-ink-400' }
  const dateStr = formatDate(inv.dueDate)
  if (inv.status === 'RECONCILED' || inv.status === 'DISPUTED') {
    return { text: dateStr, tone: 'text-ink-500' }
  }
  const d = Math.round((new Date(inv.dueDate).getTime() - Date.now()) / DAY_MS)
  if (!Number.isFinite(d)) return { text: dateStr, tone: 'text-ink-500' }
  if (d < 0)   return { text: `${-d}d overdue`, tone: 'text-risk-700 font-medium' }
  if (d === 0) return { text: 'Due today',      tone: 'text-attention-700 font-medium' }
  if (d <= 14) return { text: `Due in ${d}d`,   tone: 'text-attention-700 font-medium' }
  return { text: dateStr, tone: 'text-ink-500' }
}

/*
 * The auto-matcher's confidence in its own answer — the design system's
 * canonical "confidence mark", so it takes the assist accent and the diamond,
 * hollowing out as the model gets less sure.
 */
function MatchScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null
  const pct = Math.round(score * 100)
  const confidence = pct >= 70 ? 'high' : pct >= 50 ? 'medium' : 'low'
  return (
    <AssistChip icon={<AssistMark confidence={confidence} className="size-[5px]" />}>
      {pct}%
    </AssistChip>
  )
}

export function InvoicesPage() {
  const [status, setStatus] = useState<Status>('all')
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const qc = useQueryClient()

  const { data: stats } = useQuery<ApiStats>({
    queryKey: ['invoice-stats'],
    queryFn:  () => api.get('/invoices/stats').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data, isLoading, isError } = useQuery<{ data: ApiInvoice[]; total: number }>({
    queryKey: ['invoices-list', status, q],
    queryFn:  () => api.get(`/invoices?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}&limit=100`).then(r => r.data),
    refetchInterval: 60_000,
  })

  const reconcile = useMutation({
    mutationFn: async (id: string) => (await api.post(`/invoices/${id}/reconcile`, {})).data,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['invoices-list'] })
      qc.invalidateQueries({ queryKey: ['invoice-stats'] })
      qc.invalidateQueries({ queryKey: ['obligations-list'] })
      qc.invalidateQueries({ queryKey: ['obligations-stats'] })
    },
  })
  const rematch = useMutation({
    mutationFn: async (id: string) => (await api.post(`/invoices/${id}/rematch`, {})).data,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['invoices-list'] }),
  })
  // Disputing is a one-way door from this page — there is no un-dispute
  // control — and it used to fire on a single click with the hard-coded reason
  // "Flagged from invoices page", which tells the next reader nothing about why
  // the money is being withheld. Ask, then act.
  const [disputeTarget, setDisputeTarget] = useState<ApiInvoice | null>(null)
  const dispute = useMutation({
    mutationFn: async (p: { id: string; reason: string }) =>
      (await api.post(`/invoices/${p.id}/dispute`, { reason: p.reason })).data,
    onSuccess:  () => {
      setDisputeTarget(null)
      qc.invalidateQueries({ queryKey: ['invoices-list'] })
      qc.invalidateQueries({ queryKey: ['invoice-stats'] })
    },
  })

  const items = data?.data ?? []
  const total = data?.total ?? 0

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto" data-testid="invoices-page">
      <div className="flex items-center justify-between mb-1 gap-4">
        <div className="flex items-center gap-3">
          {/* Amber means "blocked on you"; an invoice queue is not, by itself,
              your turn — so the page chrome is ink. */}
          <Receipt className="size-4 text-ink-400" />
          <h1 className="text-title text-ink-950">Invoices</h1>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          data-testid="add-invoice-btn"
          className="gap-1.5"
        >
          <Plus className="size-3.5" />
          Add invoice
        </Button>
      </div>
      <p className="text-dense text-ink-500 mb-5">
        Match incoming vendor invoices to the payment obligations on your executed contracts.
      </p>

      {/* Stats strip. Disputed was missing entirely — six invoices in contention
          were the only invoice state the design system reads as risk, and the
          header said nothing about them. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label="Pending"      value={stats?.pending ?? 0}     tone="neutral"  data-testid="stat-pending" />
        <StatCard label="Matched"      value={stats?.matched ?? 0}     tone="inflight" data-testid="stat-matched" />
        <StatCard label="Reconciled"   value={stats?.reconciled ?? 0}  tone="binding"  data-testid="stat-reconciled" />
        <StatCard label="Disputed"     value={stats?.disputed ?? 0}    tone="risk"     data-testid="stat-disputed" />
        <StatCard
          label="Open total"
          value={formatMoneyCompact(stats?.openTotal ?? 0)}
          tone="neutral"
          data-testid="stat-open-total"
          subtitle="pending + matched"
        />
      </div>

      {/* Filter tabs + search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-paper-200 pb-2">
        <div className="flex items-center gap-1 -mb-2 overflow-x-auto">
          {FILTERS.map(f => {
            const active = status === f.key
            const count = f.statKey ? stats?.[f.statKey] ?? 0 : null
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatus(f.key)}
                data-testid={`invoice-filter-${f.key}`}
                className={`px-3 py-2 text-dense border-b-2 transition-colors whitespace-nowrap ${
                  // A selected tab is an action state, so it underlines in ink.
                  active
                    ? 'border-ink-950 text-ink-950 font-semibold'
                    : 'border-transparent text-ink-500 hover:text-ink-950'
                }`}
              >
                {f.label}
                {/* Filter counts are informational — only "your turn" earns color. */}
                {count != null && count > 0 && (
                  <CountBadge tone={active ? 'ink' : 'neutral'} className="ml-1.5">{count}</CountBadge>
                )}
              </button>
            )
          })}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
          <Input
            type="search"
            placeholder="Search vendor or invoice #"
            value={q}
            onChange={e => setQ(e.target.value)}
            data-testid="invoices-search"
            className="pl-8 w-full sm:w-64"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-ink-400" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 p-4 rounded-md bg-risk-50 border border-risk-200 text-dense text-risk-700">
          <AlertCircle className="size-4 mt-0.5" />
          Failed to load invoices.
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 px-6 border border-dashed border-paper-300 rounded-card" data-testid="invoices-empty">
          <Receipt className="size-6 text-ink-400 mx-auto mb-2" />
          <p className="text-dense text-ink-500 mb-1">
            {q ? `No invoices match "${q}".` : 'No invoices yet.'}
          </p>
          <p className="text-[11.5px] text-ink-400 mb-3">
            Add an invoice to auto-match it against the payment obligations on your contracts.
          </p>
          <Button
            onClick={() => setCreateOpen(true)}
            variant="outline"
            size="sm"
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            Add invoice
          </Button>
        </div>
      ) : (
        <div className="bg-card border border-paper-200 rounded-card overflow-hidden">
          <div className="px-5 py-2 text-[11.5px] text-ink-500 bg-paper-50 border-b border-paper-200">
            <span className="tabular-nums">{total}</span> {total === 1 ? 'invoice' : 'invoices'}
          </div>
          {/* Six auto-width columns needed more room than the shell has, so the
              Status pill and every row action were clipped off the right edge —
              on a page whose entire purpose is reconciling. The match is now a
              line inside the invoice cell rather than a column of its own, which
              is also where it belongs: it is a fact about this invoice, not a
              parallel axis to scan. */}
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-dense" data-testid="invoices-table">
              <thead className="bg-paper-50 text-[10px] uppercase tracking-[0.09em] text-ink-400">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Vendor / match</th>
                  <th className="text-right px-3 py-2 font-semibold w-[112px]">Amount</th>
                  <th className="text-left px-3 py-2 font-semibold w-[106px]">Due</th>
                  <th className="text-left px-3 py-2 font-semibold w-[116px]">Status</th>
                  <th className="text-right px-4 py-2 font-semibold w-[150px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-100">
                {items.map(inv => {
                  const due = dueReading(inv)
                  const actionable = inv.status === 'PENDING' || inv.status === 'MATCHED'
                  return (
                  <tr key={inv.id} className="hover:bg-paper-50 align-top" data-testid={`invoice-row-${inv.id}`}>
                    <td className="px-4 py-2.5">
                      <div className="text-[13px] font-medium text-ink-950 truncate" title={inv.vendorName}>
                        {inv.vendorName}
                      </div>
                      <div className="text-[11px] text-ink-400 mt-0.5 truncate">
                        {inv.invoiceNumber && <span className="font-mono">#{inv.invoiceNumber}</span>}
                        {inv.invoiceNumber && ' · '}
                        <span className="tabular-nums">issued {formatDate(inv.invoiceDate)}</span>
                      </div>
                      {inv.matchedObligation && inv.contract ? (
                        <div className="flex items-start gap-1.5 min-w-0 mt-1">
                          {/* The auto-matcher drew this link, so it carries the mark. */}
                          <AssistMark className="mt-1.5 flex-shrink-0" />
                          <div className="min-w-0">
                            <Link
                              to={`/contracts/${inv.contract.id}`}
                              className="text-[11.5px] font-medium text-ink-950 hover:text-brand-700 truncate block"
                              title={inv.contract.title}
                            >
                              {inv.contract.title}
                            </Link>
                            <div className="text-[10.5px] text-ink-500 truncate" title={inv.matchedObligation.description}>
                              {inv.matchedObligation.description}
                            </div>
                          </div>
                          <span className="shrink-0 mt-0.5">
                            <MatchScoreBadge score={inv.matchScore} />
                          </span>
                        </div>
                      ) : (
                        <div className="text-[11.5px] text-ink-400 italic mt-1">
                          No match{actionable ? ' — rematch or link manually' : ''}
                        </div>
                      )}
                      {inv.status === 'DISPUTED' && inv.disputeReason && (
                        // Stored on every dispute and rendered nowhere: the next
                        // person to pick this up had no idea why it was held.
                        <div className="text-[11px] text-risk-700 mt-1 line-clamp-2" title={inv.disputeReason}>
                          {inv.disputeReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap font-medium text-ink-950 tabular-nums">
                      {formatMoney(inv.amount, inv.currency)}
                    </td>
                    <td className={`px-3 py-2.5 whitespace-nowrap tabular-nums text-[11.5px] ${due.tone}`}>
                      {due.text}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill
                        status={inv.status}
                        meaning={inv.status === 'MATCHED' ? 'inflight' : undefined}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {/* Stacked, not wrapped. Three text actions cannot sit on
                          one line at this width, and a wrap put "Dispute" next
                          to two unrelated icons. The invoice cell beside it is
                          already three lines tall, so the stack costs no height. */}
                      <div className="inline-flex flex-col items-end gap-1">
                        {inv.status === 'MATCHED' && (
                          <button
                            type="button"
                            onClick={() => reconcile.mutate(inv.id)}
                            disabled={reconcile.isPending}
                            data-testid={`reconcile-${inv.id}`}
                            // Reconciling settles the invoice — the one binding
                            // decision in this row group.
                            className="inline-flex items-center gap-1 text-[11.5px] text-brand-700 hover:text-brand-800 font-medium disabled:opacity-50"
                          >
                            <CheckCircle2 className="size-3.5" />
                            Reconcile
                          </button>
                        )}
                        {actionable && (
                          <button
                            type="button"
                            onClick={() => rematch.mutate(inv.id)}
                            disabled={rematch.isPending}
                            data-testid={`rematch-${inv.id}`}
                            aria-label="Re-run the auto-matcher for this invoice"
                            className="inline-flex items-center gap-1 text-[11.5px] text-ink-700 hover:text-ink-950 font-medium"
                            title="Re-run auto-matcher"
                          >
                            <RotateCw className="size-3.5" />
                            Rematch
                          </button>
                        )}
                        {actionable && (
                          <button
                            type="button"
                            onClick={() => setDisputeTarget(inv)}
                            data-testid={`dispute-${inv.id}`}
                            className="inline-flex items-center gap-1 text-[11.5px] text-risk-600 hover:text-risk-700 font-medium"
                          >
                            <Flag className="size-3.5" />
                            Dispute
                          </button>
                        )}
                        {/* The contract is already a link inside the invoice
                            cell; a second one here was two more icons per row
                            saying the same thing. Kept only where there is no
                            match line to carry it. */}
                        {inv.contract?.id && !inv.matchedObligation && (
                          <Link
                            to={`/contracts/${inv.contract.id}`}
                            aria-label={`Open ${inv.contract.title}`}
                            title="Open contract"
                            className="inline-flex items-center gap-1 text-[11.5px] text-ink-700 hover:text-ink-950 font-medium"
                          >
                            <FileText className="size-3.5" />
                            Contract
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {disputeTarget && (
        <DisputeInvoiceDialog
          invoice={disputeTarget}
          pending={dispute.isPending}
          error={dispute.isError ? 'Could not record the dispute. Try again.' : null}
          onClose={() => { dispute.reset(); setDisputeTarget(null) }}
          onConfirm={(reason) => dispute.mutate({ id: disputeTarget.id, reason })}
        />
      )}

      {createOpen && (
        <CreateInvoiceDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['invoices-list'] })
            qc.invalidateQueries({ queryKey: ['invoice-stats'] })
          }}
        />
      )}
    </div>
  )
}

function StatCard({ label, value, tone, subtitle, ...rest }: {
  label:    string
  value:    number | string
  tone:     Meaning
  subtitle?: string
  'data-testid'?: string
}) {
  // These are counts, and "your turn" is the only count that earns colour.
  // Tinting them by pipeline stage also made the strip disagree with the rows
  // underneath — the shared map reads MATCHED as binding, so a blue "Matched"
  // figure sat directly above a green "Matched" pill. The figure stays ink; the
  // meaning rides on the dot beside the label, the same way the obligations
  // strip carries it, so the two post-signature queues read alike.
  const toneClass = tone === 'turn' ? 'text-attention-700' : 'text-ink-950'
  return (
    <div className="border border-paper-200 rounded-card p-4 bg-card" {...rest}>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
        <MeaningDot meaning={tone} label={label} />
        {label}
      </div>
      <div className={`text-[24px] font-semibold tracking-[-0.02em] tabular-nums mt-0.5 ${toneClass}`}>{value}</div>
      {subtitle && <div className="text-[10.5px] text-ink-500 mt-0.5">{subtitle}</div>}
    </div>
  )
}

/**
 * Disputing withholds payment and, in this product, cannot be undone from the
 * list. So it asks for the reason it already had a column for, and states the
 * amount and vendor back to the user before they commit.
 */
function DisputeInvoiceDialog({
  invoice, pending, error, onClose, onConfirm,
}: {
  invoice: ApiInvoice
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const valid = reason.trim().length >= 4 && !pending

  return (
    <div
      role="dialog"
      aria-label="Dispute invoice"
      className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="dispute-invoice-dialog"
    >
      <div className="bg-card rounded-card max-w-md w-full shadow-e3" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <Flag className="size-4 text-risk-600" />
              Dispute invoice
            </h2>
            <p className="text-[11.5px] text-ink-500 mt-1 truncate">
              {invoice.vendorName} · {formatMoney(invoice.amount, invoice.currency)}
              {invoice.invoiceNumber && ` · #${invoice.invoiceNumber}`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-paper-100 text-ink-400">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div>
            <label htmlFor="dispute-reason" className="block text-[11px] font-medium text-ink-700 mb-1">
              Reason <span className="text-risk-600">*</span>
            </label>
            <textarea
              id="dispute-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Amount exceeds the committed rate card by $4,200; PO number does not match."
              data-testid="dispute-reason"
              className="w-full text-[13px] text-ink-950 border border-input bg-card rounded-md px-3 py-2 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 resize-y"
            />
            <p className="text-[10.5px] text-ink-400 mt-1">
              Recorded on the invoice and shown to whoever picks it up next.
            </p>
          </div>
          {error && (
            <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => onConfirm(reason.trim())}
            disabled={!valid}
            data-testid="dispute-confirm"
          >
            {pending && <Loader2 className="animate-spin" />}
            Dispute invoice
          </Button>
        </div>
      </div>
    </div>
  )
}

function CreateInvoiceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [vendorName,    setVendorName]    = useState('')
  const [amount,        setAmount]        = useState('')
  const [currency,      setCurrency]      = useState('USD')
  const [invoiceDate,   setInvoiceDate]   = useState(new Date().toISOString().slice(0, 10))
  const [dueDate,       setDueDate]       = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [description,   setDescription]   = useState('')
  const [error,         setError]         = useState<string | null>(null)
  const [matchPreview,  setMatchPreview]  = useState<{ vendor: string; obligation: string; score: number } | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const r = await api.post('/invoices', {
        vendorName:    vendorName.trim(),
        amount:        Number(amount),
        currency:      currency.toUpperCase(),
        invoiceDate,
        dueDate:       dueDate || undefined,
        invoiceNumber: invoiceNumber.trim() || undefined,
        description:   description.trim() || undefined,
      })
      return r.data as { invoice: ApiInvoice; matchReason: string | null }
    },
    onSuccess: (data) => {
      if (data.invoice.matchedObligation && data.invoice.contract) {
        setMatchPreview({
          vendor: data.invoice.contract.title,
          obligation: data.invoice.matchedObligation.description,
          score: Math.round((data.invoice.matchScore ?? 0) * 100),
        })
      } else {
        onCreated()
        onClose()
      }
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail ?? 'Failed to create invoice.')
    },
  })

  const valid = vendorName.trim() && amount && !isNaN(Number(amount)) && Number(amount) > 0 && invoiceDate

  if (matchPreview) {
    return (
      <div role="dialog" className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-card rounded-card max-w-md w-full shadow-e3 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 mb-3">
            {/* This whole dialog reports what the matcher concluded, so it is
                marked machine-authored rather than tinted an arbitrary blue. */}
            <Sparkles className="size-4 text-assist-600" />
            <h2 className="text-section text-ink-950">Match found</h2>
          </div>
          <p className="text-body text-ink-700 mb-4">
            We linked this invoice to <strong>{matchPreview.vendor}</strong> at <strong>{matchPreview.score}%</strong> confidence.
          </p>
          <AssistCard className="mb-4">{matchPreview.obligation}</AssistCard>
          <div className="flex justify-end">
            <Button onClick={() => { onCreated(); onClose() }}>Done</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Add invoice"
      className="fixed inset-0 z-50 bg-ink-950/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="create-invoice-dialog"
    >
      <div className="bg-card rounded-card max-w-lg w-full shadow-e3 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              <Receipt className="size-4 text-ink-400" />
              Add invoice
            </h2>
            <p className="text-[11.5px] text-ink-500 mt-1">
              Auto-matches against open payment obligations on your contracts.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-paper-100 text-ink-400">
            <X className="size-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1">Vendor name</label>
            <Input
              value={vendorName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVendorName(e.target.value)}
              placeholder="Acme Corp"
              data-testid="invoice-vendor"
            />
            <p className="text-[10.5px] text-ink-400 mt-1">Match works best when this matches the contract counterparty.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1">Amount</label>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                placeholder="0.00"
                data-testid="invoice-amount"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full h-8 text-[13px] text-ink-950 border border-input rounded-md px-2.5 bg-card focus:outline-none focus-visible:border-brand-700"
                data-testid="invoice-currency"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CAD">CAD</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1">Invoice date</label>
              <Input
                type="date"
                value={invoiceDate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInvoiceDate(e.target.value)}
                data-testid="invoice-date"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1">Due date <span className="text-ink-400 font-normal">(optional)</span></label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDueDate(e.target.value)}
                data-testid="invoice-due-date"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1">Invoice number <span className="text-ink-400 font-normal">(optional)</span></label>
            <Input
              value={invoiceNumber}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInvoiceNumber(e.target.value)}
              placeholder="INV-12345"
              data-testid="invoice-number"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1">Description <span className="text-ink-400 font-normal">(optional)</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Q2 2026 retainer, monthly hosting fee, etc."
              rows={2}
              data-testid="invoice-description"
              className="w-full text-[13px] text-ink-950 border border-input bg-card rounded-md px-3 py-2 placeholder:text-ink-400 focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 resize-y"
            />
          </div>
          {error && (
            <div className="text-dense text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">{error}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
            data-testid="invoice-create-confirm"
          >
            {create.isPending ? (
              <><Loader2 className="size-3.5 animate-spin mr-1" /> Saving…</>
            ) : (
              <><Sparkles className="size-3.5 mr-1" /> Add + match</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
