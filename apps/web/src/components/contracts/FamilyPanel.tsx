/**
 * docs/41 Part 13 — the contract family in the rail: the top agreement, its
 * amendments (numbered), renewals, SOWs, order forms and exhibits, with
 * their stage and dates, the one open marked. On the agreement, the
 * effective view (its words and terms as its signed amendments left them);
 * on an amendment drafted here, its redline against the agreement.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { RailSection } from './RailSection'
import { EffectiveView } from './EffectiveView'
import { AmendmentRedline, useAmendmentRedline } from './AmendmentRedline'

export interface FamilyMember {
  id: string; title: string; status: string; stage: string
  relationshipType: string | null; number: number | null; label: string | null
  effectiveDate: string | null; signed: boolean; changesTerms: boolean
  children: FamilyMember[]
}

const KIND: Record<string, string> = {
  amendment: 'Amendment', renewal: 'Renewal', sow: 'Statement of work', order_form: 'Order form',
  exhibit: 'Exhibit', split_part: 'Split from scanned file', nda: 'NDA', other: 'Related',
}

/** Pure: how many members a family has besides the top agreement. */
export function familySize(root: FamilyMember): number {
  return root.children.reduce((n, c) => n + 1 + familySize(c), 0)
}

function Member({ m, currentId, depth }: { m: FamilyMember; currentId: string; depth: number }) {
  const name = m.label ?? (m.relationshipType ? KIND[m.relationshipType] ?? 'Related' : m.title)
  const here = m.id === currentId
  return (
    <li>
      <div className={`flex items-baseline gap-1.5 py-1 ${here ? 'font-medium' : ''}`} style={{ paddingLeft: depth * 12 }} data-testid={`family-member-${m.id}`}>
        {depth > 0 && <span className="text-ink-300">└</span>}
        {here
          ? <span className="text-[12px] text-ink-950 truncate" aria-current="page">{name}</span>
          : <Link to={`/contracts/${m.id}`} className="text-[12px] text-ink-950 truncate hover:underline underline-offset-2">{name}</Link>}
        {m.label && depth > 0 && <span className="text-[11px] text-ink-500 truncate" title={m.title}>{m.title}</span>}
        <span className="ml-auto text-[10.5px] text-ink-500 whitespace-nowrap">
          {m.signed ? `Signed${m.effectiveDate ? ` · effective ${m.effectiveDate}` : ''}` : m.stage.replace(/_/g, ' ')}
        </span>
      </div>
      {m.children.length > 0 && (
        <ul>{m.children.map(c => <Member key={c.id} m={c} currentId={currentId} depth={depth + 1} />)}</ul>
      )}
    </li>
  )
}

export function FamilyPanel({ contractId }: { contractId: string }) {
  const [view, setView] = useState<'family' | 'effective' | 'redline'>('family')
  const { data } = useQuery({
    queryKey: ['contract-family-tree', contractId],
    queryFn: async () => (await api.get<{ root: FamilyMember; currentId: string }>(`/contracts/${contractId}/family-tree`)).data,
  })
  const isRoot = data?.root.id === contractId
  const redline = useAmendmentRedline(contractId, !!data && !isRoot)
  if (!data || familySize(data.root) === 0) return null
  const signedChangers = data.root.children.some(c => c.signed && c.changesTerms)
  const hasRedline = !isRoot && (redline.data?.items.length ?? 0) > 0

  return (
    <RailSection title="Contract family" count={familySize(data.root) + 1} defaultOpen>
      <div className="space-y-2" data-testid="family-panel">
        {(signedChangers && isRoot) || hasRedline ? (
          <div className="flex gap-1">
            <Button size="xs" variant={view === 'family' ? 'default' : 'outline'} onClick={() => setView('family')}>Family</Button>
            {isRoot && <Button size="xs" variant={view === 'effective' ? 'default' : 'outline'} onClick={() => setView('effective')} data-testid="family-effective">As amended</Button>}
            {hasRedline && <Button size="xs" variant={view === 'redline' ? 'default' : 'outline'} onClick={() => setView('redline')} data-testid="family-redline">What it changes</Button>}
          </div>
        ) : null}
        {view === 'family' && <ul><Member m={data.root} currentId={data.currentId} depth={0} /></ul>}
        {view === 'effective' && isRoot && <EffectiveView contractId={contractId} />}
        {view === 'redline' && redline.data && (
          <>
            <p className="text-[11.5px] text-ink-500">The agreement’s words in effect, against the words this amendment signs.</p>
            <AmendmentRedline items={redline.data.items} />
          </>
        )}
      </div>
    </RailSection>
  )
}
