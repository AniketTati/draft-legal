/**
 * docs/41 Part 16 (C2) — the workspace's Details view: the contract page's
 * rail sections, as they are there (the key terms and fields with their
 * parties and dates, the agreement it amends, where the draft came from, its
 * matter), and the documents that go with it.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { api } from '@/lib/api'
import { FieldsPanel, type ContractField } from '@/components/contracts/FieldsPanel'
import { AgreementPanel } from '@/components/contracts/AgreementPanel'
import { OriginRailSection } from '@/components/contracts/OriginRailSection'
import { MatterRailSection } from '@/components/contracts/MatterRailSection'
import { RailSection } from '@/components/contracts/RailSection'

interface Family {
  parent?: { id: string; title: string } | null
  children?: Array<{ id: string; title: string; relationshipType?: string | null }>
}

export function WorkspaceDetails({ contractId, matterId, canEdit, canEditFields, beforeChange, onShowSource }: {
  contractId: string
  matterId: string | null
  canEdit: boolean
  canEditFields: boolean
  /** Save typing still waiting before the draft changes on the server. */
  beforeChange: () => Promise<unknown>
  onShowSource?: (f: ContractField) => void
}) {
  const { data: family } = useQuery<Family>({
    queryKey: ['contract-family', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/family`).then(r => r.data),
  })
  const related = [
    ...(family?.parent ? [{ id: family.parent.id, title: family.parent.title, kind: 'Parent' }] : []),
    ...(family?.children ?? []).map(c => ({ id: c.id, title: c.title, kind: c.relationshipType ?? 'Related' })),
  ]
  return (
    <div className="space-y-1" data-testid="workspace-details">
      <RailSection title="Key terms and fields" defaultOpen>
        <FieldsPanel contractId={contractId} canEdit={canEditFields} variant="rail" onShowSource={onShowSource} />
      </RailSection>
      <AgreementPanel contractId={contractId} canEdit={canEditFields} />
      <OriginRailSection contractId={contractId} canEdit={canEdit} beforeChange={beforeChange} />
      <MatterRailSection matterId={matterId} />
      <RailSection title="Related documents" count={related.length || null}>
        {related.length === 0
          ? <p className="text-dense text-ink-400">No related documents.</p>
          : (
            <ul className="space-y-2" data-testid="workspace-related">
              {related.map(r => (
                <li key={r.id} className="flex items-start gap-2">
                  <Link2 className="size-3.5 text-ink-400 mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">{r.kind}</div>
                    <Link to={`/contracts/${r.id}`} className="text-dense text-ink-950 hover:underline truncate block">{r.title}</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </RailSection>
    </div>
  )
}
