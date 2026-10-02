/**
 * AgreementPanel (docs/39 G3) — a contract and the agreement it amends.
 *
 * An amendment's terms never reached the agreement: an MSA extended by
 * Amendment No. 1 still showed, and alerted on, its old end date, and an
 * amendment uploaded without picking its parent couldn't be linked after.
 *
 *   - Linked: the agreement's terms this one changes, the agreement's value
 *     beside its own; a person ticks the ones it really changes and sets them
 *     on the agreement (marked Amended there, naming this contract), with an
 *     undo.
 *   - Not linked, but it reads as an amendment, SOW or order form, or an
 *     agreement matches (same counterparty, named in its text, its date
 *     mentioned): link it in one click, or find another.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, CheckCircle2, Loader2, Search, Undo2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'
import { RailSection } from './RailSection'

type Relationship = 'amendment' | 'sow' | 'order_form' | 'renewal' | 'exhibit'

interface Change {
  key: string
  label: string
  parent: { display: string }
  amendment: { display: string; quote: string | null }
  applied: boolean
}

interface ChangesResponse {
  parent: { id: string; title: string } | null
  relationshipType: Relationship | null
  changes: Change[]
  /** docs/41 Part 13 — the agreement's obligations from the sections this one replaces. */
  obligations?: Array<{ id: string; description: string; quote: string; sectionRef: string | null; superseded: boolean }>
  /** The latest roll-up from this contract that can still be undone. */
  lastRun?: { id: string; createdAt: string; count: number } | null
}

interface Suggestion { id: string; title: string; type: string; effectiveDate: string | null; reasons: string[] }
interface SuggestionsResponse { looksLike: Relationship | null; suggestions: Suggestion[] }

const READS_AS: Record<Relationship, string> = {
  amendment: 'an amendment', sow: 'a statement of work', order_form: 'an order form', renewal: 'a renewal', exhibit: 'an exhibit',
}
const LINK_AS: Record<Relationship, string> = {
  amendment: 'amendment', sow: 'SOW', order_form: 'order form', renewal: 'renewal', exhibit: 'exhibit',
}

function detail(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? 'Unknown error'
}

export function AgreementPanel({ contractId, canEdit }: { contractId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const canLink = useCanRequest('PUT /contracts/:id/parent')
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [dropping, setDropping] = useState<Set<string> | null>(null)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')

  const changesKey = ['amendment-changes', contractId]
  const { data: family } = useQuery({
    queryKey: changesKey,
    queryFn: async () => (await api.get<ChangesResponse>(`/contracts/${contractId}/amendment-changes`)).data,
  })
  const linked = !!family?.parent
  const { data: offer } = useQuery({
    queryKey: ['parent-suggestions', contractId],
    queryFn: async () => (await api.get<SuggestionsResponse>(`/contracts/${contractId}/parent-suggestions`)).data,
    enabled: !!family && !linked,
  })
  const { data: found = [] } = useQuery({
    queryKey: ['contracts-search', q],
    queryFn: () => api.get('/contracts', { params: { search: q, limit: 8 } }).then(r => {
      const list = r.data?.data ?? r.data ?? []
      return (Array.isArray(list) ? list : []).filter((c: { id: string }) => c.id !== contractId) as Array<{ id: string; title: string; type: string }>
    }),
    enabled: searching && q.trim().length >= 2,
    staleTime: 5000,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: changesKey })
    qc.invalidateQueries({ queryKey: ['parent-suggestions', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-family'] })
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
  }

  const link = useMutation({
    mutationFn: async (a: { parentId: string; title: string; as: Relationship }) =>
      (await api.put(`/contracts/${contractId}/parent`, { parentContractId: a.parentId, relationshipType: a.as })).data,
    onSuccess: (_r, a) => { setSearching(false); setQ(''); refresh(); toast.success(`Linked as ${READS_AS[a.as]} of ${a.title}`) },
    onError: e => toast.error("Couldn't link it", { description: detail(e) }),
  })

  const apply = useMutation({
    mutationFn: async (a: { keys: string[]; obligations: string[] }) => (await api.post<{ parent: { id: string; title: string }; applied: string[]; runId: string | null; superseded: number }>(
      `/contracts/${contractId}/amendment-changes/apply`, { keys: a.keys, supersedeObligationIds: a.obligations.length ? a.obligations : undefined },
    )).data,
    onSuccess: r => {
      setPicked(null); setDropping(null)
      qc.invalidateQueries({ queryKey: ['contract-term-history', r.parent.id] })
      qc.invalidateQueries({ queryKey: ['obligations'] })
      refresh()
      qc.invalidateQueries({ queryKey: ['contract-fields', r.parent.id] })
    },
    onError: e => toast.error("Couldn't set them on the agreement", { description: detail(e) }),
  })

  const undo = useMutation({
    mutationFn: async (runId: string) => (await api.post<{ restored: number; skipped: number }>(`/field-runs/${runId}/undo`)).data,
    onSuccess: r => {
      refresh()
      toast.success(`Put back ${r.restored} term${r.restored === 1 ? '' : 's'} on the agreement`, { description: r.skipped ? `${r.skipped} changed since, so left as they are.` : undefined })
    },
    onError: e => toast.error("Couldn't undo", { description: detail(e) }),
  })

  if (!family) return null

  // ── Linked: the terms it changes ──
  if (family.parent) {
    const pending = family.changes.filter(c => !c.applied)
    const chosen = picked ?? new Set(pending.map(c => c.key))
    const toggle = (key: string) => setPicked(() => {
      const next = new Set(chosen)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
    const rel = (family.relationshipType && LINK_AS[family.relationshipType]) || 'related contract'
    const owed = (family.obligations ?? []).filter(o => !o.superseded)
    const dropped = dropping ?? new Set(owed.map(o => o.id))
    const toggleDrop = (id: string) => setDropping(() => {
      const next = new Set(dropped)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    return (
      <RailSection title="Changes to the agreement" count={pending.length || null} defaultOpen={pending.length > 0 || !!family.lastRun}>
        <div className="space-y-2.5" data-testid="agreement-panel">
          <p className="text-[12px] text-ink-700">
            This {rel} changes{' '}
            <Link to={`/contracts/${family.parent.id}`} className="font-medium text-ink-950 hover:underline underline-offset-2">{family.parent.title}</Link>.
            {family.changes.length === 0 && ' None of its terms differ from the agreement’s.'}
          </p>
          {family.changes.length > 0 && (
            <ul className="divide-y divide-paper-100 border border-paper-200 rounded-md">
              {family.changes.map(c => (
                <li key={c.key} className="px-2.5 py-2 flex items-start gap-2" data-testid={`agreement-change-${c.key}`}>
                  {c.applied ? (
                    <CheckCircle2 className="size-3.5 mt-0.5 text-brand-700 shrink-0" aria-label="On the agreement" />
                  ) : (
                    <input
                      type="checkbox" className="mt-0.5 accent-ink-950" checked={chosen.has(c.key)} disabled={!canEdit}
                      onChange={() => toggle(c.key)} aria-label={`Set ${c.label} on the agreement`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-ink-950">{c.label}</p>
                    <p className="text-[11.5px] text-ink-700 flex items-center gap-1 flex-wrap" title={c.amendment.quote ? `“${c.amendment.quote}”` : undefined}>
                      {!c.applied && (
                        <>
                          <span className="line-through decoration-ink-300 text-ink-500">{c.parent.display || 'not set'}</span>
                          <ArrowRight className="size-3 text-ink-400" />
                        </>
                      )}
                      <span className="font-medium">{c.amendment.display}</span>
                      {c.applied && <span className="text-brand-700">· on the agreement</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(family.obligations ?? []).length > 0 && (
            <div data-testid="agreement-obligations">
              <p className="text-[12px] font-medium text-ink-950 mb-1">Obligations from the sections it replaces</p>
              <ul className="divide-y divide-paper-100 border border-paper-200 rounded-md">
                {(family.obligations ?? []).map(o => (
                  <li key={o.id} className="px-2.5 py-2 flex items-start gap-2">
                    {o.superseded ? (
                      <CheckCircle2 className="size-3.5 mt-0.5 text-ink-400 shrink-0" aria-label="No longer owed" />
                    ) : (
                      <input type="checkbox" className="mt-0.5 accent-ink-950" checked={dropped.has(o.id)} disabled={!canEdit}
                        onChange={() => toggleDrop(o.id)} aria-label={`Mark ${o.description} as no longer owed`} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-ink-950">{o.description}{o.superseded && <span className="text-ink-500"> · no longer owed</span>}</p>
                      <p className="text-[11px] text-ink-500 line-clamp-2" title={o.quote}>{o.sectionRef ? `§${o.sectionRef.replace(/^(section|§)\s*/i, '')} · ` : ''}“{o.quote}”</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canEdit && (pending.length > 0 || owed.length > 0) && (
            <>
              <p className="text-[11px] text-ink-500">Tick what it changes. The agreement keeps them, marked as amended, and its original values stay one click away. Ticked obligations are kept on record but no longer owed.</p>
              <div className="flex justify-end">
                <Button size="xs" disabled={(!chosen.size && !dropped.size) || apply.isPending}
                  onClick={() => apply.mutate({ keys: [...chosen], obligations: [...dropped] })} data-testid="agreement-apply">
                  {apply.isPending ? <Loader2 className="animate-spin" /> : <Check />} Confirm on the agreement
                </Button>
              </div>
            </>
          )}
          {family.lastRun && (
            <div className="flex items-center gap-2 rounded-md bg-paper-50 border border-paper-200 px-2.5 py-1.5" data-testid="agreement-applied">
              <p className="text-[11.5px] text-ink-700 flex-1">
                Set {family.lastRun.count} term{family.lastRun.count === 1 ? '' : 's'} on the agreement{' '}
                <span className="text-ink-500">{new Date(family.lastRun.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>.
              </p>
              {canEdit && (
                <Button size="xs" variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate(family.lastRun!.id)} data-testid="agreement-undo">
                  {undo.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
                </Button>
              )}
            </div>
          )}
        </div>
      </RailSection>
    )
  }

  // ── Not linked: the agreement it may belong to ──
  if (!offer || (!offer.looksLike && !offer.suggestions.length)) return null
  const as: Relationship = offer.looksLike ?? 'amendment'
  return (
    <RailSection title="Part of an agreement?" defaultOpen>
      <div className="space-y-2.5" data-testid="agreement-suggestions">
        <p className="text-[12px] text-ink-700">
          {offer.looksLike ? `This reads as ${READS_AS[offer.looksLike]}.` : 'This may belong to another agreement.'}
          {offer.suggestions.length ? ' Is it part of:' : ' Link it to its agreement, so its terms can be set there.'}
        </p>
        {offer.suggestions.map(s => (
          <div key={s.id} className="rounded-md border border-paper-200 px-2.5 py-2 space-y-1.5" data-testid="agreement-suggestion">
            <div className="min-w-0">
              <Link to={`/contracts/${s.id}`} className="text-[12px] font-medium text-ink-950 hover:underline underline-offset-2">{s.title}</Link>
              <ul className="mt-0.5 space-y-px">
                {s.reasons.map(r => <li key={r} className="text-[11px] text-ink-500">· {r}</li>)}
              </ul>
            </div>
            {canLink && (
              <Button size="xs" variant="outline" disabled={link.isPending} onClick={() => link.mutate({ parentId: s.id, title: s.title, as })} data-testid="agreement-link">
                Link as {LINK_AS[as]}
              </Button>
            )}
          </div>
        ))}
        {canLink && (searching ? (
          <div className="space-y-1.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-400" />
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Find the agreement…" className="pl-8 h-8" autoFocus data-testid="agreement-search" />
            </div>
            {found.map(c => (
              <button
                key={c.id} type="button"
                className="w-full text-left rounded-md px-2.5 py-1.5 text-[12px] text-ink-950 hover:bg-paper-100 flex items-center gap-2"
                onClick={() => link.mutate({ parentId: c.id, title: c.title, as })}
              >
                <span className="truncate flex-1">{c.title}</span>
                <span className="text-[10.5px] text-ink-400">{c.type.replace(/_/g, ' ')}</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="text-[11.5px] text-ink-500 hover:text-ink-950 underline-offset-2 hover:underline" onClick={() => setSearching(true)} data-testid="agreement-find">
            {offer.suggestions.length ? 'Another agreement…' : 'Find its agreement…'}
          </button>
        ))}
      </div>
    </RailSection>
  )
}
