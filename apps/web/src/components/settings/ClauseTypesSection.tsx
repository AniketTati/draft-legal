/**
 * ClauseTypesSection (docs/39 E3) — clause types the organization teaches
 * the AI.
 *
 * The AI finds some forty kinds of clause. One a team cares about that isn't
 * among them — data residency, use of AI, most-favoured pricing — was never
 * found. Here it is added once: a name, what it is, and passages that are one.
 * "Try it on a contract" shows what the AI finds before anything is saved; the
 * contracts read after find it as they're read, and "Find it in all contracts"
 * reads those read before.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, ChevronDown, Loader2, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { useClauseTypes, clauseTypesKey, type ClauseTypeOption, type DetectState } from '@/lib/clause-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/common/Toaster'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

const EXAMPLES_MAX = 20

function detail(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? 'Unknown error'
}

interface Draft { label: string; description: string; examples: string[] }
const EMPTY: Draft = { label: '', description: '', examples: [''] }

export function ClauseTypesSection() {
  const qc = useQueryClient()
  const canConfigure = useCanRequest('POST /clause-types')
  const { types, custom } = useClauseTypes()
  const builtIn = useMemo(() => types.filter(t => !t.custom), [types])
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [trying, setTrying] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ClauseTypeOption | null>(null)
  const [showBuiltIn, setShowBuiltIn] = useState(false)

  // A run finding a type in earlier contracts: its progress, while it goes.
  const running = custom.some(t => t.detect?.status === 'RUNNING' || t.detect?.status === 'QUEUED')
  useQuery({
    queryKey: [...clauseTypesKey, 'poll'],
    queryFn: async () => { await qc.invalidateQueries({ queryKey: clauseTypesKey, exact: true }); return Date.now() },
    enabled: running,
    refetchInterval: 3000,
  })

  const save = useMutation({
    mutationFn: async (e: { id: string | null; draft: Draft }) => {
      const body = { label: e.draft.label.trim(), description: e.draft.description.trim(), examples: e.draft.examples.map(x => x.trim()).filter(Boolean) }
      return e.id ? (await api.patch(`/clause-types/${e.id}`, body)).data : (await api.post('/clause-types', body)).data
    },
    onSuccess: (_d, e) => {
      toast.success(e.id ? 'Clause type saved' : `“${e.draft.label.trim()}” added`, e.id ? undefined : { description: 'Contracts read from now on are searched for it. Find it in the ones read before when you’re ready.' })
      setEditing(null)
      qc.invalidateQueries({ queryKey: clauseTypesKey })
    },
    onError: e => toast.error('Couldn’t save the clause type', { description: detail(e) }),
  })
  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/clause-types/${id}`),
    onSuccess: () => { toast.success('Clause type removed', { description: 'Clauses already found keep their type.' }); qc.invalidateQueries({ queryKey: clauseTypesKey }) },
    onError: e => toast.error('Couldn’t remove it', { description: detail(e) }),
  })
  const detect = useMutation({
    mutationFn: async (id: string) => (await api.post(`/clause-types/${id}/detect`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: clauseTypesKey }),
    onError: e => toast.error('Couldn’t start looking', { description: detail(e) }),
  })

  return (
    <section className="space-y-4" data-testid="clause-types-section">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-section text-ink-950 flex items-center gap-2"><BookMarked className="size-4 text-ink-500" /> Clause types</h2>
          <p className="text-body text-ink-500 mt-1 max-w-2xl">
            The AI finds {builtIn.length} kinds of clause in every contract. Add one your team cares about that it doesn’t know:
            say what it is and paste passages that are one. Contracts read from then on are searched for it, and you can
            search the ones read before.
          </p>
        </div>
        {canConfigure && !editing && (
          <Button size="sm" onClick={() => setEditing({ id: null, draft: { ...EMPTY } })} data-testid="clause-type-add">
            <Plus className="size-3.5" /> Add a clause type
          </Button>
        )}
      </div>

      {editing && (
        <ClauseTypeForm
          draft={editing.draft}
          isNew={!editing.id}
          saving={save.isPending}
          onChange={draft => setEditing({ ...editing, draft })}
          onCancel={() => setEditing(null)}
          onSave={() => save.mutate(editing)}
        />
      )}

      {custom.length === 0 && !editing ? (
        <p className="text-body text-ink-400 italic" data-testid="clause-types-empty">Your organization hasn’t added any clause types yet.</p>
      ) : (
        <ul className="space-y-2">
          {custom.map(t => (
            <li key={t.key} className="bg-card rounded-card border border-paper-200 p-4" data-testid={`clause-type-${t.key}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body font-semibold text-ink-950">{t.label}</div>
                  {t.description && <p className="text-dense text-ink-700 mt-0.5">{t.description}</p>}
                  <p className="text-[11.5px] text-ink-500 mt-1">
                    {(t.examples?.length ?? 0) === 0 ? 'No examples' : `${t.examples!.length} example${t.examples!.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                {canConfigure && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="xs" variant="ghost" onClick={() => setTrying(trying === t.id ? null : t.id!)} data-testid={`clause-type-try-${t.key}`}>
                      <Search className="size-3.5" /> Try it on a contract
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditing({ id: t.id!, draft: { label: t.label, description: t.description ?? '', examples: t.examples?.length ? [...t.examples] : [''] } })}>
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setDeleting(t)} aria-label={`Remove ${t.label}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              <DetectLine detect={t.detect ?? null} canRun={canConfigure} busy={detect.isPending} onRun={() => detect.mutate(t.id!)} keyName={t.key} />
              {trying === t.id && <TryOnContract type={t} onClose={() => setTrying(null)} />}
            </li>
          ))}
        </ul>
      )}

      <div>
        <button type="button" onClick={() => setShowBuiltIn(s => !s)} className="inline-flex items-center gap-1 text-dense text-ink-500 hover:text-ink-950" aria-expanded={showBuiltIn}>
          <ChevronDown className={`size-3.5 transition-transform ${showBuiltIn ? '' : '-rotate-90'}`} /> The {builtIn.length} kinds the AI already finds
        </button>
        {showBuiltIn && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {builtIn.map(t => <span key={t.key} className="rounded-full border border-paper-200 bg-paper-50 px-2 py-0.5 text-[11.5px] text-ink-700">{t.label}</span>)}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleting != null}
        testId="clause-type-delete-confirm"
        title={`Remove “${deleting?.label ?? ''}”?`}
        body="The AI stops looking for it. Clauses it already found keep their type."
        confirmLabel="Remove"
        tone="destructive"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting?.id) remove.mutate(deleting.id); setDeleting(null) }}
      />
    </section>
  )
}

function ClauseTypeForm({ draft, isNew, saving, onChange, onCancel, onSave }: {
  draft: Draft; isNew: boolean; saving: boolean
  onChange: (d: Draft) => void; onCancel: () => void; onSave: () => void
}) {
  const examples = draft.examples
  const ready = draft.label.trim().length >= 2 && examples.every(e => !e.trim() || e.trim().length >= 12)
  return (
    <div className="bg-card rounded-card border border-paper-200 p-4 space-y-3" data-testid="clause-type-form">
      <div className="space-y-1">
        <Label htmlFor="ct-label">Name</Label>
        <Input id="ct-label" value={draft.label} maxLength={80} placeholder="e.g. Data residency" onChange={e => onChange({ ...draft, label: e.target.value })} data-testid="clause-type-label" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ct-description">What it is</Label>
        <textarea
          id="ct-description" rows={2} maxLength={1000} value={draft.description}
          placeholder="e.g. Where the supplier may store or process our data, and what it needs to move it elsewhere."
          onChange={e => onChange({ ...draft, description: e.target.value })}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-body" data-testid="clause-type-description"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Examples <span className="font-normal text-ink-500">— passages from contracts that are this clause ({examples.filter(e => e.trim()).length} of up to {EXAMPLES_MAX})</span></Label>
        {examples.map((ex, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <textarea
              rows={2} value={ex} maxLength={2000} placeholder="Paste a passage that is one"
              onChange={e => onChange({ ...draft, examples: examples.map((x, j) => (j === i ? e.target.value : x)) })}
              className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-dense font-serif" data-testid={`clause-type-example-${i}`}
            />
            {examples.length > 1 && (
              <button type="button" onClick={() => onChange({ ...draft, examples: examples.filter((_, j) => j !== i) })} className="mt-2 p-1 text-ink-400 hover:text-ink-950" aria-label="Remove this example">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {examples.length < EXAMPLES_MAX && (
          <button type="button" onClick={() => onChange({ ...draft, examples: [...examples, ''] })} className="inline-flex items-center gap-1 text-dense text-ink-700 hover:text-ink-950" data-testid="clause-type-add-example">
            <Plus className="size-3.5" /> Add an example
          </button>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={onSave} disabled={!ready || saving} data-testid="clause-type-save">
          {saving && <Loader2 className="size-3.5 animate-spin" />} {isNew ? 'Add clause type' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function DetectLine({ detect, canRun, busy, onRun, keyName }: { detect: DetectState | null; canRun: boolean; busy: boolean; onRun: () => void; keyName: string }) {
  const of = (d: DetectState) => `${d.processed.toLocaleString()} of ${d.total.toLocaleString()}`
  let text: React.ReactNode
  let action: string | null = null
  if (!detect) { text = 'Not looked for in contracts read before it was added.'; action = 'Find it in all contracts' }
  else if (detect.status === 'QUEUED' || detect.status === 'RUNNING') text = <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Looking in earlier contracts… {detect.total ? of(detect) : ''}{detect.found ? ` · found in ${detect.found}` : ''}</span>
  else if (detect.status === 'DONE') { text = `Found in ${detect.found.toLocaleString()} of the ${detect.total.toLocaleString()} contracts read before.`; action = 'Look again' }
  else if (detect.status === 'PAUSED') { text = `Paused at ${of(detect)}: ${detect.error ?? 'today’s AI budget is used up'}.`; action = 'Go on' }
  else { text = `Stopped: ${detect.error ?? 'something went wrong'}.`; action = 'Try again' }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-500" data-testid={`clause-type-detect-${keyName}`}>
      <span>{text}</span>
      {action && canRun && (
        <button type="button" onClick={onRun} disabled={busy} className="font-medium text-ink-950 hover:underline underline-offset-2 disabled:opacity-50" data-testid={`clause-type-detect-run-${keyName}`}>{action}</button>
      )}
    </div>
  )
}

interface Found { content: string; sectionRef: string | null; interpretation: string | null }

function TryOnContract({ type, onClose }: { type: ClauseTypeOption; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null)
  const [debounced, setDebounced] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const { data: contracts = [] } = useQuery({
    queryKey: ['contracts-search', debounced],
    queryFn: () => api.get('/contracts', { params: { search: debounced, limit: 6 } }).then(r => {
      const list = r.data?.data ?? r.data ?? []
      return (Array.isArray(list) ? list : []) as Array<{ id: string; title: string }>
    }),
    enabled: !picked && debounced.length >= 2,
    staleTime: 5000,
  })
  const preview = useMutation({
    mutationFn: async (contractId: string) => (await api.post<{ clauses: Found[] }>(`/clause-types/${type.id}/preview`, { contractId })).data.clauses,
  })
  const pick = (c: { id: string; title: string }) => { setPicked(c); preview.mutate(c.id) }
  return (
    <div className="mt-3 rounded-md border border-assist-200 bg-assist-50 p-3 space-y-2" data-testid={`clause-type-tryout-${type.key}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-dense text-assist-900 inline-flex items-center gap-1.5"><Sparkles className="size-3.5" /> Try “{type.label}” on a contract — nothing is saved.</p>
        <button type="button" onClick={onClose} className="p-1 text-ink-400 hover:text-ink-950" aria-label="Close"><X className="size-3.5" /></button>
      </div>
      {!picked ? (
        <>
          <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a contract by name or counterparty" data-testid="clause-type-tryout-search" />
          {contracts.length > 0 && (
            <ul className="rounded-md border border-paper-200 bg-card divide-y divide-paper-200">
              {contracts.map(c => (
                <li key={c.id}><button type="button" onClick={() => pick(c)} className="w-full text-left px-3 py-1.5 text-dense text-ink-950 hover:bg-paper-100">{c.title}</button></li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-dense text-ink-700">
            <span className="truncate">In <span className="font-medium text-ink-950">{picked.title}</span></span>
            <button type="button" onClick={() => { setPicked(null); preview.reset() }} className="text-ink-500 hover:text-ink-950 underline underline-offset-2">Another contract</button>
          </div>
          {preview.isPending ? (
            <p className="text-dense text-ink-500 inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Reading it…</p>
          ) : preview.isError ? (
            <p className="text-dense text-risk-700">{detail(preview.error)}</p>
          ) : preview.data && preview.data.length === 0 ? (
            <p className="text-dense text-ink-700" data-testid="clause-type-tryout-none">The AI finds no {type.label.toLowerCase()} clause in it. If it has one, add it as an example.</p>
          ) : (
            <ul className="space-y-2" data-testid="clause-type-tryout-found">
              {(preview.data ?? []).map((c, i) => (
                <li key={i} className="rounded-md border border-paper-200 bg-card p-2.5">
                  {c.sectionRef && <div className="text-[11px] font-mono text-ink-400 mb-0.5">{c.sectionRef}</div>}
                  <p className="text-dense font-serif text-ink-950 line-clamp-4">“{c.content}”</p>
                  {c.interpretation && <p className="text-[11.5px] text-ink-500 mt-1">{c.interpretation}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
