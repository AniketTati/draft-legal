/**
 * docs/41 Part 13 — step 1 of drafting an amendment: what changes.
 *
 * A person picks the agreement's sections (as in effect now) to replace or
 * delete, and its key terms to set to a new value. For a section, the AI can
 * draft the new words from a one-line instruction; the words of the
 * agreement it changes are quoted under it, and the person edits before the
 * amendment is made.
 */
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AssistMark } from '@/components/ui/assist'
import { Loader2 } from 'lucide-react'

export type ChangeDraft =
  | { kind: 'clause'; clauseId: string; name: string; parentText: string; action: 'replace' | 'delete'; newText: string; instruction: string; source: 'ai' | 'user'; quote: string | null; note: string | null }
  | { kind: 'term'; key: string; label: string; from: string | null; to: string }

interface Section { clauseId: string; clauseType: string; sectionRef: string | null; text: string; deleted: boolean; amendedBy: Array<{ short: string }> }
interface Field { key: string; label: string; display: string; legacy?: boolean }
interface Draft { clauseId: string; proposedText: string | null; quote: string | null; rationale: string | null; error: string | null }

const sectionName = (s: { sectionRef: string | null; clauseType: string }) =>
  s.sectionRef ? `Section ${s.sectionRef.replace(/^(section|§)\s*/i, '')}` : s.clauseType.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

const area = 'w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-[11px] py-2 placeholder:text-ink-400 focus:border-brand-700 focus:outline-none focus:ring-[3px] focus:ring-brand-700/15 resize-y'

export function AmendmentChangesPicker({ parentContractId, value, onChange }: { parentContractId: string; value: ChangeDraft[]; onChange: (v: ChangeDraft[]) => void }) {
  const effective = useQuery({
    queryKey: ['contract-effective', parentContractId],
    queryFn: async () => (await api.get<{ sections: Section[] }>(`/contracts/${parentContractId}/effective`)).data,
  })
  const fields = useQuery({
    queryKey: ['contract-fields', parentContractId],
    queryFn: async () => (await api.get<{ fields: Field[] }>(`/contracts/${parentContractId}/fields`)).data,
  })
  const draft = useMutation({
    mutationFn: async (c: { clauseId: string; instruction: string }) =>
      (await api.post<{ drafts: Draft[] }>(`/contracts/${parentContractId}/amendment-language`, { items: [c] })).data.drafts[0],
    onSuccess: (d) => {
      if (!d) return
      update(d.clauseId, d.proposedText
        ? { newText: d.proposedText, source: 'ai', quote: d.quote, note: d.rationale }
        : { note: d.error ?? 'No draft came back. Write the new words yourself.' })
    },
  })

  const sections = (effective.data?.sections ?? []).filter(s => !s.deleted)
  const terms = (fields.data?.fields ?? []).filter(f => !f.legacy && f.display)
  const picked = (id: string) => value.find(v => v.kind === 'clause' && v.clauseId === id) as Extract<ChangeDraft, { kind: 'clause' }> | undefined
  const update = (clauseId: string, patch: Partial<Extract<ChangeDraft, { kind: 'clause' }>>) =>
    onChange(value.map(v => v.kind === 'clause' && v.clauseId === clauseId ? { ...v, ...patch } : v))
  const toggle = (s: Section) => picked(s.clauseId)
    ? onChange(value.filter(v => !(v.kind === 'clause' && v.clauseId === s.clauseId)))
    : onChange([...value, { kind: 'clause', clauseId: s.clauseId, name: sectionName(s), parentText: s.text, action: 'replace', newText: '', instruction: '', source: 'user', quote: null, note: null }])
  const termRows = value.filter((v): v is Extract<ChangeDraft, { kind: 'term' }> => v.kind === 'term')

  if (effective.isLoading) return <p className="text-dense text-ink-500"><Loader2 className="inline size-3.5 animate-spin mr-1" />Reading the agreement…</p>

  return (
    <div className="space-y-4" data-testid="amendment-changes-picker">
      <div>
        <p className="text-body font-medium text-ink-700 mb-1.5">Sections that change</p>
        {!sections.length && <p className="text-dense text-ink-500">The agreement’s sections haven’t been read yet. You can still change its key terms.</p>}
        <div className="max-h-72 overflow-auto space-y-1.5 pr-1">
          {sections.map(s => {
            const p = picked(s.clauseId)
            return (
              <div key={s.clauseId} className={`rounded-md border p-2.5 ${p ? 'border-ink-950 bg-paper-50' : 'border-paper-200'}`}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!p} onChange={() => toggle(s)} className="mt-1" data-testid={`amend-section-${s.clauseId}`} />
                  <span className="min-w-0">
                    <span className="text-body font-medium text-ink-950">{sectionName(s)}</span>
                    {s.amendedBy.length > 0 && <span className="ml-1.5 text-[10.5px] text-ink-500">Amended by {s.amendedBy.map(a => a.short).join(', ')}</span>}
                    <span className="block text-dense text-ink-500 line-clamp-2">{s.text}</span>
                  </span>
                </label>
                {p && (
                  <div className="mt-2 space-y-2 pl-6">
                    <div className="flex gap-1.5">
                      {(['replace', 'delete'] as const).map(a => (
                        <Button key={a} size="xs" variant={p.action === a ? 'default' : 'outline'} onClick={() => update(s.clauseId, { action: a })}>
                          {a === 'replace' ? 'Replace the words' : 'Delete the section'}
                        </Button>
                      ))}
                    </div>
                    {p.action === 'replace' && (<>
                      <div className="flex gap-1.5">
                        <Input value={p.instruction} placeholder="What should change? e.g. payment within 45 days"
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(s.clauseId, { instruction: e.target.value })} />
                        <Button size="sm" variant="assistOutline" disabled={p.instruction.trim().length < 3 || draft.isPending}
                          onClick={() => draft.mutate({ clauseId: s.clauseId, instruction: p.instruction.trim() })} data-testid={`amend-draft-${s.clauseId}`}>
                          {draft.isPending && draft.variables?.clauseId === s.clauseId ? <Loader2 className="size-3.5 animate-spin" /> : <AssistMark />}
                          <span className="ml-1">Draft</span>
                        </Button>
                      </div>
                      <textarea rows={4} className={area} value={p.newText} placeholder="The section’s new words"
                        onChange={e => update(s.clauseId, { newText: e.target.value })} data-testid={`amend-text-${s.clauseId}`} />
                      {p.quote && <p className="text-dense text-ink-500">Changes: <q className="text-ink-700">{p.quote}</q></p>}
                      {p.note && <p className="text-dense text-ink-500">{p.note}</p>}
                    </>)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <TermRows terms={terms} rows={termRows} onChange={rows => onChange([...value.filter(v => v.kind !== 'term'), ...rows])} />
    </div>
  )
}

/** Key terms that change: each to a new value, written as the amendment will state it. */
function TermRows({ terms, rows, onChange }: {
  terms: Field[]; rows: Array<Extract<ChangeDraft, { kind: 'term' }>>; onChange: (rows: Array<Extract<ChangeDraft, { kind: 'term' }>>) => void
}) {
  const free = terms.filter(t => !rows.some(r => r.key === t.key))
  return (
    <div>
      <p className="text-body font-medium text-ink-700 mb-1.5">Key terms that change</p>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.key} className="flex items-center gap-2">
            <span className="text-body text-ink-950 w-36 truncate" title={r.label}>{r.label}</span>
            <span className="text-dense text-ink-500 w-28 truncate" title={r.from ?? ''}>{r.from || '—'}</span>
            <span className="text-ink-400">→</span>
            <Input value={r.to} placeholder="New value" data-testid={`amend-term-${r.key}`}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(rows.map(x => x.key === r.key ? { ...x, to: e.target.value } : x))} />
            <Button size="xs" variant="ghost" onClick={() => onChange(rows.filter(x => x.key !== r.key))}>Remove</Button>
          </div>
        ))}
      </div>
      {free.length > 0 && (
        <select
          className="mt-1.5 text-[13px] bg-card border border-input rounded-md px-2 py-1.5 text-ink-700"
          value="" data-testid="amend-term-add"
          onChange={e => {
            const t = free.find(f => f.key === e.target.value)
            if (t) onChange([...rows, { kind: 'term', key: t.key, label: t.label, from: t.display, to: '' }])
          }}
        >
          <option value="">Add a key term…</option>
          {free.map(t => <option key={t.key} value={t.key}>{t.label} ({t.display})</option>)}
        </select>
      )}
    </div>
  )
}

/** What the create route takes, from what the person picked; null when one isn't finished. */
export function changesPayload(v: ChangeDraft[]): unknown[] | null {
  const out: unknown[] = []
  for (const c of v) {
    if (c.kind === 'term') {
      if (!c.to.trim()) return null
      out.push({ kind: 'term', key: c.key, label: c.label, from: c.from, to: c.to.trim() })
    } else {
      if (c.action === 'replace' && !c.newText.trim()) return null
      out.push({ kind: 'clause', clauseId: c.clauseId, action: c.action, newText: c.action === 'replace' ? c.newText : undefined, source: c.source, instruction: c.instruction || null })
    }
  }
  return out
}
