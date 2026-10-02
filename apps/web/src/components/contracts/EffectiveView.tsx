/**
 * docs/41 Part 13 — an agreement as its signed amendments left it: a
 * reading view, not a new legal document. Each section an amendment changed
 * is marked "Amended by A1 (§5)" and can show the words it replaced; each
 * term an amendment changed shows its value now, and "Show amended values"
 * lists what it was before.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

interface Section {
  clauseId: string; clauseType: string; sectionRef: string | null; originalText: string; text: string; deleted: boolean
  amendedBy: Array<{ contractId: string; label: string; short: string; effectiveDate: string | null; action: 'replace' | 'delete' }>
}
interface TermValue { id: string; display: string; quote: string | null; source: { contractId: string; title: string; label: string | null } | null; effectiveFrom: string | null; current: boolean }

const ref = (s: { sectionRef: string | null; clauseType: string }) =>
  s.sectionRef ? `§${s.sectionRef.replace(/^(section|§)\s*/i, '')}` : s.clauseType.replace(/_/g, ' ')

export function useEffectiveView(contractId: string, enabled = true) {
  return useQuery({
    queryKey: ['contract-effective', contractId],
    enabled,
    queryFn: async () => (await api.get<{ sections: Section[] }>(`/contracts/${contractId}/effective`)).data,
  })
}

export function EffectiveView({ contractId }: { contractId: string }) {
  const view = useEffectiveView(contractId)
  const history = useQuery({
    queryKey: ['contract-term-history', contractId],
    queryFn: async () => (await api.get<{ terms: Record<string, { label: string | null; values: TermValue[] }> }>(`/contracts/${contractId}/term-history`)).data,
  })
  const [showOld, setShowOld] = useState(false)
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const terms = Object.entries(history.data?.terms ?? {})
  const amended = (view.data?.sections ?? []).filter(s => s.amendedBy.length)

  return (
    <div className="space-y-4" data-testid="effective-view">
      <p className="text-[11.5px] text-ink-500">A reading view of the agreement with its signed amendments applied. The signed documents stay as they are.</p>
      {terms.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[12px] font-medium text-ink-950">Amended key terms</p>
            <Button size="xs" variant="ghost" onClick={() => setShowOld(v => !v)} data-testid="show-amended-values">
              {showOld ? 'Hide amended values' : 'Show amended values'}
            </Button>
          </div>
          <ul className="divide-y divide-paper-100 border border-paper-200 rounded-md">
            {terms.map(([key, t]) => {
              const now = t.values.find(v => v.current)
              const before = t.values.filter(v => !v.current)
              return (
                <li key={key} className="px-2.5 py-2 text-[12px]">
                  <p className="text-ink-950"><span className="font-medium">{t.label ?? key}</span> {now?.display}</p>
                  {now?.source && (
                    <p className="text-[11px] text-ink-500">
                      Amended by <Link className="underline underline-offset-2" to={`/contracts/${now.source.contractId}`}>{now.source.label ?? now.source.title}</Link>
                      {now.effectiveFrom && <> from {now.effectiveFrom}</>}
                    </p>
                  )}
                  {showOld && before.map(b => (
                    <p key={b.id} className="text-[11px] text-ink-500 line-through decoration-ink-300">
                      {b.display || 'not set'} <span className="no-underline">· {b.source ? b.source.label ?? b.source.title : 'original'}</span>
                    </p>
                  ))}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div>
        <p className="text-[12px] font-medium text-ink-950 mb-1">Amended sections</p>
        {!amended.length && <p className="text-[11.5px] text-ink-500">No section has been changed by a signed amendment.</p>}
        <ul className="space-y-2">
          {amended.map(s => {
            const last = s.amendedBy[s.amendedBy.length - 1]
            const open = opened.has(s.clauseId)
            return (
              <li key={s.clauseId} className="border border-paper-200 rounded-md px-2.5 py-2" data-testid={`effective-section-${s.clauseId}`}>
                <p className="text-[11px] text-ink-500">
                  Amended by {s.amendedBy.map(a => a.short).join(', ')} ({ref(s)})
                  {last.action === 'delete' && ' · deleted'}
                </p>
                <p className="text-[12px] text-ink-950 whitespace-pre-wrap mt-1">{s.deleted ? <span className="text-ink-500">This section was deleted.</span> : s.text}</p>
                <button className="text-[11px] text-ink-500 underline underline-offset-2 mt-1"
                  onClick={() => setOpened(o => { const n = new Set(o); if (n.has(s.clauseId)) n.delete(s.clauseId); else n.add(s.clauseId); return n })}>
                  {open ? 'Hide the original words' : 'Show the original words'}
                </button>
                {open && <p className="text-[11.5px] text-ink-500 whitespace-pre-wrap mt-1 border-l-2 border-paper-200 pl-2">{s.originalText}</p>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
