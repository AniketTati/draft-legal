/**
 * CompliancePolicySection (docs/41 Part 9) — the org's rules from facts to
 * compliance frameworks, set once by an admin.
 *
 * A rule: a framework, and the facts that must all hold ("Personal data" and
 * "Where the people are: EU" → GDPR). Several rules for one framework: any of
 * them. Every contract's Compliance section works out what applies from these,
 * so lawyers never pick frameworks by hand.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Plus, Trash2, RotateCcw, Save } from 'lucide-react'
import type { ComplianceFactKey, ComplianceFrameworkId, PolicyCondition, PolicyRule, ComplianceFactSpec } from '@clm/types'
import { api } from '@/lib/api'
import { toast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'

interface PolicyResponse {
  rules: PolicyRule[]
  isDefault: boolean
  updatedAt: string | null
  frameworks: Array<{ id: ComplianceFrameworkId; label: string }>
  facts: Array<{ key: ComplianceFactKey } & ComplianceFactSpec>
  defaults: PolicyRule[]
}

const select = 'h-7 text-[12px] border border-paper-200 rounded-md bg-card px-1.5'

function conditionText(c: PolicyCondition, facts: PolicyResponse['facts']): string {
  const spec = facts.find(f => f.key === c.fact)
  if (c.op === 'is_true') return spec?.label ?? c.fact
  const names = (c.values ?? []).map(v => spec?.options?.find(o => o.value === v)?.label ?? v)
  return `${spec?.label ?? c.fact}: ${names.join(' or ')}`
}

export function CompliancePolicySection({ canEdit = true }: { canEdit?: boolean }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['compliance-policy'],
    queryFn: async () => (await api.get<PolicyResponse>('/compliance-policy')).data,
  })
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (data && !dirty) setRules(data.rules) }, [data, dirty])

  const onDone = (msg: string) => (next: PolicyResponse) => {
    qc.setQueryData(['compliance-policy'], next)
    setRules(next.rules)
    setDirty(false)
    toast.success(msg)
  }
  const onError = (e: { response?: { data?: { detail?: string } } }) =>
    toast.error('Save failed', { description: e.response?.data?.detail ?? 'Unknown error' })
  const save = useMutation({
    mutationFn: async () => (await api.put<PolicyResponse>('/compliance-policy', { rules })).data,
    onSuccess: onDone('Compliance rules saved'), onError,
  })
  const reset = useMutation({
    mutationFn: async () => (await api.delete<PolicyResponse>('/compliance-policy')).data,
    onSuccess: onDone('Back to the default rules'), onError,
  })

  // A new rule being built.
  const [fw, setFw] = useState<ComplianceFrameworkId | ''>('')
  const [conds, setConds] = useState<PolicyCondition[]>([])
  const [fact, setFact] = useState<ComplianceFactKey | ''>('')
  const [values, setValues] = useState<string[]>([])

  if (!data) return null
  // Yes/no facts, and lists with set choices (regions): what a rule can test.
  const facts = data.facts.filter(f => f.kind === 'boolean' || (f.kind === 'list' && f.options?.length))
  const factSpec = facts.find(f => f.key === fact)
  const change = (next: PolicyRule[]) => { setRules(next); setDirty(true) }

  const addCondition = () => {
    if (!factSpec) return
    if (factSpec.kind === 'list' && !values.length) return
    setConds([...conds, factSpec.kind === 'boolean' ? { fact: factSpec.key, op: 'is_true' } : { fact: factSpec.key, op: 'includes_any', values }])
    setFact(''); setValues([])
  }
  const addRule = () => {
    if (!fw || !conds.length) return
    const id = `${fw.toLowerCase()}-${Date.now().toString(36)}`
    change([...rules, { id, framework: fw, enabled: true, when: conds }])
    setFw(''); setConds([])
  }

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="compliance-policy-section">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-700" />
          When compliance frameworks apply
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          The AI reads each contract for facts (personal data, where the people are, health data, card data, financial reporting) and quotes them.
          These rules turn the facts into the frameworks a contract is checked against. A framework applies when every fact in one of its rules holds.
          {data.isDefault && ' These are the default rules.'}
        </p>
      </header>

      <table className="w-full text-[12px]" data-testid="compliance-policy-rules">
        <thead>
          <tr className="text-left text-ink-500 border-b border-paper-200">
            <th className="py-1.5 pr-2 font-medium">Framework</th>
            <th className="py-1.5 pr-2 font-medium">Applies when</th>
            <th className="py-1.5 pr-2 font-medium w-14">On</th>
            {canEdit && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.id} className="border-b border-paper-100 last:border-b-0 align-top" data-testid={`compliance-rule-${r.id}`}>
              <td className="py-1.5 pr-2 font-medium text-ink-950">{data.frameworks.find(f => f.id === r.framework)?.label ?? r.framework}</td>
              <td className="py-1.5 pr-2 text-ink-700">{r.when.map(c => conditionText(c, data.facts)).join(' and ')}</td>
              <td className="py-1.5 pr-2">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  disabled={!canEdit}
                  onChange={e => change(rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                  aria-label={`Rule for ${r.framework} on`}
                />
              </td>
              {canEdit && (
                <td className="py-1.5">
                  <button type="button" onClick={() => change(rules.filter((_, j) => j !== i))} aria-label="Remove rule" className="text-ink-400 hover:text-risk-700">
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canEdit && (
        <div className="rounded-md border border-dashed border-paper-200 p-3 space-y-2" data-testid="compliance-policy-new-rule">
          <div className="text-[12px] font-medium text-ink-950">Add a rule</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select className={select} value={fw} onChange={e => setFw(e.target.value as ComplianceFrameworkId)} aria-label="Framework">
              <option value="">Framework…</option>
              {data.frameworks.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <span className="text-[12px] text-ink-500">applies when</span>
            {conds.map((c, i) => (
              <span key={i} className="text-[11px] border border-paper-200 rounded-chip px-1.5 py-0.5 bg-paper-50">{conditionText(c, data.facts)}</span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select className={select} value={fact} onChange={e => { setFact(e.target.value as ComplianceFactKey); setValues([]) }} aria-label="Fact">
              <option value="">{conds.length ? 'and…' : 'Fact…'}</option>
              {facts.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            {factSpec?.kind === 'list' && (factSpec.options ?? []).map(o => (
              <label key={o.value} className="text-[11px] inline-flex items-center gap-1">
                <input type="checkbox" checked={values.includes(o.value)}
                  onChange={e => setValues(e.target.checked ? [...values, o.value] : values.filter(v => v !== o.value))} />
                {o.label}
              </label>
            ))}
            <Button size="sm" variant="ghost" className="h-7 text-[11px] gap-1" disabled={!factSpec || (factSpec.kind === 'list' && !values.length)} onClick={addCondition}>
              <Plus className="size-3" /> Condition
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!fw || !conds.length} onClick={addRule} data-testid="compliance-policy-add-rule">
              Add rule
            </Button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="flex justify-end gap-2 pt-2 border-t border-paper-200">
          <Button variant="ghost" size="sm" className="gap-1" disabled={reset.isPending || data.isDefault} onClick={() => reset.mutate()}>
            <RotateCcw className="size-3.5" /> Default rules
          </Button>
          <Button size="sm" className="gap-1" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="compliance-policy-save">
            <Save className="size-3.5" /> {save.isPending ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      )}
    </section>
  )
}
