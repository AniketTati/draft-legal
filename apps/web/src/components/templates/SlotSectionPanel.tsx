/**
 * docs/41 Part 1 — a clause slot in the template builder: the section's words
 * are whichever approved option of a clause family drafting picks for each
 * draft. The panel shows the family's options and their rules, and which one
 * a draft would get for sample inputs (the same rules drafting runs).
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Layers } from 'lucide-react'
import { CONDITION_KEYS, SLOT_DECIDED_BY_LABEL, describeCondition, type SlotDecision } from '@clm/types'
import { api } from '@/lib/api'
import { sanitizeHtml } from '@/lib/sanitize'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip, Eyebrow } from '@/components/ui/primitives'
import type { ClauseFamily } from '@/components/clauses/ClauseFamiliesView'

export function SlotSectionPanel({ family, families, onChangeFamily }: {
  family: ClauseFamily | undefined
  families: ClauseFamily[]
  onChangeFamily: (familyId: string) => void
}) {
  const [facts, setFacts] = useState<Record<string, string>>({})
  const [asked, setAsked] = useState('')
  const preview = useMutation({
    mutationFn: () => api.post<SlotDecision>(`/clause-families/${family!.id}/preview`, {
      facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v.trim()).map(([k, v]) => [k, CONDITION_KEYS.find(c => c.key === k)?.type === 'number' ? Number(v) : v.trim()])),
      ...(asked.trim() && { requestValue: asked.trim() }),
    }).then(r => r.data),
  })
  const approved = family?.variants.filter(v => v.isApproved) ?? []
  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4" data-testid="slot-section-panel">
      <div className="flex items-center gap-2">
        <Layers className="size-4 text-ink-400" />
        <p className="text-dense text-ink-700">Clause slot — the words come from</p>
        <select
          value={family?.id ?? ''}
          onChange={e => onChangeFamily(e.target.value)}
          className="h-8 border border-input bg-card rounded-md px-2 text-[12.5px] text-ink-950"
          data-testid="slot-family-select"
        >
          {!family && <option value="">Choose a clause family…</option>}
          {families.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <Link to="/clauses?view=families" className="text-[12px] text-ink-500 hover:text-ink-950 underline underline-offset-2">Edit families</Link>
      </div>
      {family && (
        <>
          <p className="text-dense text-ink-500">
            Each draft gets one option, in this order: the one a person picks, the one the request names, the first whose rule holds, the default. If none decides, the draft asks before it can be sent.
          </p>
          <div className="space-y-2">
            {approved.length === 0 && <p className="text-dense text-attention-700">This family has no approved option yet, so every draft will ask.</p>}
            {approved.map(v => (
              <div key={v.id} className="border border-paper-200 rounded-card p-3">
                <div className="flex items-center gap-2">
                  <p className="text-body font-semibold text-ink-950">{v.variantLabel || v.title}</p>
                  {v.isFamilyDefault && <Chip selected className="text-[10.5px]">Default</Chip>}
                  <span className="text-[11px] text-ink-400 tabular-nums">v{v.version}</span>
                </div>
                <p className="text-[11.5px] text-ink-500">{v.condition ? `Used when: ${describeCondition(v.condition)}` : 'No rule'}</p>
                <div className="mt-1.5 text-[12.5px] text-ink-700 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(v.content) }} />
              </div>
            ))}
          </div>
          {approved.length > 0 && (
            <div className="border border-paper-200 rounded-card p-3 space-y-2" data-testid="slot-preview">
              <Eyebrow>Which option would a draft get?</Eyebrow>
              <div className="grid grid-cols-2 gap-2">
                {family.requestKey && <Input value={asked} onChange={e => setAsked(e.target.value)} placeholder="The request asks for… (e.g. New York)" className="h-8 text-[12px]" />}
                {CONDITION_KEYS.filter(k => k.key !== family.requestKey).map(k => (
                  <Input key={k.key} value={facts[k.key] ?? ''} onChange={e => setFacts(f => ({ ...f, [k.key]: e.target.value }))} placeholder={k.label} className="h-8 text-[12px]" />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="xs" onClick={() => preview.mutate()} disabled={preview.isPending} data-testid="slot-preview-btn">Check</Button>
                {preview.data && (
                  <p className="text-dense text-ink-700" data-testid="slot-preview-result">
                    {preview.data.variantLabel
                      ? <><strong>{preview.data.variantLabel}</strong> — {SLOT_DECIDED_BY_LABEL[preview.data.decidedBy].toLowerCase()}{preview.data.rule ? ` (${preview.data.rule})` : ''}</>
                      : <>The draft would ask: {preview.data.reason}</>}
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
