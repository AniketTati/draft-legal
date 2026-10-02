/**
 * docs/41 Part 1 — clause families on the Clauses page.
 *
 * A family is one clause with approved alternatives (Governing law: New York,
 * England and Wales…). Each alternative says when it is used (a rule on the
 * request), which names a request may call it by, and one can be the
 * default. Drafting picks one by those rules, never by guessing; with no rule
 * and no default, the draft asks. Editing an alternative's words keeps the
 * old version: a published template keeps using the version it was
 * published with until it is published again.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, Layers, Loader2, Plus, Star } from 'lucide-react'
import { CONDITION_KEYS, SLOT_DECIDED_BY_LABEL, describeCondition, type ClauseCondition, type SlotDecision } from '@clm/types'
import { api, apiErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { sanitizeHtml } from '@/lib/sanitize'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip, EmptyState, Eyebrow } from '@/components/ui/primitives'
import { ContractEditor } from '@/components/editor/ContractEditor'
import { ConditionBuilder, conditionOf, rowsOf, type ConditionRow } from './ConditionBuilder'

export interface FamilyVariant {
  id: string
  title: string
  variantLabel: string | null
  content: string
  condition: ClauseCondition | null
  matchValues: string[]
  isFamilyDefault: boolean
  isApproved: boolean
  variantOrder: number
  version: number
}

export interface ClauseFamily {
  id: string
  name: string
  description: string | null
  requestKey: string | null
  category: { id: string; name: string } | null
  variants: FamilyVariant[]
  templateCount: number
}

const labelOf = (v: FamilyVariant) => v.variantLabel || v.title

export function useClauseFamilies() {
  return useQuery({
    queryKey: ['clause-families'],
    queryFn: () => api.get<{ data: ClauseFamily[] }>('/clause-families').then(r => r.data.data),
  })
}

// ─── One variant: its words, rule, names, default, versions ─────────────────

function VariantEditor({ family, variant, onDone }: { family: ClauseFamily; variant?: FamilyVariant; onDone: () => void }) {
  const qc = useQueryClient()
  const initial = rowsOf(variant?.condition)
  const [label, setLabel] = useState(variant ? labelOf(variant) : '')
  const [content, setContent] = useState(variant?.content ?? '')
  const [names, setNames] = useState((variant?.matchValues ?? []).join(', '))
  const [join, setJoin] = useState(initial.join)
  const [rows, setRows] = useState<ConditionRow[]>(initial.rows)
  const [approved, setApproved] = useState(variant?.isApproved ?? true)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    meta: { errorHandled: true },
    mutationFn: () => {
      const body = {
        variantLabel: label.trim(),
        content,
        condition: conditionOf(join, rows),
        matchValues: names.split(',').map(n => n.trim()).filter(Boolean),
        isApproved: approved,
        ...(note.trim() && { changeNote: note.trim() }),
      }
      return variant
        ? api.patch(`/clause-families/${family.id}/variants/${variant.id}`, body)
        : api.post(`/clause-families/${family.id}/variants`, body)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['clause-families'] }); qc.invalidateQueries({ queryKey: ['clauses'] }); onDone() },
    onError: e => setError(apiErrorMessage(e)),
  })
  return (
    <div className="border border-paper-200 rounded-card p-3 space-y-3 bg-paper-50" data-testid="variant-editor">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] font-medium text-ink-700 mb-1 block">Name of this option</label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. New York" data-testid="variant-label-input" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-ink-700 mb-1 block">A request may also call it</label>
          <Input value={names} onChange={e => setNames(e.target.value)} placeholder="e.g. NY, State of New York" />
        </div>
      </div>
      <div>
        <label className="text-[11px] font-medium text-ink-700 mb-1 block">Wording</label>
        <div className="h-48 border border-paper-200 rounded-md bg-card overflow-hidden">
          <ContractEditor initialContent={content} onChange={setContent} />
        </div>
      </div>
      <div>
        <label className="text-[11px] font-medium text-ink-700 mb-1 block">Use it when</label>
        <ConditionBuilder join={join} rows={rows} onChange={(j, r) => { setJoin(j); setRows(r) }} />
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-dense text-ink-700">
          <input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} className="accent-ink-950" />
          Approved for drafting
        </label>
        {variant && <Input value={note} onChange={e => setNote(e.target.value)} placeholder="What changed (kept with the new version)" className="flex-1 h-8 text-[12px]" />}
      </div>
      {error && <p role="alert" className="text-dense text-risk-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="xs" onClick={onDone}>Cancel</Button>
        <Button size="xs" onClick={() => save.mutate()} disabled={save.isPending || !label.trim() || !content.trim()} data-testid="variant-save-btn">
          {save.isPending && <Loader2 className="animate-spin" />} {variant ? 'Save as a new version' : 'Add option'}
        </Button>
      </div>
    </div>
  )
}

function VersionHistory({ itemId }: { itemId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['clause-versions', itemId],
    queryFn: () => api.get<{ current: number; data: Array<{ id: string; version: number; content: string; note: string | null; createdAt: string }> }>(`/clauses/${itemId}/versions`).then(r => r.data),
  })
  if (isLoading) return <Loader2 className="size-4 animate-spin text-ink-400" />
  return (
    <ol className="space-y-2 mt-2" data-testid={`variant-history-${itemId}`}>
      {(data?.data ?? []).map(v => (
        <li key={v.id} className="border-l-2 border-paper-200 pl-2.5">
          <p className="text-[11px] text-ink-500 tabular-nums">
            Version {v.version}{v.version === data?.current ? ' (current)' : ''} · {new Date(v.createdAt).toLocaleDateString()}{v.note ? ` · ${v.note}` : ''}
          </p>
          <div className="text-[12px] text-ink-700 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(v.content) }} />
        </li>
      ))}
    </ol>
  )
}

function VariantCard({ family, variant }: { family: ClauseFamily; variant: FamilyVariant }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [history, setHistory] = useState(false)
  const makeDefault = useMutation({
    mutationFn: (variantId: string | null) => api.put(`/clause-families/${family.id}/default`, { variantId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clause-families'] }),
  })
  if (editing) return <VariantEditor family={family} variant={variant} onDone={() => setEditing(false)} />
  return (
    <div className="border border-paper-200 rounded-card p-3 bg-card" data-testid={`variant-${variant.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-body font-semibold text-ink-950">{labelOf(variant)}</p>
            <span className="text-[11px] text-ink-400 tabular-nums">v{variant.version}</span>
            {variant.isFamilyDefault && <Chip selected className="text-[10.5px]"><Star className="size-3" /> Default</Chip>}
            {!variant.isApproved && <span className="text-[11px] text-attention-700">Not approved — drafting won’t use it</span>}
          </div>
          <p className="text-[11.5px] text-ink-500 mt-0.5">
            {variant.condition ? `Used when: ${describeCondition(variant.condition)}` : 'No rule'}
            {variant.matchValues.length > 0 && ` · A request may call it ${variant.matchValues.join(', ')}`}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          {variant.isApproved && !variant.isFamilyDefault && (
            <Button variant="ghost" size="xs" onClick={() => makeDefault.mutate(variant.id)} disabled={makeDefault.isPending}>Make default</Button>
          )}
          {variant.isFamilyDefault && (
            <Button variant="ghost" size="xs" onClick={() => makeDefault.mutate(null)} disabled={makeDefault.isPending}>No default</Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => setHistory(h => !h)}><History /> History</Button>
          <Button variant="outline" size="xs" onClick={() => setEditing(true)}>Edit</Button>
        </div>
      </div>
      <div className="mt-2 text-[12.5px] text-ink-700 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(variant.content) }} />
      {history && <VersionHistory itemId={variant.id} />}
    </div>
  )
}

// ─── Which option drafting would pick ───────────────────────────────────────

function TryIt({ family }: { family: ClauseFamily }) {
  const [facts, setFacts] = useState<Record<string, string>>({})
  const [asked, setAsked] = useState('')
  const preview = useMutation({
    mutationFn: () => api.post<SlotDecision>(`/clause-families/${family.id}/preview`, {
      facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v.trim()).map(([k, v]) => [k, CONDITION_KEYS.find(c => c.key === k)?.type === 'number' ? Number(v) : v.trim()])),
      ...(asked.trim() && { requestValue: asked.trim() }),
    }).then(r => r.data),
  })
  const d = preview.data
  return (
    <div className="border border-paper-200 rounded-card p-3 space-y-2" data-testid="family-try-it">
      <Eyebrow>Try it: which option would a draft use?</Eyebrow>
      <div className="grid grid-cols-2 gap-2">
        {family.requestKey && (
          <Input value={asked} onChange={e => setAsked(e.target.value)} placeholder="The request asks for… (e.g. New York)" className="h-8 text-[12px]" />
        )}
        {CONDITION_KEYS.filter(k => k.key !== family.requestKey).map(k => (
          <Input key={k.key} value={facts[k.key] ?? ''} onChange={e => setFacts(f => ({ ...f, [k.key]: e.target.value }))} placeholder={k.label} className="h-8 text-[12px]" />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="xs" onClick={() => preview.mutate()} disabled={preview.isPending}>Check</Button>
        {d && (
          <p className="text-dense text-ink-700" data-testid="family-try-it-result">
            {d.variantLabel ? <>Drafts would use <strong>{d.variantLabel}</strong> — {SLOT_DECIDED_BY_LABEL[d.decidedBy].toLowerCase()}{d.rule ? ` (${d.rule})` : ''}.</> : <>The draft would ask: {d.reason}</>}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── The view ───────────────────────────────────────────────────────────────

function NewFamilyForm({ categories, onCreated, onCancel }: { categories: Array<{ id: string; name: string }>; onCreated: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [lawKey, setLawKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    meta: { errorHandled: true },
    mutationFn: () => api.post<ClauseFamily>('/clause-families', { name: name.trim(), categoryId: categoryId || null, requestKey: lawKey ? 'governingLaw' : null }).then(r => r.data),
    onSuccess: f => { qc.invalidateQueries({ queryKey: ['clause-families'] }); onCreated(f.id) },
    onError: e => setError(apiErrorMessage(e)),
  })
  return (
    <div className="p-3 space-y-2 border-b border-paper-200 bg-paper-50" data-testid="new-family-form">
      <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Governing Law" autoFocus data-testid="new-family-name" />
      <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className="w-full h-8 border border-input bg-card rounded-md px-2 text-[12.5px]">
        <option value="">No category</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-700">
        <input type="checkbox" checked={lawKey} onChange={e => setLawKey(e.target.checked)} className="accent-ink-950" />
        A request can name it by the governing law it asks for
      </label>
      {error && <p role="alert" className="text-[12px] text-risk-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="xs" onClick={onCancel}>Cancel</Button>
        <Button size="xs" onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} data-testid="new-family-save">Create family</Button>
      </div>
    </div>
  )
}

export function ClauseFamiliesView({ categories }: { categories: Array<{ id: string; name: string }> }) {
  const { data: families = [], isLoading } = useClauseFamilies()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const selected = useMemo(() => families.find(f => f.id === selectedId) ?? families[0] ?? null, [families, selectedId])

  return (
    <div className="flex flex-1 min-w-0" data-testid="clause-families-view">
      <div className="w-80 shrink-0 border-r border-paper-200 flex flex-col">
        <div className="flex items-center justify-between px-3 py-3 border-b border-paper-200">
          <p className="text-dense text-ink-500">Clauses with approved alternatives</p>
          <Button variant="outline" size="xs" onClick={() => setCreating(true)} data-testid="new-family-button"><Plus /> New family</Button>
        </div>
        {creating && <NewFamilyForm categories={categories} onCreated={id => { setCreating(false); setSelectedId(id) }} onCancel={() => setCreating(false)} />}
        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="flex justify-center p-4"><Loader2 className="size-5 animate-spin text-ink-400" /></div>}
          {!isLoading && !families.length && (
            <div className="p-3">
              <EmptyState icon={<Layers />} title="No clause families yet" description="Group the approved versions of one clause (for example, governing law) so drafting picks the right one by your rules." />
            </div>
          )}
          {families.map(f => (
            <button
              key={f.id}
              onClick={() => { setSelectedId(f.id); setAdding(false) }}
              className={cn('w-full text-left px-3 py-2.5 border-b border-paper-100', selected?.id === f.id ? 'bg-paper-100' : 'hover:bg-paper-50')}
              data-testid={`family-row-${f.id}`}
            >
              <p className="text-[12.5px] font-medium text-ink-950">{f.name}</p>
              <p className="text-[11px] text-ink-500">
                {f.variants.length} option{f.variants.length === 1 ? '' : 's'}
                {f.variants.find(v => v.isFamilyDefault) ? ` · default ${labelOf(f.variants.find(v => v.isFamilyDefault)!)}` : ' · no default'}
                {f.templateCount ? ` · in ${f.templateCount} template${f.templateCount === 1 ? '' : 's'}` : ''}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
        {selected ? (
          <>
            <div>
              <h2 className="text-section text-ink-950">{selected.name}</h2>
              <p className="text-dense text-ink-500 mt-0.5">
                {selected.description ?? ''}{selected.category ? ` In ${selected.category.name}.` : ''}
                {' '}Drafting uses, in order: the option a person picks, the one the request names{selected.requestKey ? '' : ' (not set up for this family)'}, the first whose rule holds, the default. Otherwise the draft asks.
              </p>
            </div>
            <div className="space-y-2">
              {selected.variants.map(v => <VariantCard key={v.id} family={selected} variant={v} />)}
              {adding
                ? <VariantEditor family={selected} onDone={() => setAdding(false)} />
                : <Button variant="outline" size="xs" onClick={() => setAdding(true)} data-testid="add-variant-button"><Plus /> Add an option</Button>}
            </div>
            {selected.variants.some(v => v.isApproved) && <TryIt family={selected} />}
            {selected.variants.length > 0 && !selected.variants.some(v => v.isFamilyDefault) && (
              <p className="text-[11.5px] text-ink-500 flex items-center gap-1"><Check className="size-3" /> No default: a draft no rule decides asks someone to choose.</p>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
