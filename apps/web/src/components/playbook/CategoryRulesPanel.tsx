/**
 * docs/41 fix-up 9 — a clause category's rules, beside its positions on the
 * Playbook page: whether contracts must have the clause (Required / Not
 * allowed / Optional), which contract types that applies to (none picked: all
 * of them), and who decides exceptions. Saved through
 * PATCH /playbook/categories/:id/rules (edit:playbook). Open contracts pick a
 * change up the next time their review is read; signed ones keep theirs.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { serverMessage } from '@/lib/approval-keys'
import { useCanRequest } from '@/lib/permissions'
import { RULE_CONTRACT_TYPES, typeLabel } from '@/lib/workflow-rules-draft'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { cn } from '@/lib/utils'
import { CategoryApproverField } from '@/components/clauses/CategoryApproverField'
import type { ApproverCategory } from '@/lib/clause-approver'

export type Presence = 'required' | 'not_allowed' | 'optional'
export interface RulesCategory extends ApproverCategory { presence?: Presence | null; presenceContractTypes?: string[] | null }

export const PRESENCE_CHOICES: Array<{ value: Presence; label: string; help: string }> = [
  { value: 'required', label: 'Required', help: 'Flag a contract that doesn’t have this clause.' },
  { value: 'not_allowed', label: 'Not allowed', help: 'Flag a contract that has this clause.' },
  { value: 'optional', label: 'Optional', help: 'Don’t flag it either way.' },
]

/** One line saying what the rule does, as the panel shows it before editing. */
export function presenceSummary(presence: Presence, types: string[]): string {
  if (presence === 'optional') return 'Optional — contracts are not checked for it.'
  const which = types.length ? types.map(typeLabel).join(', ') : 'all contract types'
  return presence === 'required' ? `Required in ${which}.` : `Not allowed in ${which}.`
}

export function CategoryRulesPanel({ category, all }: { category: RulesCategory; all: RulesCategory[] }) {
  const qc = useQueryClient()
  const canEdit = useCanRequest('PATCH /playbook/categories/:id/rules')
  const storedPresence: Presence = category.presence ?? 'optional'
  const storedTypes = category.presenceContractTypes ?? []
  const [presence, setPresence] = useState<Presence>(storedPresence)
  const [types, setTypes] = useState<string[]>(storedTypes)
  // Another category picked, or the rule saved: start from what is stored.
  const storedKey = `${category.id}|${storedPresence}|${storedTypes.join(',')}`
  useEffect(() => { setPresence(storedPresence); setTypes(storedTypes) }, [storedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    meta: { errorHandled: true },
    mutationFn: () => api.patch(`/playbook/categories/${category.id}/rules`, { presence, presenceContractTypes: presence === 'optional' ? [] : types }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clause-categories'] })
      toast.success('Rule saved', { description: 'Open contracts are checked against it the next time their review is opened.' })
    },
  })
  const dirty = presence !== storedPresence || (presence !== 'optional' && [...types].sort().join() !== [...storedTypes].sort().join())
  const toggle = (t: string) => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])

  return (
    <section className="bg-card border border-paper-200 rounded-card" data-testid="category-rules">
      <div className="px-3 py-2.5 space-y-2 text-[12px]">
        <p className="text-eyebrow uppercase text-ink-700">Rules for this clause</p>
        {!canEdit ? (
          <p className="text-ink-700" data-testid="category-rules-summary">{presenceSummary(storedPresence, storedTypes)}</p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Must contracts have this clause?" className="inline-flex rounded-md border border-paper-200 overflow-hidden">
              {PRESENCE_CHOICES.map(c => (
                <button
                  key={c.value} type="button" role="radio" aria-checked={presence === c.value} title={c.help}
                  onClick={() => setPresence(c.value)}
                  className={cn('px-2.5 h-7 text-[11.5px] border-r border-paper-200 last:border-r-0', presence === c.value ? 'bg-ink-950 text-paper-50' : 'bg-card text-ink-700 hover:bg-paper-100')}
                  data-testid={`category-presence-${c.value}`}
                >{c.label}</button>
              ))}
            </div>
            <p className="text-ink-500">{PRESENCE_CHOICES.find(c => c.value === presence)?.help}</p>
            {presence !== 'optional' && (
              <div>
                <p className="text-ink-500 mb-1">Contract types it applies to {types.length === 0 && <span className="text-ink-400">(none picked: all types)</span>}</p>
                <div className="flex flex-wrap gap-1" data-testid="category-presence-types">
                  {RULE_CONTRACT_TYPES.map(t => (
                    <button
                      key={t} type="button" aria-pressed={types.includes(t)} onClick={() => toggle(t)}
                      className={cn('px-2 h-6 rounded-chip border text-[11px]', types.includes(t) ? 'border-ink-950 bg-paper-100 text-ink-950' : 'border-paper-200 text-ink-500 hover:text-ink-950')}
                    >{typeLabel(t)}</button>
                  ))}
                </div>
              </div>
            )}
            {save.isError && <p role="alert" className="text-[11.5px] text-risk-700">{serverMessage(save.error)}</p>}
            <Button size="xs" onClick={() => save.mutate()} disabled={!dirty || save.isPending} data-testid="category-rules-save">
              {save.isPending && <Loader2 className="animate-spin" />} Save rule
            </Button>
          </>
        )}
      </div>
      {canEdit
        ? <CategoryApproverField category={category} all={all} saveUrl={`/playbook/categories/${category.id}/rules`} />
        : null}
    </section>
  )
}
