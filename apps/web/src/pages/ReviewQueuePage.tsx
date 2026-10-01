/**
 * ReviewQueuePage (P2.5 / Wave F.5; docs/39 B4) — every value across the
 * org's contracts that needs a person, with the passage it came from beside
 * it, so a migrated portfolio's doubts can be cleared at speed.
 *
 * The queue used to show only low-confidence core fields of the 500 most
 * recently updated contracts, one card per contract, with no document and
 * no way to act on more than one value at a time. Now:
 *
 *   - every field kind, every contract in scope, a page at a time, filtered
 *     by why it needs a person (a new reading of a value someone set, a
 *     notice to tell apart, words a new version took out, an unsure value,
 *     nothing found) and by field;
 *   - a list beside the value's own passage in the contract, so checking it
 *     doesn't mean opening the contract;
 *   - keyboard: J/K to move, V to confirm, E to correct, X to clear,
 *     Space to select; and a bulk verify for what was selected.
 *
 * Design reference: Ironclad's Review Flagged Records and Focused
 * Verification; Hebbia's review queue (table + bulk actions).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Loader2,
  Pencil, Search, ShieldCheck, XCircle,
} from 'lucide-react'
import type { FieldValueType } from '@clm/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useCanRequest } from '@/lib/permissions'
import { toast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Kbd } from '@/components/ui/primitives'
import { AssistMark } from '@/components/ui/assist'
import { FieldEditor, errorDetail, type ContractField, type FieldCandidate, type FieldSuggestion } from '@/components/contracts/FieldsPanel'

type Reason = 'proposed' | 'suggestion' | 'conflict' | 'notice_type' | 'words_changed' | 'low_confidence' | 'always' | 'not_found'
/** A value with another beside it to take or leave: a new reading, or what their tracked changes propose. */
const offersChoice = (r: Reason) => r === 'suggestion' || r === 'proposed'
/** A confidence reason the item's reason already says (the readings box shows a disagreement). */
const saidByReason = (reason: Reason, r: string) =>
  (reason === 'words_changed' && r.includes('current version')) || (reason === 'conflict' && r.startsWith('The contract says different things'))
/** A6 — the reading the value holds now. */
const inUse = (it: { raw: unknown }, reading: FieldCandidate) => JSON.stringify(reading.value) === JSON.stringify(it.raw)

interface QueueItem {
  id: string
  reason: Reason
  contractId: string
  contractTitle: string
  contractType: string
  contractStatus: string
  counterparty: string | null
  field: string
  fieldLabel: string
  kind: ContractField['kind']
  type: FieldValueType
  options?: string[]
  unit?: string
  legacy: boolean
  /** As people read it; null when there is no value. */
  value: string | null
  raw: unknown
  quote: string | null
  section: string | null
  issue: string | null
  source: ContractField['source']
  confidence: number
  /** docs/39 B3 — why it's this sure: the model's number held down by what can be checked. */
  confidenceReasons?: string[]
  suggestion: FieldSuggestion | null
  /** docs/39 A6 — the contract says different things about it: each reading, the value's first. */
  candidates?: FieldCandidate[] | null
  updatedAt: string | null
}

interface QueuePage {
  items: QueueItem[]
  total: number
  counts: Record<Reason, number>
  fields: Array<{ key: string; label: string; count: number }>
  threshold: number
  offset: number
  limit: number
}

interface SourceResponse {
  excerpt: { before: string; match: string; after: string; clippedStart: boolean; clippedEnd: boolean } | null
}

const REASONS: Array<{ key: Reason; label: string; explain: string }> = [
  // A9 — the other side's Word file, its tracked changes not accepted.
  { key: 'proposed', label: 'Proposed change', explain: 'The other side’s tracked changes, not accepted yet, would change this value. It stays what’s agreed until you choose.' },
  { key: 'suggestion', label: 'New reading', explain: 'A person set or checked this value, and a new analysis reads it differently.' },
  // A6 — a long contract read in parts gave different values for it.
  { key: 'conflict', label: 'Says different things', explain: 'The contract gives different values for this, in different places. Choose the one that governs.' },
  { key: 'notice_type', label: 'Notice type', explain: 'Found before the AI told the two notices apart. Only the notice to stop a renewal sets the opt-out deadline.' },
  { key: 'words_changed', label: 'Words changed', explain: 'The words this value came from aren’t in the current version of the contract.' },
  { key: 'low_confidence', label: 'Unsure', explain: 'The AI read this value but isn’t sure of it.' },
  // B3 — Settings › Fields: this field's values are always checked by a person.
  { key: 'always', label: 'Always checked', explain: 'Your organization checks every value the AI reads for this field.' },
  { key: 'not_found', label: 'Not found', explain: 'The AI found nothing for this field, and isn’t sure the contract leaves it out.' },
]
const REASON = Object.fromEntries(REASONS.map(r => [r.key, r])) as Record<Reason, (typeof REASONS)[number]>

/** What a bulk verify confirms: the value as it stands. Suggestions and notice types need a choice. */
const VERIFIABLE = new Set<Reason>(['low_confidence', 'words_changed', 'always', 'not_found'])

const THRESHOLDS = [
  { value: 0.9, label: 'Unsure below 90%' },
  { value: 0.7, label: 'Unsure below 70%' },
  { value: 0.5, label: 'Unsure below 50%' },
]

const PAGE = 50

/** A field named in the URL that has nothing waiting: its key, readable ("confidentiality_period" → "Confidentiality period"). */
const humanKey = (key: string) => {
  const words = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The item as the Fields panel's editor takes it: its value to correct from. */
function asField(it: QueueItem): ContractField {
  return {
    key: it.field, kind: it.kind, label: it.fieldLabel, type: it.type, group: '', options: it.options, unit: it.unit,
    legacy: it.legacy, value: it.raw, display: it.value ?? '—', source: it.source, confidence: it.confidence,
    quote: it.quote, section: it.section, issue: it.issue, anchor: null, verifiedAt: null, rejectedAt: null,
    suggestion: it.suggestion, locked: false,
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

type Act =
  | { kind: 'verify'; it: QueueItem }
  | { kind: 'correct'; it: QueueItem; value: unknown }
  | { kind: 'reject'; it: QueueItem }
  | { kind: 'suggestion'; it: QueueItem; accept: boolean }
  | { kind: 'reassign'; it: QueueItem; to: 'terminationNotice' | 'nonRenewalNotice' }
  | { kind: 'choose'; it: QueueItem; reading: FieldCandidate }

export function ReviewQueuePage() {
  const qc = useQueryClient()
  const canEdit = useCanRequest('POST /review-queue/:contractId/verify')
  const [params, setParams] = useSearchParams()
  // ?contractId= — opened from a contract (C5); ?reason= — from a link that names one (renewals).
  const contractId = params.get('contractId') ?? undefined
  const reason = (params.get('reason') as Reason | null) ?? undefined
  // ?field= (&threshold=) — from a field's fill-in in Settings (D1).
  const [threshold, setThreshold] = useState(() => THRESHOLDS.find(t => String(t.value) === params.get('threshold'))?.value ?? 0.7)
  const [field, setField] = useState(() => params.get('field') ?? '')
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim(), 300)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState(0)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // A new filter starts at its first page, with nothing selected.
  useEffect(() => { setOffset(0); setSelected(0); setChecked(new Set()) }, [threshold, field, q, reason, contractId])

  const queryKey = ['review-queue', { threshold, reason, field, q, offset, contractId }]
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<QueuePage>('/review-queue', {
      params: { threshold, reason, field: field || undefined, q: q || undefined, offset, limit: PAGE, contractId },
    })).data,
    placeholderData: prev => prev,
  })
  const items = useMemo(() => data?.items ?? [], [data])
  const current: QueueItem | undefined = items[Math.min(selected, items.length - 1)]
  useEffect(() => { setEditing(false) }, [current?.id])

  const setReason = (r?: Reason) => {
    const next = new URLSearchParams(params)
    if (r) next.set('reason', r); else next.delete('reason')
    setParams(next, { replace: true })
  }

  const refresh = (contract?: string) => {
    qc.invalidateQueries({ queryKey: ['review-queue'] })
    if (contract) {
      qc.invalidateQueries({ queryKey: ['contract-fields', contract] })
      qc.invalidateQueries({ queryKey: ['contract', contract] })
    }
  }

  const act = useMutation({
    mutationFn: async (a: Act) => {
      const { contractId: id, field: key } = a.it
      if (a.kind === 'verify') return (await api.post(`/review-queue/${id}/verify`, { field: key })).data
      if (a.kind === 'correct') return (await api.post(`/review-queue/${id}/verify`, { field: key, value: a.value })).data
      if (a.kind === 'reject') return (await api.post(`/review-queue/${id}/reject`, { field: key })).data
      if (a.kind === 'suggestion') return (await api.post(`/contracts/${id}/fields/${encodeURIComponent(key)}/suggestion`, { action: a.accept ? 'accept' : 'dismiss' })).data
      // A6 — the reading that governs; one with its words is picked from the text, the words with it.
      if (a.kind === 'choose') {
        const body = a.reading.quote ? { value: a.reading.value, source: 'highlight', quote: a.reading.quote } : { value: a.reading.value }
        return (await api.put(`/contracts/${id}/fields/${encodeURIComponent(key)}`, body)).data
      }
      return (await api.post(`/contracts/${id}/fields/${encodeURIComponent(key)}/reassign`, { to: a.to })).data
    },
    onSuccess: (r: { statusChange?: { to: string } }, a) => {
      if (r?.statusChange) toast.info(`The contract went back to ${r.statusChange.to.toLowerCase()} for re-approval`)
      setEditing(false)
      setChecked(prev => { const next = new Set(prev); next.delete(a.it.id); return next })
      // The next item moves up into the same place: the selection stays put.
      refresh(a.it.contractId)
    },
    onError: err => toast.error('Not saved', { description: errorDetail(err) }),
  })

  const bulk = useMutation({
    mutationFn: async (b: { list: QueueItem[]; to?: 'nonRenewalNotice' | 'terminationNotice' }) => {
      const items = b.list.map(i => ({ contractId: i.contractId, field: i.field }))
      const r = b.to
        ? (await api.post<{ reassigned: number; failed: unknown[] }>('/review-queue/reassign-bulk', { to: b.to, items })).data
        : (await api.post<{ verified: number; failed: unknown[] }>('/review-queue/verify-bulk', { items })).data
      return { done: 'reassigned' in r ? r.reassigned : r.verified, failed: r.failed.length, to: b.to }
    },
    onSuccess: r => {
      const what = r.to === 'nonRenewalNotice' ? 'notices to stop renewal' : r.to === 'terminationNotice' ? 'notices to end early' : 'verified'
      toast.success(r.to ? `${r.done} saved as ${what}` : `Verified ${r.done} value${r.done === 1 ? '' : 's'}`,
        r.failed ? { description: `${r.failed} couldn't be saved.` } : undefined)
      setChecked(new Set())
      refresh()
    },
    onError: err => toast.error('Not saved', { description: errorDetail(err) }),
  })

  const checkedItems = items.filter(i => checked.has(i.id))
  const verifiable = checkedItems.filter(i => VERIFIABLE.has(i.reason))
  const notices = checkedItems.filter(i => i.reason === 'notice_type')
  const toggle = (id: string) => setChecked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  // Keyboard: the queue is for clearing many values fast.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (!items.length) return
      const it = current
      const move = (d: number) => { e.preventDefault(); setSelected(i => Math.max(0, Math.min(items.length - 1, i + d))) }
      switch (e.key) {
        case 'j': case 'ArrowDown': return move(1)
        case 'k': case 'ArrowUp': return move(-1)
        case ' ': if (it) { e.preventDefault(); toggle(it.id) } return
      }
      if (!it || !canEdit || act.isPending) return
      if (e.key === 'v' && VERIFIABLE.has(it.reason)) { e.preventDefault(); act.mutate({ kind: 'verify', it }) }
      else if (e.key === 'e' && it.reason !== 'notice_type') { e.preventDefault(); setEditing(true) }
      else if (e.key === 'x' && it.value !== null && !offersChoice(it.reason)) { e.preventDefault(); act.mutate({ kind: 'reject', it }) }
      else if (e.key === 'u' && offersChoice(it.reason)) { e.preventDefault(); act.mutate({ kind: 'suggestion', it, accept: true }) }
      else if (e.key === 'n' && offersChoice(it.reason)) { e.preventDefault(); act.mutate({ kind: 'suggestion', it, accept: false }) }
      else if (e.key === '1' && it.reason === 'notice_type') { e.preventDefault(); act.mutate({ kind: 'reassign', it, to: 'terminationNotice' }) }
      else if (e.key === '2' && it.reason === 'notice_type') { e.preventDefault(); act.mutate({ kind: 'reassign', it, to: 'nonRenewalNotice' }) }
      // A6 — 1–5 takes that reading; the one in use is confirmed.
      else if (it.reason === 'conflict' && /^[1-5]$/.test(e.key) && it.candidates?.[Number(e.key) - 1]) {
        e.preventDefault()
        const reading = it.candidates[Number(e.key) - 1]
        act.mutate(inUse(it, reading) ? { kind: 'verify', it } : { kind: 'choose', it, reading })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Keep the selected row in view as J/K move it.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, items])

  const counts = data?.counts
  const all = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0
  const pageEnd = Math.min(offset + items.length, data?.total ?? 0)

  return (
    <div className="h-full flex flex-col px-6 py-5 max-w-[1400px] mx-auto w-full" data-testid="review-queue-page">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <ShieldCheck className="size-4 text-ink-400" />
            Extraction Queue
          </h1>
          <p className="text-dense text-ink-500 mt-1 max-w-3xl">
            Values that need a person, from every contract, with the words each came from. Confirm it, correct it, or clear it.
          </p>
          {contractId && (
            <button
              onClick={() => { const next = new URLSearchParams(params); next.delete('contractId'); setParams(next) }}
              className="text-dense text-ink-700 hover:text-ink-950 hover:underline underline-offset-2 mt-1"
              data-testid="review-queue-clear-contract"
            >
              Showing one contract — show all
            </button>
          )}
        </div>
        <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-ink-400 shrink-0 pt-1">
          <Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>V</Kbd> confirm <Kbd>E</Kbd> correct <Kbd>X</Kbd> clear <Kbd>Space</Kbd> select
        </div>
      </div>

      {/* Why each value is here, with how many. */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3" role="tablist" aria-label="Reason">
        {[{ key: undefined as Reason | undefined, label: 'All', n: all }, ...REASONS.map(r => ({ key: r.key as Reason | undefined, label: r.label, n: counts?.[r.key] ?? 0 }))].map(r => (
          <button
            key={r.label}
            type="button"
            role="tab"
            aria-selected={reason === r.key}
            onClick={() => setReason(r.key)}
            disabled={r.key !== undefined && r.n === 0 && reason !== r.key}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] rounded-full font-medium border transition-colors',
              reason === r.key ? 'bg-ink-950 text-white border-ink-950' : 'bg-card text-ink-950 border-paper-200 hover:border-paper-300',
              'disabled:opacity-40 disabled:hover:border-paper-200',
            )}
            data-testid={`review-queue-reason-${r.key ?? 'all'}`}
          >
            {r.label}
            <span className={cn('tabular-nums', reason === r.key ? 'text-white/70' : 'text-ink-400')}>{counts ? r.n : '·'}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-2.5 top-2 size-3.5 text-ink-400" />
          <Input
            type="text"
            placeholder="Contract or counterparty…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="review-queue-search"
            className="pl-8"
          />
        </div>
        <select
          value={field}
          onChange={e => setField(e.target.value)}
          aria-label="Field"
          data-testid="review-queue-field"
          className="h-8 text-[13px] text-ink-950 rounded-md border border-input bg-card px-2 max-w-[14rem]"
        >
          <option value="">Every field</option>
          {field && !(data?.fields ?? []).some(f => f.key === field) && <option value={field}>{humanKey(field)}</option>}
          {(data?.fields ?? []).map(f => <option key={f.key} value={f.key}>{f.label} ({f.count})</option>)}
        </select>
        <select
          value={threshold}
          onChange={e => setThreshold(Number(e.target.value))}
          aria-label="How sure is sure enough"
          data-testid="review-queue-threshold"
          className="h-8 text-[13px] text-ink-950 rounded-md border border-input bg-card px-2"
        >
          {THRESHOLDS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {isFetching && !isLoading && <Loader2 className="size-3.5 animate-spin text-ink-400" />}
        {checked.size > 0 && canEdit && (
          <div className="ml-auto flex items-center gap-2" data-testid="review-queue-bulk">
            <span className="text-dense text-ink-700 tabular-nums">{checked.size} selected</span>
            <Button size="xs" variant="ghost" onClick={() => setChecked(new Set())}>Clear</Button>
            {notices.length > 0 && (
              <>
                <Button size="xs" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ list: notices, to: 'terminationNotice' })} data-testid="review-queue-bulk-termination">
                  {notices.length} to end early
                </Button>
                <Button size="xs" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ list: notices, to: 'nonRenewalNotice' })} data-testid="review-queue-bulk-nonrenewal">
                  {notices.length} to stop renewal
                </Button>
              </>
            )}
            {verifiable.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                className="text-brand-700 border-brand-200 hover:bg-brand-50"
                disabled={bulk.isPending}
                onClick={() => bulk.mutate({ list: verifiable })}
                title={verifiable.length < checked.size ? 'New readings need a choice each' : undefined}
                data-testid="review-queue-bulk-verify"
              >
                {bulk.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                Confirm {verifiable.length}
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-body text-risk-700 bg-risk-50 border border-risk-200 rounded-md p-3 mb-3">
          <AlertTriangle className="size-4" /> Couldn&apos;t load the queue: {errorDetail(error)}
        </div>
      )}

      {isLoading ? (
        <div className="text-body text-ink-500 py-6 flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : !error && items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={q || field || reason ? 'Nothing here with these filters.' : 'Nothing to review.'}
          description={q || field || reason ? 'Clear a filter, or let more in with a higher bar.' : 'Every value the AI was unsure of has been checked.'}
        />
      ) : !error && (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-4">
          {/* The list */}
          <div className="min-h-0 flex flex-col border border-paper-200 rounded-card bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-paper-200 bg-paper-50 text-[11px] text-ink-500">
              <input
                type="checkbox"
                aria-label="Select every value on this page"
                checked={items.length > 0 && items.every(i => checked.has(i.id))}
                onChange={e => setChecked(e.target.checked ? new Set(items.map(i => i.id)) : new Set())}
              />
              <span className="tabular-nums">{offset + 1}–{pageEnd} of {data?.total ?? 0}</span>
              <div className="ml-auto flex items-center">
                <button type="button" className="p-1 rounded-sm hover:bg-paper-100 disabled:opacity-30" disabled={offset === 0}
                  onClick={() => { setOffset(o => Math.max(0, o - PAGE)); setSelected(0) }} aria-label="Previous page">
                  <ChevronLeft className="size-3.5" />
                </button>
                <button type="button" className="p-1 rounded-sm hover:bg-paper-100 disabled:opacity-30" disabled={pageEnd >= (data?.total ?? 0)}
                  onClick={() => { setOffset(o => o + PAGE); setSelected(0) }} aria-label="Next page">
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto divide-y divide-paper-100" role="listbox" aria-label="Values to review">
              {items.map((it, i) => {
                const active = current?.id === it.id
                return (
                  <div
                    key={it.id}
                    role="option"
                    aria-selected={active}
                    onClick={() => setSelected(i)}
                    className={cn('flex items-start gap-2.5 px-3 py-2 cursor-pointer border-l-2', active ? 'bg-paper-100 border-l-ink-950' : 'border-l-transparent hover:bg-paper-50')}
                    data-testid={`review-queue-row-${it.contractId}-${it.field}`}
                  >
                    <input type="checkbox" className="mt-1" checked={checked.has(it.id)} onClick={e => e.stopPropagation()} onChange={() => toggle(it.id)} aria-label={`Select ${it.fieldLabel} of ${it.contractTitle}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12.5px] font-medium text-ink-950 truncate">{it.fieldLabel}</span>
                        <span className={cn('ml-auto shrink-0 max-w-[50%] truncate text-[12.5px]', it.value === null ? 'text-ink-400 italic' : 'text-ink-950')}>
                          {it.value ?? 'nothing found'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-ink-500 truncate">{it.contractTitle}</span>
                        <ReasonTag it={it} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* The value, beside its passage */}
          {current && (
            <Detail
              key={current.id}
              it={current}
              canEdit={canEdit}
              editing={editing}
              busy={act.isPending}
              onEdit={setEditing}
              onAct={a => act.mutate(a)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ReasonTag({ it }: { it: QueueItem }) {
  const machine = it.reason === 'low_confidence' || it.reason === 'always' || it.reason === 'not_found'
  return (
    <span className={cn(
      'shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] rounded-chip px-1.5 py-px border',
      machine ? 'bg-assist-50 text-assist-700 border-assist-200' : 'bg-attention-50 text-attention-700 border-attention-200',
    )}>
      {machine && <AssistMark confidence={it.confidence < 0.5 ? 'low' : it.confidence < 0.7 ? 'medium' : 'high'} />}
      {REASON[it.reason].label}{machine ? ` ${Math.round(it.confidence * 100)}%` : ''}
    </span>
  )
}

function Detail({ it, canEdit, editing, busy, onEdit, onAct }: {
  it: QueueItem
  canEdit: boolean
  editing: boolean
  busy: boolean
  onEdit: (on: boolean) => void
  onAct: (a: Act) => void
}) {
  const { data: source, isLoading } = useQuery({
    queryKey: ['review-source', it.contractId, it.field],
    queryFn: async () => (await api.get<SourceResponse>(`/review-queue/${it.contractId}/source`, { params: { field: it.field } })).data,
    staleTime: 30_000,
  })
  const markRef = useRef<HTMLElement>(null)
  useEffect(() => { markRef.current?.scrollIntoView({ block: 'center' }) }, [source])
  const excerpt = source?.excerpt

  return (
    <div className="min-h-0 flex flex-col border border-paper-200 rounded-card bg-card overflow-hidden" data-testid="review-queue-detail">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-paper-200">
        <div className="min-w-0 flex-1">
          <Link to={`/contracts/${it.contractId}?panel=fields&field=${encodeURIComponent(it.field)}`} className="text-[13px] font-medium text-ink-950 hover:underline underline-offset-2 decoration-paper-300 inline-flex items-center gap-1">
            {it.contractTitle} <ArrowUpRight className="size-3 text-ink-400" />
          </Link>
          <p className="text-[11px] text-ink-500 mt-0.5 truncate">
            {it.contractType.replace(/_/g, ' ')}{it.counterparty ? ` · ${it.counterparty}` : ''} · {it.contractStatus.replace(/_/g, ' ').toLowerCase()}
          </p>
        </div>
        <ReasonTag it={it} />
      </div>

      <div className="px-4 py-3 space-y-3 overflow-y-auto">
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-ink-400">{it.fieldLabel}</p>
          <p className={cn('mt-0.5 text-[15px] font-semibold', it.value === null ? 'text-ink-400 italic font-normal' : 'text-ink-950')} data-testid="review-queue-value">
            {it.value ?? 'Nothing found'}
          </p>
          <p className="text-[12px] text-ink-500 mt-1">{REASON[it.reason].explain}{it.issue && !it.confidenceReasons?.includes(it.issue) && !saidByReason(it.reason, it.issue) ? ` ${it.issue}` : ''}</p>
          {/* B3 — why the AI's value is this sure. */}
          {/* Not the one the reason already says ("words changed", "says different things"). */}
          {!!it.confidenceReasons?.filter(r => !saidByReason(it.reason, r)).length && (
            <ul className="mt-1.5 space-y-0.5" data-testid="review-queue-reasons">
              {it.confidenceReasons.filter(r => !saidByReason(it.reason, r)).map(r => (
                <li key={r} className="text-[11.5px] text-ink-700 flex items-start gap-1.5">
                  <span className="mt-1.5 size-1 rounded-full bg-ink-400 shrink-0" aria-hidden />{r}
                </li>
              ))}
            </ul>
          )}
        </div>

        {it.reason === 'conflict' && !!it.candidates?.length && (
          <ul className="rounded-md border border-attention-200 bg-attention-50 divide-y divide-attention-100" data-testid="review-queue-readings">
            {it.candidates.map((c, i) => {
              const current = inUse(it, c)
              return (
                <li key={i} className="flex items-start gap-2.5 px-3 py-2">
                  <Kbd className="mt-0.5 shrink-0">{i + 1}</Kbd>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-ink-950">
                      <span className="font-semibold">{current ? (it.value ?? c.display) : c.display}</span>
                      {current && <span className="ml-1.5 text-[11px] text-ink-500">in use</span>}
                      {c.section && <span className="ml-1.5 font-mono text-[10.5px] text-ink-400">{c.section}</span>}
                    </p>
                    {c.quote && <p className="mt-0.5 text-[12px] italic leading-snug text-ink-700">“{c.quote}”</p>}
                  </div>
                  {canEdit && (
                    <Button size="xs" variant={current ? 'ghost' : 'outline'} disabled={busy} className="shrink-0"
                      onClick={() => onAct(current ? { kind: 'verify', it } : { kind: 'choose', it, reading: c })}
                      data-testid={`review-queue-reading-${i}`}>
                      {current ? 'Keep' : 'Use this'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {offersChoice(it.reason) && it.suggestion && (
          <div className="rounded-md border border-assist-200 bg-assist-50 px-3 py-2">
            <p className="text-[12px] text-assist-900">
              {it.suggestion.reason === 'proposed'
                ? (it.suggestion.display
                  ? <>Their tracked changes propose <span className="font-semibold">{it.suggestion.display}</span></>
                  : <>Their tracked changes take this out</>)
                : <>{it.suggestion.reason === 'edited' ? 'Since the edit, the contract reads' : 'A new analysis reads'} <span className="font-semibold">{it.suggestion.display}</span></>}
            </p>
            {it.suggestion.quote && <p className="text-[11.5px] italic text-assist-700 mt-0.5">“{it.suggestion.quote}”</p>}
          </div>
        )}

        {/* The passage, in its context */}
        <div className="rounded-md border border-paper-200 bg-paper-50 max-h-56 overflow-y-auto" data-testid="review-queue-source">
          {isLoading ? (
            <p className="px-3 py-2.5 text-[12px] text-ink-500 flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Finding the passage…</p>
          ) : excerpt ? (
            <p className="px-3 py-2.5 font-serif text-[13px] leading-relaxed text-ink-700 whitespace-pre-wrap">
              {excerpt.clippedStart && '…'}{excerpt.before}
              <mark ref={markRef} className="bg-attention-100 text-ink-950 rounded-sm px-0.5">{excerpt.match}</mark>
              {excerpt.after}{excerpt.clippedEnd && '…'}
            </p>
          ) : (
            <div className="px-3 py-2.5 text-[12px] text-ink-500 space-y-1">
              {it.quote ? (
                <>
                  <p className="italic text-ink-700">“{it.quote}”</p>
                  <p>
                    {it.reason === 'proposed'
                      ? 'The agreed wording. Their tracked changes replace it in the document.'
                      : <>{it.reason === 'words_changed' ? 'These words aren’t in the current version.' : 'Couldn’t find these words in the contract’s text.'} Open the contract to check.</>}
                  </p>
                </>
              ) : (
                <p>No passage: the AI gave no quote for this value.</p>
              )}
            </div>
          )}
        </div>
        {it.section && <p className="text-[11px] font-mono text-ink-400">Section {it.section}</p>}

        {canEdit && (editing ? (
          <FieldEditor f={asField(it)} saving={busy} onSave={value => onAct({ kind: 'correct', it, value })} onCancel={() => onEdit(false)} />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="review-queue-actions">
            {it.reason === 'notice_type' ? (
              <>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => onAct({ kind: 'reassign', it, to: 'terminationNotice' })}>
                  Notice to end early <Kbd className="ml-1">1</Kbd>
                </Button>
                <Button size="xs" disabled={busy} onClick={() => onAct({ kind: 'reassign', it, to: 'nonRenewalNotice' })}>
                  Notice to stop renewal <Kbd className="ml-1 bg-transparent text-white/80 border-white/30">2</Kbd>
                </Button>
                {/* Some were never a notice: a due-diligence list's "30 days' notice" is a question, not a term. */}
                <Button size="xs" variant="danger" disabled={busy} onClick={() => onAct({ kind: 'reject', it })} data-testid="review-queue-reject">
                  <XCircle /> Neither, clear it <Kbd className="ml-1">X</Kbd>
                </Button>
              </>
            ) : it.reason === 'conflict' ? (
              <>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(true)} data-testid="review-queue-correct">
                  <Pencil /> Something else <Kbd className="ml-1">E</Kbd>
                </Button>
                <Button size="xs" variant="danger" disabled={busy} onClick={() => onAct({ kind: 'reject', it })} data-testid="review-queue-reject">
                  <XCircle /> Clear it <Kbd className="ml-1">X</Kbd>
                </Button>
              </>
            ) : offersChoice(it.reason) && it.suggestion ? (
              <>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => onAct({ kind: 'suggestion', it, accept: false })} data-testid="review-queue-keep">
                  Keep {it.value ?? 'nothing'} <Kbd className="ml-1">N</Kbd>
                </Button>
                <Button size="xs" variant="assistOutline" disabled={busy} onClick={() => onAct({ kind: 'suggestion', it, accept: true })} data-testid="review-queue-use">
                  <AssistMark /> {it.suggestion.display ? `Use ${it.suggestion.display}` : 'Clear the value'} <Kbd className="ml-1">U</Kbd>
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(true)}>
                  <Pencil /> Something else <Kbd className="ml-1">E</Kbd>
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  className="text-brand-700 border-brand-200 hover:bg-brand-50"
                  disabled={busy}
                  onClick={() => onAct({ kind: 'verify', it })}
                  data-testid="review-queue-verify"
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Check />}
                  {/* Confirming a term is absent is an answer, and a different one from confirming a value. */}
                  {it.value === null ? 'Not in the contract' : 'Confirm'} <Kbd className="ml-1">V</Kbd>
                </Button>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => onEdit(true)} data-testid="review-queue-correct">
                  <Pencil /> {it.value === null ? 'Add the value' : 'Correct'} <Kbd className="ml-1">E</Kbd>
                </Button>
                {it.value !== null && (
                  <Button size="xs" variant="danger" disabled={busy} onClick={() => onAct({ kind: 'reject', it })} data-testid="review-queue-reject">
                    <XCircle /> Wrong, clear it <Kbd className="ml-1">X</Kbd>
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
