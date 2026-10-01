/**
 * docs/41 P1 (Part 3) — which playbook the Playbook page is editing, and a
 * small manager for the playbooks themselves: make one, rename it, say which
 * contract types it covers, and make it the default for them.
 *
 * A contract is reviewed against the playbook chosen on it, else the default
 * for its type, else the only one that covers it (the API decides, in
 * lib/playbooks.ts); this is where the defaults are set.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ContractType } from '@clm/types'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, Plus, Settings2, X } from 'lucide-react'

export interface PlaybookRow {
  id: string
  name: string
  description: string | null
  contractTypes: string[]
  isDefaultForType: boolean
  version: number
  positionCount: number
}

const TYPES = Object.values(ContractType).filter(t => t !== ContractType.OTHER)
const typeName = (t: string) => t === 'NDA' || t === 'MSA' || t === 'SOW' || t === 'SLA' ? t : t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())

/** "Default for NDA, MSA" / "All contract types". */
export function coverageText(p: Pick<PlaybookRow, 'contractTypes' | 'isDefaultForType'>): string {
  const types = p.contractTypes.length ? p.contractTypes.map(typeName).join(', ') : 'all contract types'
  return p.isDefaultForType ? `Default for ${types}` : `Covers ${types}`
}

export function usePlaybooks() {
  return useQuery({
    queryKey: ['playbooks'],
    queryFn: () => api.get<{ data: PlaybookRow[]; unfiledPositions: number }>('/playbook/playbooks').then(r => r.data),
    staleTime: 30_000,
  })
}

export function PlaybookSwitcher({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const q = usePlaybooks()
  const [managing, setManaging] = useState(false)
  const playbooks = q.data?.data ?? []

  // Open on the default for all types (or the first) once they load.
  useEffect(() => {
    if (value || playbooks.length === 0) return
    onChange((playbooks.find(p => p.isDefaultForType && p.contractTypes.length === 0) ?? playbooks[0]).id)
  }, [playbooks, value, onChange])

  const current = playbooks.find(p => p.id === value)
  return (
    <div className="mt-2" data-testid="playbook-switcher">
      {playbooks.length > 0 && (
        <div className="flex items-center gap-1">
          <select
            value={value ?? ''}
            onChange={e => onChange(e.target.value || null)}
            className="flex-1 min-w-0 text-[12px] rounded-md border border-input bg-card px-1.5 py-1"
            aria-label="Playbook"
            data-testid="playbook-select"
          >
            {playbooks.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" onClick={() => setManaging(true)} className="p-1 rounded-md text-ink-500 hover:text-ink-950 hover:bg-paper-100" title="Manage playbooks" data-testid="playbook-manage">
            <Settings2 className="size-3.5" />
          </button>
        </div>
      )}
      {current && <p className="text-[11px] text-ink-500 mt-1">{coverageText(current)} · version {current.version}</p>}
      {playbooks.length === 0 && q.isSuccess && (
        <button type="button" onClick={() => setManaging(true)} className="text-[11.5px] underline text-ink-700">Set up playbooks</button>
      )}
      {managing && <PlaybookManager playbooks={playbooks} onClose={() => setManaging(false)} onCreated={onChange} />}
    </div>
  )
}

function PlaybookManager({ playbooks, onClose, onCreated }: { playbooks: PlaybookRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['playbooks'] })
  const [creating, setCreating] = useState(false)
  const save = useMutation({
    mutationFn: ({ id, ...body }: Partial<PlaybookRow> & { id?: string }) => id
      ? api.patch(`/playbook/playbooks/${id}`, body).then(r => r.data as PlaybookRow)
      : api.post('/playbook/playbooks', body).then(r => r.data as PlaybookRow),
    onSuccess: (row, vars) => { refresh(); if (!vars.id) { setCreating(false); onCreated(row.id) } },
  })

  return (
    <div className="fixed inset-0 z-50 bg-ink-950/30 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="w-[560px] max-w-[calc(100vw-32px)] bg-card rounded-card border border-border shadow-lg" onClick={e => e.stopPropagation()} data-testid="playbook-manager">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-[14px] font-medium text-ink-950">Playbooks</h2>
          <button type="button" onClick={onClose} className="p-1 text-ink-500 hover:text-ink-950"><X className="size-4" /></button>
        </div>
        <p className="px-4 pt-3 text-[12px] text-ink-500">
          A contract is checked against the playbook chosen on it, otherwise the default for its type, otherwise the only playbook that covers its type. If several could apply and none is the default, the contract asks which to use.
        </p>
        <ul className="px-4 py-3 space-y-3 max-h-[50vh] overflow-y-auto">
          {playbooks.map(p => <PlaybookEditor key={p.id} row={p} saving={save.isPending} onSave={body => save.mutate({ id: p.id, ...body })} />)}
          {creating && (
            <PlaybookEditor
              row={{ id: '', name: '', description: null, contractTypes: [], isDefaultForType: false, version: 1, positionCount: 0 }}
              saving={save.isPending} isNew
              onSave={body => save.mutate(body)}
              onCancel={() => setCreating(false)}
            />
          )}
        </ul>
        {save.isError && <p className="px-4 text-[12px] text-risk-700">The playbook could not be saved.</p>}
        <div className="px-4 py-3 border-t border-border flex justify-between">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setCreating(true)} disabled={creating} data-testid="playbook-new">
            <Plus className="size-3.5" /> New playbook
          </Button>
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  )
}

function PlaybookEditor({ row, saving, isNew, onSave, onCancel }: {
  row: PlaybookRow; saving: boolean; isNew?: boolean
  onSave: (body: { name: string; contractTypes: string[]; isDefaultForType: boolean }) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(row.name)
  const [types, setTypes] = useState<string[]>(row.contractTypes)
  const [isDefault, setIsDefault] = useState(row.isDefaultForType)
  useEffect(() => { setName(row.name); setTypes(row.contractTypes); setIsDefault(row.isDefaultForType) }, [row])
  const dirty = isNew || name !== row.name || isDefault !== row.isDefaultForType || types.join() !== row.contractTypes.join()
  const toggle = (t: string) => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])

  return (
    <li className="border border-border rounded-md p-3" data-testid={`playbook-row-${row.id || 'new'}`}>
      <div className="flex items-center gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Playbook name" className="h-7 text-[13px]" aria-label="Playbook name" />
        {!isNew && <span className="text-[11px] text-ink-500 whitespace-nowrap">{row.positionCount} position{row.positionCount === 1 ? '' : 's'}</span>}
      </div>
      <div className="mt-2 text-[11.5px] text-ink-700">Contract types it covers {types.length === 0 && <span className="text-ink-500">(none ticked: all types)</span>}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {TYPES.map(t => (
          <button
            key={t} type="button" onClick={() => toggle(t)}
            className={`text-[11px] px-1.5 py-0.5 rounded-chip border ${types.includes(t) ? 'bg-ink-950 text-white border-ink-950' : 'bg-card text-ink-700 border-paper-300 hover:bg-paper-100'}`}
          >{typeName(t)}</button>
        ))}
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-700">
        <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
        Default for {types.length ? 'these types' : 'all types'}
      </label>
      {dirty && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="gap-1" disabled={saving || !name.trim()} onClick={() => onSave({ name: name.trim(), contractTypes: types, isDefaultForType: isDefault })}>
            <Check className="size-3.5" /> {isNew ? 'Create' : 'Save'}
          </Button>
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      )}
    </li>
  )
}
