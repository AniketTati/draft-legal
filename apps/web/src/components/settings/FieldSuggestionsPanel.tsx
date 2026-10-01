/**
 * FieldSuggestionsPanel (docs/39 C3) — fields people asked for from words
 * they highlighted in a contract, for an admin to add or decline. Adding one
 * also saves the value it was asked with on the contract it came from; the
 * person who asked is told either way.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lightbulb, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useCanRequest } from '@/lib/permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/common/Toaster'

interface Suggestion {
  id: string
  label: string
  fieldKey: string
  fieldType: string
  contractType: string | null
  helpText: string | null
  exampleContractId: string | null
  exampleContractTitle: string | null
  exampleQuote: string | null
  suggestedBy: string | null
  createdAt: string
}

const TYPE_LABEL: Record<string, string> = {
  text: 'text', longtext: 'long text', date: 'date', duration: 'length of time', currency: 'amount of money',
  number: 'number', percentage: 'percentage', boolean: 'yes / no', select: 'one of a list', multiselect: 'several of a list',
}

const detail = (e: unknown) => (e as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Try again.'

export function FieldSuggestionsPanel() {
  const qc = useQueryClient()
  const canReview = useCanRequest('GET /field-suggestions')
  const [declining, setDeclining] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const { data } = useQuery({
    queryKey: ['field-suggestions'],
    queryFn: async () => (await api.get<{ data: Suggestion[] }>('/field-suggestions')).data.data,
    enabled: canReview,
  })

  const add = useMutation({
    mutationFn: async (s: Suggestion) => (await api.post<{ exampleSaved: boolean }>(`/field-suggestions/${s.id}/add`)).data,
    onSuccess: (r, s) => {
      toast.success(`${s.label} added`, { description: r.exampleSaved && s.exampleContractTitle ? `And its value saved on ${s.exampleContractTitle}.` : undefined })
      qc.invalidateQueries({ queryKey: ['field-suggestions'] })
      qc.invalidateQueries({ queryKey: ['field-definitions'] })
    },
    onError: err => toast.error("Couldn't add the field", { description: detail(err) }),
  })
  const decline = useMutation({
    mutationFn: async (a: { s: Suggestion; reason: string }) => (await api.post(`/field-suggestions/${a.s.id}/decline`, { reason: a.reason || undefined })).data,
    onSuccess: (_r, a) => {
      toast.info(`${a.s.label} declined`, { description: a.s.suggestedBy ? `${a.s.suggestedBy} will be told.` : undefined })
      setDeclining(null); setReason('')
      qc.invalidateQueries({ queryKey: ['field-suggestions'] })
    },
    onError: err => toast.error("Couldn't decline", { description: detail(err) }),
  })

  if (!canReview || !data?.length) return null
  return (
    <section className="bg-card rounded-card border border-attention-200 p-4 space-y-3" data-testid="field-suggestions">
      <h2 className="text-section text-ink-950 flex items-center gap-2">
        <Lightbulb className="size-4 text-attention-600" />
        Suggested fields <span className="text-ink-400 font-normal tabular-nums">{data.length}</span>
      </h2>
      <div className="divide-y divide-paper-100">
        {data.map(s => (
          <div key={s.id} className="py-2.5 first:pt-0 last:pb-0" data-testid={`field-suggestion-${s.fieldKey}`}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink-950">
                  {s.label}
                  <span className="ml-2 text-[11.5px] font-normal text-ink-500">
                    {TYPE_LABEL[s.fieldType] ?? s.fieldType} · {s.contractType ? `${s.contractType.replace(/_/g, ' ')} contracts` : 'every contract'}
                  </span>
                </p>
                <p className="text-[11.5px] text-ink-500 mt-0.5">
                  {s.suggestedBy ?? 'Someone'} asked
                  {s.exampleContractId && (
                    <> from <Link to={`/contracts/${s.exampleContractId}`} className="text-ink-700 hover:underline underline-offset-2">{s.exampleContractTitle ?? 'a contract'}</Link></>
                  )}
                  {s.exampleQuote && <span className="italic"> — “{s.exampleQuote.length > 90 ? `${s.exampleQuote.slice(0, 90)}…` : s.exampleQuote}”</span>}
                </p>
                {s.helpText && <p className="text-[11.5px] text-ink-700 mt-0.5">{s.helpText}</p>}
              </div>
              {declining !== s.id && (
                <div className="flex gap-1.5 shrink-0">
                  <Button size="xs" variant="ghost" onClick={() => { setDeclining(s.id); setReason('') }} disabled={add.isPending}>Decline</Button>
                  <Button size="xs" onClick={() => add.mutate(s)} disabled={add.isPending} data-testid={`field-suggestion-add-${s.fieldKey}`}>
                    {add.isPending && add.variables?.id === s.id && <Loader2 className="animate-spin" />}
                    Add field
                  </Button>
                </div>
              )}
            </div>
            {declining === s.id && (
              <form className="flex items-center gap-1.5 mt-2" onSubmit={e => { e.preventDefault(); decline.mutate({ s, reason }) }}>
                <Input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why not? (optional, sent to them)" className="h-7 text-[12px]" maxLength={500} />
                <Button type="button" size="xs" variant="ghost" onClick={() => setDeclining(null)}>Cancel</Button>
                <Button type="submit" size="xs" variant="danger" disabled={decline.isPending}>Decline</Button>
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
