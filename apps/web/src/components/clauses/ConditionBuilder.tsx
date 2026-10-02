/**
 * docs/41 Part 1 — when a clause variant is used: a few tests on the request
 * (counterparty country, contract value, contract type, the law asked for,
 * whose paper), all or any of which must hold. Saved as the condition the
 * API evaluates (@clm/types ClauseCondition); none means "only when chosen,
 * named in the request, or the default".
 */
import { Plus, Trash2 } from 'lucide-react'
import { CONDITION_KEYS, type ClauseCondition } from '@clm/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'
export interface ConditionRow { key: string; op: Op; value: string }

const OPS: Array<{ op: Op; label: string; numeric?: boolean }> = [
  { op: 'eq', label: 'is' },
  { op: 'neq', label: 'is not' },
  { op: 'in', label: 'is one of' },
  { op: 'gt', label: 'is more than', numeric: true },
  { op: 'gte', label: 'is at least', numeric: true },
  { op: 'lt', label: 'is less than', numeric: true },
  { op: 'lte', label: 'is at most', numeric: true },
]

/** The rows a stored condition reads as (one level of all/any). */
export function rowsOf(cond: ClauseCondition | null | undefined): { join: 'and' | 'or'; rows: ConditionRow[] } {
  if (!cond) return { join: 'and', rows: [] }
  const tests = cond.op === 'and' || cond.op === 'or' ? cond.all : [cond]
  return {
    join: cond.op === 'or' ? 'or' : 'and',
    rows: tests.flatMap(t => {
      if (t.op === 'and' || t.op === 'or') return []
      const test = t as Exclude<ClauseCondition, { op: 'and' | 'or' }>
      return [{ key: test.key, op: test.op as Op, value: Array.isArray(test.value) ? test.value.join(', ') : String(test.value) }]
    }),
  }
}

/** The condition the rows say; null with no complete row. */
export function conditionOf(join: 'and' | 'or', rows: ConditionRow[]): ClauseCondition | null {
  const tests: ClauseCondition[] = rows.filter(r => r.key && r.value.trim()).flatMap((r): ClauseCondition[] => {
    if (r.op === 'in') {
      const values = r.value.split(',').map(v => v.trim()).filter(Boolean)
      return values.length ? [{ op: 'in', key: r.key, value: values }] : []
    }
    if (r.op === 'gt' || r.op === 'gte' || r.op === 'lt' || r.op === 'lte') {
      const n = Number(r.value.replace(/[, $]/g, ''))
      return Number.isFinite(n) ? [{ op: r.op, key: r.key, value: n }] : []
    }
    return [{ op: r.op, key: r.key, value: r.value.trim() }]
  })
  if (!tests.length) return null
  return tests.length === 1 ? tests[0] : { op: join, all: tests }
}

const PLACEHOLDER: Record<string, string> = {
  'counterparty.country': 'e.g. GB, IE, DE',
  governingLaw: 'e.g. New York',
  value: 'e.g. 250000',
  contractType: 'e.g. NDA',
  paperSource: 'ours or theirs',
}

export function ConditionBuilder({ join, rows, onChange }: {
  join: 'and' | 'or'
  rows: ConditionRow[]
  onChange: (join: 'and' | 'or', rows: ConditionRow[]) => void
}) {
  const set = (i: number, patch: Partial<ConditionRow>) => onChange(join, rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const numeric = (key: string) => CONDITION_KEYS.find(k => k.key === key)?.type === 'number'
  return (
    <div className="space-y-1.5" data-testid="condition-builder">
      {rows.length === 0 && (
        <p className="text-[11.5px] text-ink-500">No rule: used only when someone picks it, the request names it, or it is the default.</p>
      )}
      {rows.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-700">
          Use when
          <select value={join} onChange={e => onChange(e.target.value as 'and' | 'or', rows)} className="h-6 border border-input bg-card rounded-sm px-1.5 text-[11.5px]">
            <option value="and">all of these hold</option>
            <option value="or">any of these holds</option>
          </select>
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <select
            value={r.key}
            onChange={e => set(i, { key: e.target.value, op: numeric(e.target.value) ? 'gt' : 'eq' })}
            className="h-8 border border-input bg-card rounded-md px-2 text-[12px] text-ink-950 w-44"
            aria-label="What to test"
          >
            {CONDITION_KEYS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <select
            value={r.op}
            onChange={e => set(i, { op: e.target.value as Op })}
            className="h-8 border border-input bg-card rounded-md px-2 text-[12px] text-ink-950 w-32"
            aria-label="How"
          >
            {OPS.filter(o => !o.numeric || numeric(r.key)).map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          <Input value={r.value} onChange={e => set(i, { value: e.target.value })} placeholder={PLACEHOLDER[r.key] ?? ''} className="flex-1 h-8 text-[12px]" aria-label="Value" />
          <button type="button" onClick={() => onChange(join, rows.filter((_, j) => j !== i))} className="p-1 text-ink-400 hover:text-risk-600" aria-label="Remove this test">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="xs" onClick={() => onChange(join, [...rows, { key: 'counterparty.country', op: 'in', value: '' }])}>
        <Plus /> Add a test
      </Button>
    </div>
  )
}
