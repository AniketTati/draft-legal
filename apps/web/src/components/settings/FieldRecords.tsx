/**
 * FieldRecords (docs/39 B3/I2) — how often the AI is right about each field,
 * and when each field's values need a person.
 *
 * Every check of an AI value keeps it or corrects it; per field that is a
 * record ("kept 18, corrected 6 — right 75% of the time"). A field wrong often
 * needs attention: a clearer description, or checking every value. The record
 * also lowers how sure the next values are, so they reach a person. Each
 * field's check level — always, when unsure (the default), only when very
 * unsure — decides which values the Review Queue and the contract page ask
 * about.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Gauge } from 'lucide-react'
import { CHECK_LEVELS, CHECK_LEVEL_LABELS, type CheckLevel } from '@clm/types'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { toast } from '@/components/common/Toaster'

interface FieldRecord {
  key: string
  label: string
  kind: 'core' | 'type' | 'custom'
  contractTypes: string[] | null
  confirmed: number
  corrected: number
  accuracy: number | null
  unchecked: number
  check: CheckLevel
  attention: boolean
}

const MIN_CHECKS = 5

function detail(e: unknown): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (e as Error)?.message ?? 'Unknown error'
}

export function FieldRecords() {
  const qc = useQueryClient()
  const canSet = useCanRequest('PUT /field-definitions/checks')
  const [showAll, setShowAll] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['field-records'],
    queryFn: async () => (await api.get<{ fields: FieldRecord[] }>('/field-definitions/records')).data.fields,
  })

  const setLevel = useMutation({
    mutationFn: async (a: { key: string; level: CheckLevel }) => (await api.put('/field-definitions/checks', a)).data,
    onMutate: a => {
      // Shown at once; put back if the save fails.
      const before = qc.getQueryData<FieldRecord[]>(['field-records'])
      qc.setQueryData<FieldRecord[]>(['field-records'], rows => rows?.map(r => (r.key === a.key ? { ...r, check: a.level } : r)))
      return { before }
    },
    onSuccess: (_r, a) => {
      qc.invalidateQueries({ queryKey: ['review-queue'] })
      qc.invalidateQueries({ queryKey: ['contract-fields'] })
      const label = data?.find(r => r.key === a.key)?.label ?? a.key
      toast.success(a.level === 'always' ? `Every ${label} value will be checked` : `${label}: checked ${CHECK_LEVEL_LABELS[a.level].toLowerCase()}`)
    },
    onError: (e, _a, ctx) => {
      if (ctx?.before) qc.setQueryData(['field-records'], ctx.before)
      toast.error('Couldn’t save', { description: detail(e) })
    },
  })

  // The fields there is something to say about: a record, values waiting, or a level set.
  const rows = useMemo(() => {
    const all = data ?? []
    return showAll ? all : all.filter(r => r.confirmed + r.corrected > 0 || r.unchecked > 0 || r.check !== 'unsure')
  }, [data, showAll])
  const attention = (data ?? []).filter(r => r.attention).length

  return (
    <section className="mt-8" data-testid="field-records">
      <header className="mb-3">
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <Gauge className="size-4 text-ink-700" /> How often the AI is right
        </h2>
        <p className="text-dense text-ink-500 mt-1 max-w-3xl">
          Each time someone checks a value the AI read, they keep it or correct it. A field that's corrected often needs attention —
          describe it better, or have every value checked — and its next values are marked less sure, so they reach a person.
        </p>
        {attention > 0 && (
          <p className="text-[12px] text-attention-700 mt-2 inline-flex items-center gap-1.5" data-testid="field-records-attention">
            <AlertTriangle className="size-3.5" /> {attention} field{attention === 1 ? ' needs' : 's need'} attention
          </p>
        )}
      </header>

      <div className="bg-card rounded-card border border-paper-200 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)] gap-4 px-5 py-2 border-b border-paper-200 bg-paper-50 text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-400">
          <span>Field</span><span>Right</span><span>Not checked yet</span><span>Check its values</span>
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-dense text-ink-500">Loading…</p>
        ) : !rows.length ? (
          <p className="px-5 py-6 text-dense text-ink-500">Nobody has checked a value the AI read yet. Records build up as people check fields — in a contract, or in the Review Queue.</p>
        ) : (
          <ul className="divide-y divide-paper-100">
            {rows.map(r => {
              const checks = r.confirmed + r.corrected
              return (
                <li key={r.key} className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)] gap-4 items-center px-5 py-2.5" data-testid={`field-record-${r.key}`}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink-950 truncate">{r.label}</p>
                    <p className="text-[11px] text-ink-400 truncate">
                      {r.kind === 'custom' ? 'Custom' : r.kind === 'type' ? (r.contractTypes ?? []).map(t => t.replace(/_/g, ' ')).join(', ') : 'Standard'}
                    </p>
                  </div>
                  <div className="min-w-0">
                    {r.accuracy != null ? (
                      <p className={cn('text-[13px] tabular-nums', r.attention ? 'text-attention-700 font-semibold' : 'text-ink-950')}>
                        {Math.round(r.accuracy * 100)}%
                        {r.attention && <span className="ml-1.5 text-[11px] font-medium">needs attention</span>}
                      </p>
                    ) : (
                      <p className="text-[12px] text-ink-400">{checks ? `${MIN_CHECKS - checks} more check${MIN_CHECKS - checks === 1 ? '' : 's'} to tell` : 'No checks yet'}</p>
                    )}
                    {checks > 0 && (
                      <p className="text-[11px] text-ink-500 tabular-nums">kept {r.confirmed}, corrected {r.corrected}</p>
                    )}
                  </div>
                  {/* Every AI value nobody checked; the Review Queue lists the ones that need a person. */}
                  <div className="text-[12.5px] tabular-nums" title="Values the AI read that nobody has checked">
                    {r.unchecked > 0 ? <span className="text-ink-950">{r.unchecked}</span> : <span className="text-ink-400">—</span>}
                  </div>
                  <div>
                    <select
                      value={r.check}
                      disabled={!canSet || setLevel.isPending}
                      onChange={e => setLevel.mutate({ key: r.key, level: e.target.value as CheckLevel })}
                      aria-label={`When to check ${r.label}`}
                      data-testid={`field-check-${r.key}`}
                      className="h-8 w-full text-[12.5px] text-ink-950 rounded-md border border-input bg-card px-2 focus:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15 disabled:opacity-60"
                    >
                      {CHECK_LEVELS.map(l => <option key={l} value={l}>{CHECK_LEVEL_LABELS[l]}</option>)}
                    </select>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {!!data?.length && (
          <button
            type="button" onClick={() => setShowAll(v => !v)}
            className="w-full px-5 py-2 text-left text-[11.5px] text-ink-500 hover:text-ink-950 border-t border-paper-200"
            data-testid="field-records-toggle"
          >
            {showAll ? 'Only fields with checks or values waiting' : `All ${data.length} fields`}
          </button>
        )}
      </div>
    </section>
  )
}
