/**
 * docs/41 Part 1 — why a draft says what it says: the template and version it
 * was made from, and for each clause choice the option used and what decided
 * it (a person, the request's words, a rule, the default). A choice nothing
 * decided is open: pick it here, and the draft's blank becomes that option's
 * words, as a new version.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { SLOT_DECIDED_BY_LABEL, type DraftOrigin } from '@clm/types'
import { api, apiErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import { RailSection } from './RailSection'

interface OriginResponse {
  origin: DraftOrigin | null
  template?: { id: string; name: string; deleted: boolean; latestVersion: number | null } | null
}

const TEMPLATE_WHY: Record<DraftOrigin['templateDecidedBy'], string> = {
  explicit: 'picked',
  default_for_type: 'the default for its type',
  only_one: 'the only template for its type',
}

function OpenChoice({ contractId, slot, canEdit, beforeChange }: {
  contractId: string
  slot: DraftOrigin['slots'][number]
  canEdit: boolean
  beforeChange: () => Promise<unknown>
}) {
  const qc = useQueryClient()
  const [pick, setPick] = useState('')
  const choose = useMutation({
    meta: { errorHandled: true },
    mutationFn: async () => {
      await beforeChange()
      return api.post(`/contracts/${contractId}/origin/slots/${slot.familyId}`, { variantId: pick })
    },
    onSuccess: () => {
      for (const key of ['contract', 'contract-versions', 'contract-checks', 'contract-origin', 'contract-variables']) qc.invalidateQueries({ queryKey: [key, contractId] })
      toast.success(`${slot.familyName}: ${slot.options.find(o => o.id === pick)?.label ?? 'chosen'}`, { description: 'Saved as a new version of the draft.' })
    },
    onError: e => toast.error('Not chosen', { description: apiErrorMessage(e) }),
  })
  if (!canEdit) return <p className="text-[11.5px] text-attention-700">{slot.reason ?? 'Someone who can edit this draft needs to choose.'}</p>
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <select
        value={pick}
        onChange={e => setPick(e.target.value)}
        className="flex-1 h-7 border border-attention-300 bg-card rounded-md px-2 text-[12px]"
        aria-label={`Choose ${slot.familyName}`}
        data-testid={`origin-choose-${slot.familyId}`}
      >
        <option value="">Choose…</option>
        {slot.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <Button size="xs" onClick={() => choose.mutate()} disabled={!pick || choose.isPending}>
        {choose.isPending && <Loader2 className="animate-spin" />} Use
      </Button>
    </div>
  )
}

export function OriginRailSection({ contractId, canEdit, beforeChange }: {
  contractId: string
  canEdit: boolean
  /** Save edits still waiting before the draft changes on the server. */
  beforeChange: () => Promise<unknown>
}) {
  const { data } = useQuery({
    queryKey: ['contract-origin', contractId],
    queryFn: () => api.get<OriginResponse>(`/contracts/${contractId}/origin`).then(r => r.data),
    staleTime: 30_000,
  })
  const origin = data?.origin
  if (!origin) return null
  const open = origin.slots.filter(s => s.decidedBy === 'unresolved').length
  const newer = data?.template?.latestVersion && data.template.latestVersion > origin.templateVersion ? data.template.latestVersion : null
  return (
    <RailSection title="Origin" count={open ? `${open} to choose` : null} defaultOpen={open > 0}>
      <div className="px-5 pb-4 space-y-3" data-testid="origin-panel">
        <p className="text-[12px] text-ink-700">
          Made from{' '}
          {data?.template && !data.template.deleted
            ? <Link to="/templates" className="font-medium text-ink-950 hover:underline underline-offset-2">{origin.templateName}</Link>
            : <span className="font-medium text-ink-950">{origin.templateName}</span>}
          {' '}version {origin.templateVersion} ({TEMPLATE_WHY[origin.templateDecidedBy]}).
          {newer && <span className="text-ink-500"> The template is now at version {newer}; this draft keeps what it was made with.</span>}
        </p>
        {origin.slots.length > 0 && (
          <ul className="space-y-2.5">
            {origin.slots.map(s => (
              <li key={s.familyId} data-testid={`origin-slot-${s.familyId}`}>
                <p className="text-[12px] text-ink-500">{s.familyName}</p>
                {s.variantLabel ? (
                  <p className="text-[12.5px] text-ink-950">
                    {s.variantLabel} <span className="text-[11px] text-ink-400 tabular-nums">v{s.variantVersion}</span>
                  </p>
                ) : null}
                <p className={cn('text-[11.5px]', s.decidedBy === 'unresolved' ? 'text-attention-700 font-medium' : 'text-ink-500')}>
                  {SLOT_DECIDED_BY_LABEL[s.decidedBy]}
                  {s.evidence?.quote ? <>: “{s.evidence.quote}”</> : null}
                  {s.rule ? <>: {s.rule}</> : null}
                </p>
                {s.decidedBy === 'unresolved' && <OpenChoice contractId={contractId} slot={s} canEdit={canEdit} beforeChange={beforeChange} />}
              </li>
            ))}
          </ul>
        )}
        {origin.variables.some(v => v.source === 'request_text') && (
          <div>
            <p className="text-[12px] text-ink-500 mb-1">Read from the request</p>
            <ul className="space-y-1">
              {origin.variables.filter(v => v.source === 'request_text').map(v => (
                <li key={v.key} className="text-[11.5px] text-ink-700"><span className="font-medium">{v.value}</span>{v.quote ? <> — “{v.quote}”</> : null}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </RailSection>
  )
}
