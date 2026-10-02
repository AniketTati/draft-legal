/**
 * docs/41 Part 1 — what drafting this request will use, before it is drafted.
 *
 * The template and each clause choice are decided by the org's rules (the
 * one picked here, the request's own words, a rule, a default), never by an
 * AI guess. The panel shows each decision and why, and lets the reviewer pick
 * where nothing decided — or change what was. A choice left open stays open
 * in the draft, which then can't be sent until someone makes it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileText, Loader2 } from 'lucide-react'
import { SLOT_DECIDED_BY_LABEL, type SlotDecision } from '@clm/types'
import { api, apiErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Eyebrow } from '@/components/ui/primitives'
import { toast } from '@/components/common/Toaster'

type Slot = SlotDecision & { sectionId: string; options: Array<{ id: string; label: string }> }

export interface RequestDraftPlanData {
  drafted: boolean
  choices: { templateId?: string; slots?: Record<string, string> }
  templates: Array<{ id: string; name: string; contractType: string | null; isDefaultForType: boolean }>
  template: { id: string; name: string; decidedBy: 'explicit' | 'default_for_type' | 'only_one' } | null
  templateProblem: { code: string; detail: string } | null
  slots: Slot[]
  openChoices: number
}

const TEMPLATE_WHY: Record<string, string> = {
  explicit: 'Picked for this request',
  default_for_type: 'Your default for this type',
  only_one: 'Your only template for this type',
}

export function useRequestDraftPlan(requestId: string, enabled = true) {
  return useQuery({
    queryKey: ['request-draft-plan', requestId],
    queryFn: () => api.get<RequestDraftPlanData>(`/requests/${requestId}/draft-plan`).then(r => r.data),
    enabled,
  })
}

export function RequestDraftPlan({ requestId, editable }: { requestId: string; editable: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading } = useRequestDraftPlan(requestId)
  const choose = useMutation({
    meta: { errorHandled: true },
    mutationFn: (body: { templateId?: string | null; slots?: Record<string, string | null> }) => api.put(`/requests/${requestId}/draft-choices`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['request-draft-plan', requestId] }),
    onError: e => toast.error('Not changed', { description: apiErrorMessage(e) }),
  })
  if (isLoading) return <Loader2 className="size-4 animate-spin text-ink-400" />
  if (!data || !data.drafted) return null

  return (
    <div className="space-y-3" data-testid="request-draft-plan">
      <Eyebrow count={data.openChoices ? `${data.openChoices} to choose` : undefined}>Drafting will use</Eyebrow>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5 text-ink-400 shrink-0" />
          <select
            value={data.choices.templateId ?? data.template?.id ?? ''}
            onChange={e => choose.mutate({ templateId: e.target.value || null })}
            disabled={!editable || choose.isPending}
            className={cn('flex-1 h-8 border bg-card rounded-md px-2 text-[12.5px] text-ink-950', data.templateProblem ? 'border-attention-300' : 'border-input')}
            data-testid="request-template-select"
            aria-label="Template"
          >
            {!data.template && <option value="">Pick a template…</option>}
            {data.templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefaultForType ? ' (default)' : ''}</option>)}
          </select>
        </div>
        {data.template && <p className="text-[11.5px] text-ink-500 pl-5">{TEMPLATE_WHY[data.template.decidedBy]}</p>}
        {data.templateProblem && (
          <p className="text-[11.5px] text-attention-700 pl-5 flex items-start gap-1" data-testid="request-template-problem">
            <AlertTriangle className="size-3 shrink-0 mt-0.5" /> {data.templateProblem.detail}
          </p>
        )}
      </div>

      {data.slots.length > 0 && (
        <ul className="space-y-2">
          {data.slots.map(s => (
            <li key={s.familyId} className="space-y-1" data-testid={`request-slot-${s.familyId}`}>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-ink-500 w-28 shrink-0 truncate" title={s.familyName}>{s.familyName}</span>
                <select
                  value={data.choices.slots?.[s.familyId] ?? s.variantId ?? ''}
                  onChange={e => choose.mutate({ slots: { [s.familyId]: e.target.value || null } })}
                  disabled={!editable || choose.isPending}
                  className={cn('flex-1 h-8 border bg-card rounded-md px-2 text-[12.5px] text-ink-950', s.decidedBy === 'unresolved' ? 'border-attention-300' : 'border-input')}
                  aria-label={s.familyName}
                >
                  {s.decidedBy === 'unresolved' && <option value="">Choose…</option>}
                  {data.choices.slots?.[s.familyId] && <option value="">Decide by the rules</option>}
                  {s.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
              <p className={cn('text-[11.5px] pl-[120px]', s.decidedBy === 'unresolved' ? 'text-attention-700' : 'text-ink-500')}>
                {SLOT_DECIDED_BY_LABEL[s.decidedBy]}
                {s.evidence?.quote ? <>: “{s.evidence.quote}”</> : null}
                {s.rule ? <>: {s.rule}</> : null}
                {s.decidedBy === 'unresolved' && s.reason ? <> — {s.reason} The draft will ask until someone chooses.</> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
