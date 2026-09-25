/**
 * Z3 — when a workflow is used, and which contracts it approves without a
 * person. The server always read these rules on "Send for review", but the
 * builder couldn't set them.
 */
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  RULE_CONTRACT_TYPES, RULE_CURRENCIES, typeLabel, type RulesDraft,
} from '@/lib/workflow-rules-draft'

const selectClass = 'h-8 text-[13px] border border-input rounded-md px-2 bg-card focus-visible:outline-none focus-visible:border-brand-700'

export function WorkflowRulesEditor({ draft, onChange }: { draft: RulesDraft; onChange: (d: RulesDraft) => void }) {
  const set = (patch: Partial<RulesDraft>) => onChange({ ...draft, ...patch })
  const currencies = RULE_CURRENCIES.includes(draft.currency) ? RULE_CURRENCIES : [draft.currency, ...RULE_CURRENCIES]
  const toggleType = (t: RulesDraft['contractTypes'][number]) => set({
    contractTypes: draft.contractTypes.includes(t) ? draft.contractTypes.filter(x => x !== t) : [...draft.contractTypes, t],
  })
  const setRule = (i: number, patch: Partial<RulesDraft['autoApprove'][number]>) =>
    set({ autoApprove: draft.autoApprove.map((r, j) => (j === i ? { ...r, ...patch } : r)) })

  return (
    <div className="space-y-4" data-testid="workflow-rules">
      <div>
        <p className="text-dense font-medium text-ink-700">When to use this workflow</p>
        <p className="text-[11px] text-ink-500 mt-0.5">
          A contract sent without choosing a workflow goes to the one whose rules fit it most closely.
          When none fits, it goes to the default.
        </p>
      </div>

      <div>
        <label className="block text-dense text-ink-700 mb-1.5">Contract types</label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Contract types">
          {RULE_CONTRACT_TYPES.map(t => {
            const on = draft.contractTypes.includes(t)
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => toggleType(t)}
                data-testid={`rule-type-${t}`}
                className={`px-2 h-6 rounded-md border text-[11.5px] transition-colors ${
                  on ? 'border-ink-700 bg-ink-950 text-white' : 'border-paper-200 text-ink-700 hover:bg-paper-50'
                }`}
              >
                {typeLabel(t)}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-ink-500 mt-1">None selected: every type.</p>
      </div>

      <div>
        <label className="block text-dense text-ink-700 mb-1.5" htmlFor="rule-threshold">Only for contracts worth at least</label>
        <div className="flex gap-2">
          <Input
            id="rule-threshold"
            inputMode="decimal"
            value={draft.valueThreshold}
            onChange={e => set({ valueThreshold: e.target.value })}
            placeholder="Any value"
            className="max-w-[160px]"
            data-testid="rule-threshold"
          />
          <select value={draft.currency} onChange={e => set({ currency: e.target.value })} className={selectClass} aria-label="Currency of the values in these rules">
            {currencies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <p className="text-[11px] text-ink-500 mt-1">A contract with no value, or in another currency, counts as meeting it.</p>
      </div>

      <div>
        <label className="block text-dense text-ink-700 mb-1.5">Approve automatically</label>
        <div className="space-y-2">
          {draft.autoApprove.map((rule, i) => (
            <div key={i} className="flex items-center gap-2" data-testid={`rule-auto-${i}`}>
              <select
                value={rule.contractType}
                onChange={e => setRule(i, { contractType: e.target.value as typeof rule.contractType })}
                className={selectClass}
                aria-label="Contract type"
              >
                {(['ANY', ...RULE_CONTRACT_TYPES] as const).map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
              <span className="text-dense text-ink-500">up to</span>
              <Input
                inputMode="decimal"
                value={rule.maxValue}
                onChange={e => setRule(i, { maxValue: e.target.value })}
                placeholder="Limit"
                className="max-w-[120px]"
                aria-label="Highest value approved automatically"
              />
              <span className="text-dense text-ink-500">{draft.currency}</span>
              <button
                type="button"
                onClick={() => set({ autoApprove: draft.autoApprove.filter((_, j) => j !== i) })}
                className="p-1 rounded-md hover:bg-paper-100 text-ink-500"
                aria-label="Remove this rule"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button
          type="button" size="sm" variant="ghost" className="mt-1 h-7 px-2"
          onClick={() => set({ autoApprove: [...draft.autoApprove, { contractType: draft.contractTypes[0] ?? 'ANY', maxValue: '' }] })}
          data-testid="rule-auto-add"
        >
          <Plus className="size-3.5" />Add a rule
        </Button>
        <p className="text-[11px] text-ink-500 mt-1">
          A contract at or under the limit is approved when it is sent, with no review. One with no value set,
          or in another currency, always goes to a person.
        </p>
      </div>
    </div>
  )
}
