/**
 * docs/41 Part 13 — an amendment's redline: for each change it makes, the
 * agreement's words in effect now against the words being signed, marked
 * word by word (GET /contracts/:id/amendment-redline). For review and
 * approval; it reads the amendment's current text, edits included.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface Item {
  index: number
  kind: 'clause' | 'term'
  name: string
  action: 'replace' | 'delete' | 'set'
  current: string
  proposed: string
  segments: Array<{ op: 'equal' | 'delete' | 'insert'; text: string }>
}

export function useAmendmentRedline(contractId: string, enabled = true) {
  return useQuery({
    queryKey: ['amendment-redline', contractId],
    enabled,
    queryFn: async () => (await api.get<{ parent: { id: string; title: string } | null; items: Item[] }>(`/contracts/${contractId}/amendment-redline`)).data,
  })
}

export function AmendmentRedline({ items }: { items: Item[] }) {
  return (
    <ol className="space-y-3" data-testid="amendment-redline">
      {items.map(it => (
        <li key={it.index} className="border border-paper-200 rounded-md">
          <p className="px-2.5 py-1.5 border-b border-paper-100 text-[12px] font-medium text-ink-950 flex items-center gap-1.5">
            {it.name}
            <span className="text-[10.5px] font-normal text-ink-500">
              {it.action === 'delete' ? 'deleted' : it.action === 'set' ? 'new value' : 'replaced'}
            </span>
          </p>
          <p className="px-2.5 py-2 text-[12px] leading-relaxed text-ink-950 whitespace-pre-wrap">
            {it.segments.map((s, i) => s.op === 'equal'
              ? <span key={i}>{s.text}</span>
              : s.op === 'delete'
                ? <del key={i} className="text-risk-700 decoration-risk-600">{s.text}</del>
                : <ins key={i} className="text-brand-700 no-underline bg-brand-50">{s.text}</ins>)}
            {!it.segments.length && <span className="text-ink-500">Nothing to compare.</span>}
          </p>
        </li>
      ))}
    </ol>
  )
}
