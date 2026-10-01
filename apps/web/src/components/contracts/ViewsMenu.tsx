/**
 * ViewsMenu (docs/39 D3) — saved views of the contracts list.
 *
 * A useful list — "SOWs keeping things confidential for 3+ years, by value,
 * with those columns" — had to be rebuilt by hand every time, and couldn't be
 * handed to a colleague. Now it has a name: saved for oneself or shared with
 * everyone, opened from here, and updated when it changes.
 */
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Users } from 'lucide-react'
import type { ContractSort, FieldFilter } from '@clm/types'
import { api } from '@/lib/api'
import { Popover } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { cn } from '@/lib/utils'

/** The list's state a view holds. */
export interface ViewQuery {
  filters: Record<string, unknown>
  filterLabel?: string
  fieldFilters: FieldFilter[]
  columns: string[]
  sort: ContractSort | null
  q?: string
}

export interface SavedView { id: string; name: string; shared: boolean; mine: boolean; query: ViewQuery; updatedAt: string }

/** Two states the same list? Key order and empty values aside. */
export function sameQuery(a: ViewQuery, b: ViewQuery): boolean {
  const norm = (v: ViewQuery) => JSON.stringify({
    filters: Object.fromEntries(Object.entries(v.filters ?? {}).filter(([, x]) => x !== undefined && x !== '').sort(([k1], [k2]) => k1.localeCompare(k2))),
    fieldFilters: v.fieldFilters ?? [],
    columns: v.columns ?? [],
    sort: v.sort ?? null,
    q: v.q || '',
  })
  return norm(a) === norm(b)
}

const detail = (e: unknown) => (e as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Try again.'

/** The caller's views of the contracts list, and the shared ones. */
export function useSavedViews() {
  return useQuery({
    queryKey: ['saved-views', 'contracts'],
    queryFn: async () => (await api.get<{ views: SavedView[] }>('/saved-views', { params: { page: 'contracts' } })).data.views,
    staleTime: 30_000,
  })
}

export function ViewsMenu({ current, activeId, onOpen }: {
  current: ViewQuery
  activeId: string | null
  onOpen: (view: SavedView | null) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'list' | 'save' | 'rename'>('list')
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const { data: views = [] } = useSavedViews()
  const active = views.find(v => v.id === activeId) ?? null
  const edited = !!active && !sameQuery(active.query, current)
  // The whole list, narrowed or sorted: not "all contracts" any more (columns are only how it looks).
  const filtered = !active && !sameQuery({ filters: {}, fieldFilters: [], columns: current.columns, sort: null }, current)
  const mine = views.filter(v => v.mine)
  const others = views.filter(v => !v.mine)

  const refresh = () => qc.invalidateQueries({ queryKey: ['saved-views'] })
  const close = () => { setOpen(false); setMode('list') }
  const create = useMutation({
    mutationFn: async () => (await api.post<{ view: SavedView }>('/saved-views', { name: name.trim(), shared, page: 'contracts', query: current })).data.view,
    onSuccess: view => { refresh(); onOpen(view); close(); toast.success(`Saved “${view.name}”`, view.shared ? { description: 'Everyone in your organisation can open it.' } : undefined) },
    onError: err => toast.error("Couldn't save the view", { description: detail(err) }),
  })
  const update = useMutation({
    mutationFn: async (patch: Partial<{ name: string; shared: boolean; query: ViewQuery }>) =>
      (await api.patch<{ view: SavedView }>(`/saved-views/${activeId}`, patch)).data.view,
    onSuccess: (view, patch) => {
      refresh()
      if (patch.name) setMode('list')
      toast.success(patch.query ? `Updated “${view.name}”` : patch.shared !== undefined ? (view.shared ? `“${view.name}” is shared with everyone` : `“${view.name}” is just yours now`) : `Renamed to “${view.name}”`)
    },
    onError: err => toast.error("Couldn't change the view", { description: detail(err) }),
  })
  const remove = useMutation({
    mutationFn: async () => { await api.delete(`/saved-views/${activeId}`) },
    onSuccess: () => { const n = active?.name; refresh(); onOpen(null); close(); toast.success(`Deleted “${n}”`) },
    onError: err => toast.error("Couldn't delete the view", { description: detail(err) }),
  })

  const label = active ? active.name : 'All contracts'
  const item = (v: SavedView) => (
    <button
      key={v.id} type="button" onClick={() => { onOpen(v); close() }}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-950 hover:bg-paper-100"
      data-testid={`view-${v.id}`}
    >
      <Check className={cn('size-3.5 shrink-0', v.id === activeId ? 'text-ink-950' : 'invisible')} />
      <span className="truncate">{v.name}</span>
      {v.shared && v.mine && <Users className="ml-auto size-3 shrink-0 text-ink-400" aria-label="Shared with everyone" />}
    </button>
  )
  const canSave = useMemo(() => name.trim().length > 0, [name])

  return (
    <>
      <button
        ref={anchorRef} type="button" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}
        className="inline-flex items-center gap-1 h-7 px-2 -ml-2 rounded-md text-[13px] text-ink-700 hover:bg-paper-100 hover:text-ink-950"
        data-testid="views-menu"
      >
        <span className="max-w-[16rem] truncate font-medium">{label}</span>
        {edited && <span className="text-[11px] font-normal text-attention-700">· edited</span>}
        {filtered && <span className="text-[11px] font-normal text-ink-500">· filtered</span>}
        <ChevronDown className="size-3.5 text-ink-400" />
      </button>
      <Popover open={open} onClose={close} anchor={anchorRef.current} label="Saved views" width={280}>
        {mode === 'list' ? (
          <div className="py-1">
            <button type="button" onClick={() => { onOpen(null); close() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-950 hover:bg-paper-100">
              <Check className={cn('size-3.5 shrink-0', activeId || filtered ? 'invisible' : 'text-ink-950')} />
              All contracts
            </button>
            {mine.length > 0 && <p className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-400">Your views</p>}
            {mine.map(item)}
            {others.length > 0 && <p className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-400">Shared with everyone</p>}
            {others.map(item)}
            <div className="mt-1 border-t border-paper-100 pt-1">
              {active && edited && active.mine && (
                <button type="button" disabled={update.isPending} onClick={() => update.mutate({ query: current })} className="w-full px-3 py-1.5 text-left text-[12.5px] font-medium text-ink-950 hover:bg-paper-100" data-testid="view-update">
                  Save changes to “{active.name}”
                </button>
              )}
              <button type="button" onClick={() => { setName(''); setShared(false); setMode('save') }} className="w-full px-3 py-1.5 text-left text-[12.5px] text-ink-950 hover:bg-paper-100" data-testid="view-save-new">
                Save as a new view…
              </button>
              {active?.mine && (
                <>
                  <button type="button" onClick={() => { setName(active.name); setMode('rename') }} className="w-full px-3 py-1.5 text-left text-[12.5px] text-ink-700 hover:bg-paper-100">Rename</button>
                  <button type="button" disabled={update.isPending} onClick={() => update.mutate({ shared: !active.shared })} className="w-full px-3 py-1.5 text-left text-[12.5px] text-ink-700 hover:bg-paper-100">
                    {active.shared ? 'Stop sharing' : 'Share with everyone'}
                  </button>
                  <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()} className="w-full px-3 py-1.5 text-left text-[12.5px] text-risk-700 hover:bg-risk-50">Delete view</button>
                </>
              )}
            </div>
          </div>
        ) : (
          <form className="p-3 space-y-2.5" onSubmit={e => { e.preventDefault(); if (!canSave) return; mode === 'save' ? create.mutate() : update.mutate({ name: name.trim() }) }}>
            <label className="block">
              <span className="text-[11.5px] font-semibold text-ink-950">{mode === 'save' ? 'Name this view' : 'Rename the view'}</span>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="e.g. SOWs with long confidentiality"
                className="mt-1 h-8 w-full rounded-md border border-input bg-card px-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ink-950" data-testid="view-name" />
            </label>
            {mode === 'save' && (
              <label className="flex items-center gap-2 text-[12px] text-ink-700">
                <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
                Share with everyone in your organisation
              </label>
            )}
            {mode === 'save' && <p className="text-[11px] text-ink-500">Keeps the filters, field filters, columns, sort and search as they are now.</p>}
            <div className="flex justify-end gap-1.5">
              <Button type="button" size="xs" variant="ghost" onClick={() => setMode('list')}>Back</Button>
              <Button type="submit" size="xs" disabled={!canSave || create.isPending || update.isPending} data-testid="view-save">
                {mode === 'save' ? 'Save view' : 'Rename'}
              </Button>
            </div>
          </form>
        )}
      </Popover>
    </>
  )
}
