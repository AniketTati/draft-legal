import { useEffect, useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/primitives'
import { Plus, Search, Building2, Loader2, X, ExternalLink, Trash2, FileText, ChevronRight } from 'lucide-react'

interface Counterparty {
  id:             string
  name:           string
  legalName:      string | null
  email:          string | null
  phone:          string | null
  website:        string | null
  createdAt:      string
  // B.6.9 — server now includes per-row counts + last-activity. These
  // are the core signals the page exists for.
  contractCount?: number
  lastContractAt?: string | null
  // P7.4.6 / F-50 — what kind of activity drove the timestamp ("comment"
  // is more meaningful than "contract") so we can show a tiny tag.
  lastActivityKind?: 'contract' | 'comment' | 'share' | null
}

function relativeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
  if (diffDays < 1) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
  return new Date(dateStr).toLocaleDateString()
}

function AddCounterpartyModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', legalName: '', email: '', phone: '', website: '' })

  const create = useMutation({
    mutationFn: () => api.post('/counterparties', {
      name:      form.name,
      legalName: form.legalName || undefined,
      email:     form.email || undefined,
      phone:     form.phone || undefined,
      website:   form.website || undefined,
    }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['counterparties'] })
      onClose()
    },
  })

  const set = (f: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(v => ({ ...v, [f]: e.target.value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm">
      <div className="bg-card rounded-card shadow-e3 w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200">
          <h2 className="text-section text-ink-950">Add Counterparty</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-paper-100 rounded-md">
            <X className="size-4 text-ink-500" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1.5">
              Name <span className="text-risk-600">*</span>
            </label>
            <Input value={form.name} onChange={set('name')} placeholder="Acme Corp" />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1.5">Legal name</label>
            <Input value={form.legalName} onChange={set('legalName')} placeholder="Acme Corporation Inc." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1.5">Email</label>
              <Input type="email" value={form.email} onChange={set('email')} placeholder="legal@acme.com" />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ink-700 mb-1.5">Phone</label>
              <Input value={form.phone} onChange={set('phone')} placeholder="+1 555 000 0000" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-ink-700 mb-1.5">Website</label>
            <Input value={form.website} onChange={set('website')} placeholder="https://acme.com" />
          </div>
          {create.isError && (
            <p className="text-[11.5px] text-risk-700">Failed to add counterparty. Name may already exist.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-paper-200">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => create.mutate()}
            disabled={!form.name.trim() || create.isPending}
            className="gap-1.5"
          >
            {create.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : 'Add Counterparty'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// 100, because that is the server's hard ceiling: GET /counterparties does
// `take: Math.min(Number(limit), 100)`. Asking for 200 does not widen the page
// — it only makes the `truncated` test below (`rows.length >= PAGE_SIZE`)
// unreachable, so a capped list would have gone on claiming it was the whole
// book, which is the exact bug the count line was rewritten to fix.
const PAGE_SIZE = 100

type SortKey = 'name' | 'contracts' | 'activity'

export function CounterpartiesPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch]   = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [debounced, setDebounced] = useState('')
  /*
   * Sort. The list arrived alphabetically and offered no alternative, which is
   * the wrong default for a portfolio page: "who do we do the most business
   * with" and "who have we not touched in a year" are the questions this
   * screen exists to answer, and neither is answerable from A–Z. Contract
   * volume leads, because that is the concentration a legal-ops lead is
   * looking for.
   */
  const [sort, setSort] = useState<SortKey>('contracts')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Counterparty | null>(null)

  const handleSearch = (val: string) => {
    setSearch(val)
    clearTimeout((window as any).__cpDebounce)
    ;(window as any).__cpDebounce = setTimeout(() => setDebounced(val), 300)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['counterparties', debounced],
    queryFn:  () => api.get('/counterparties', { params: { q: debounced || undefined, limit: PAGE_SIZE } }).then(r => r.data),
  })

  const rows: Counterparty[] = data?.data ?? data ?? []
  const counterparties = useMemo(() => {
    const copy = [...rows]
    if (sort === 'contracts') {
      copy.sort((a, b) => (b.contractCount ?? 0) - (a.contractCount ?? 0) || a.name.localeCompare(b.name))
    } else if (sort === 'activity') {
      const t = (c: Counterparty) => (c.lastContractAt ? new Date(c.lastContractAt).getTime() : 0)
      copy.sort((a, b) => t(b) - t(a) || a.name.localeCompare(b.name))
    } else {
      copy.sort((a, b) => a.name.localeCompare(b.name))
    }
    return copy
  }, [rows, sort])

  // The header printed `counterparties.length` as "N counterparties" — the
  // size of the fetched page, labelled as if it were the whole book, and the
  // size of the *filtered* set while a search was active.
  const truncated = rows.length >= PAGE_SIZE

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/counterparties/${id}`).then(r => r.data),
    onSuccess: () => {
      setDeleteError(null)
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['counterparties'] })
    },
    // Deletion used to fail in silence: the row stayed, nothing was said.
    onError: (e) => setDeleteError((e as Error)?.message ?? 'Could not delete that counterparty.'),
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-paper-200 bg-card">
        <div>
          <h1 className="text-title text-ink-950">Counterparties</h1>
          {/* The count now says which count it is. It used to read
              "52 counterparties" whether that was the whole book, a page cap,
              or a search result. */}
          <p className="text-dense text-ink-500 mt-0.5" data-testid="cp-count">
            {debounced ? (
              <>
                <span className="tabular-nums">{counterparties.length}</span>{' '}
                match{counterparties.length === 1 ? 'es' : ''} “{debounced}”
              </>
            ) : truncated ? (
              <>Showing the first <span className="tabular-nums">{counterparties.length}</span>. Search to narrow.</>
            ) : (
              <>
                <span className="tabular-nums">{counterparties.length}</span> counterpart{counterparties.length !== 1 ? 'ies' : 'y'}
              </>
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5">
          <Plus className="size-3.5" /> Add Counterparty
        </Button>
      </div>

      {/* Search + sort */}
      <div className="px-6 py-3 bg-card border-b border-paper-200 flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[14rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
          <Input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search counterparties by name"
            className="pl-9"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-dense text-ink-500">
          Sort
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            data-testid="cp-sort"
            className="h-8 text-[13px] text-ink-950 rounded-md border border-input bg-card px-2.5 focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
          >
            <option value="contracts">Most contracts</option>
            <option value="activity">Recently active</option>
            <option value="name">Name (A–Z)</option>
          </select>
        </label>
      </div>

      {deleteError && (
        <div
          role="alert"
          data-testid="cp-delete-error"
          className="mx-6 mt-3 flex items-start justify-between gap-3 rounded-md border border-risk-200 bg-risk-50 px-3 py-2 text-dense text-risk-900"
        >
          <span className="min-w-0 break-words">{deleteError}</span>
          <button type="button" onClick={() => setDeleteError(null)} className="shrink-0 font-semibold text-risk-700 hover:text-risk-900">
            Dismiss
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto bg-paper-50 p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 gap-2 text-ink-400 text-dense">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : counterparties.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title={debounced ? `No counterparties matching "${debounced}"` : 'No counterparties yet'}
            action={!debounced ? (
              <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1.5">
                <Plus className="size-3.5" /> Add your first counterparty
              </Button>
            ) : undefined}
          />
        ) : (
          <div className="bg-card rounded-card border border-paper-200 overflow-hidden">
            {/* Table header — B.6.9 adds Contracts + Last activity columns */}
            <div className="grid grid-cols-[minmax(0,2fr)_100px_140px_1fr_auto_20px] gap-4 px-5 py-2 border-b border-paper-200 bg-paper-50">
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">Name</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">Contracts</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">Last activity</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">Contact</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">Added</span>
              <span />
            </div>
            <div className="divide-y divide-paper-100">
              {counterparties.map(cp => {
                const count = cp.contractCount ?? 0
                return (
                  // P48 a11y — drop role/tabIndex on the wrapper to avoid
                  // nested-interactive when row contains kebab/buttons.
                  // Title is a <Link> for keyboard a11y; row remains
                  // mouse-clickable via the unscoped onClick.
                  <div
                    key={cp.id}
                    data-testid={`counterparty-row-${cp.id}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a, button')) return
                      navigate(`/counterparties/${cp.id}`)
                    }}
                    className="grid grid-cols-[minmax(0,2fr)_100px_140px_1fr_auto_20px] gap-4 items-center px-5 py-2 hover:bg-paper-50 cursor-pointer transition-colors group"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/counterparties/${cp.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-[13px] font-medium text-ink-950 truncate hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      >
                        {cp.name}
                      </Link>
                      {cp.legalName && cp.legalName !== cp.name && (
                        <p className="text-[11px] text-ink-400 truncate">{cp.legalName}</p>
                      )}
                    </div>

                    {/* Contract count — the headline metric */}
                    <div className="flex items-center gap-1.5">
                      <FileText className={`size-3.5 ${count > 0 ? 'text-ink-500' : 'text-ink-400'}`} />
                      <span className={`text-[13px] tabular-nums ${count > 0 ? 'font-medium text-ink-950' : 'text-ink-400'}`}>
                        {count}
                      </span>
                    </div>

                    {/* Last activity — relative time + kind. Showing the
                        verb ("comment", "share", "update") makes "today"
                        meaningful rather than every-row-the-same. */}
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11.5px] text-ink-700 tabular-nums">
                        {relativeDate(cp.lastContractAt)}
                      </span>
                      {cp.lastActivityKind && cp.lastContractAt && (
                        <span className="text-[9.5px] uppercase tracking-[0.09em] text-ink-400">
                          {cp.lastActivityKind === 'comment' ? 'comment'
                           : cp.lastActivityKind === 'share' ? 'share link'
                           : 'contract'}
                        </span>
                      )}
                    </div>

                    {/* Contact — collapsed into one cell: email OR website OR — */}
                    <div className="min-w-0">
                      {cp.email ? (
                        <a
                          href={`mailto:${cp.email}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[12.5px] text-ink-500 hover:text-ink-950 truncate block"
                        >
                          {cp.email}
                        </a>
                      ) : cp.website ? (
                        <a
                          href={cp.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 text-[12.5px] text-ink-700 hover:text-ink-950 hover:underline truncate"
                        >
                          {cp.website.replace(/^https?:\/\//, '')}
                          <ExternalLink className="size-3 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="text-[12.5px] text-ink-400">—</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-ink-400 whitespace-nowrap tabular-nums">
                        {new Date(cp.createdAt).toLocaleDateString()}
                      </span>
                      {/*
                        `opacity-0 group-hover:opacity-100` made this control
                        literally unreachable by keyboard — you could Tab to
                        it, but it stayed invisible while focused, so the only
                        feedback for "you are about to delete a company with
                        11 contracts" was silence. `focus-visible:opacity-100`
                        is the whole fix.

                        The native `confirm("Delete Acme Corporation?")` is
                        gone too: it named the row but not the consequence,
                        and this is the one destructive action on the page.
                      */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteError(null)
                          setConfirmDelete(cp)
                        }}
                        aria-label={`Delete ${cp.name}`}
                        data-testid={`counterparty-delete-${cp.id}`}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1 hover:bg-risk-50 rounded-md text-ink-400 hover:text-risk-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>

                    <ChevronRight className="size-3.5 text-paper-300 group-hover:text-ink-400 transition-colors" />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {showAdd && <AddCounterpartyModal onClose={() => setShowAdd(false)} />}

      {confirmDelete && (
        <DeleteCounterpartyDialog
          cp={confirmDelete}
          pending={remove.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove.mutate(confirmDelete.id)}
        />
      )}
    </div>
  )
}

/**
 * Deleting a counterparty is the only irreversible action on this page, and it
 * used to be a browser `confirm()` that said "Delete Acme Corporation?" — the
 * name, but never the stake. Acme has eleven contracts behind it.
 */
function DeleteCounterpartyDialog({
  cp, pending, onCancel, onConfirm,
}: {
  cp: Counterparty
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const count = cp.contractCount ?? 0
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, pending])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Delete ${cp.name}`}
        className="bg-card rounded-card shadow-e3 w-full max-w-sm mx-4"
        data-testid="cp-delete-dialog"
      >
        <div className="px-6 py-5">
          <h2 className="text-section text-ink-950">Delete {cp.name}?</h2>
          <p className="text-dense text-ink-500 mt-2">
            {count > 0 ? (
              <>
                This counterparty is on{' '}
                <span className="font-medium text-ink-950 tabular-nums">{count}</span>{' '}
                contract{count === 1 ? '' : 's'}. Those contracts stay, but they
                lose their link to this record, and the link cannot be restored
                from here.
              </>
            ) : (
              <>No contracts reference this counterparty. Removing it is clean.</>
            )}
          </p>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-paper-200">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending} autoFocus>Cancel</Button>
          <Button
            variant="danger" size="sm"
            onClick={onConfirm}
            disabled={pending}
            data-testid="cp-delete-confirm"
            className="gap-1.5"
          >
            {pending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting…</> : <><Trash2 className="size-3.5" /> Delete</>}
          </Button>
        </div>
      </div>
    </div>
  )
}
