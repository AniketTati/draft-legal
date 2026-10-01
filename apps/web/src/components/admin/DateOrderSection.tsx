/**
 * DateOrderSection (docs/39 A11) — how the org writes dates with numbers.
 *
 * "03/04/2025" is 4 March in the US and 3 April almost everywhere else. The
 * AI read such dates one way for everyone, and a typed date the same, so a
 * UK team's renewals could be a month out. The org says which it uses; the
 * AI is told, a person's typed date is read so, and a date the contract
 * writes so it could be either is still flagged for checking.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import type { DateOrder } from '@clm/types'
import { api } from '@/lib/api'
import { toast } from '@/components/common/Toaster'

const ORDERS: Array<{ value: DateOrder; label: string; example: string }> = [
  { value: 'MDY', label: 'Month first', example: '03/04/2025 is March 4, 2025 (US)' },
  { value: 'DMY', label: 'Day first', example: '03/04/2025 is 3 April 2025 (UK, EU, India, most of the world)' },
]

export function DateOrderSection() {
  const qc = useQueryClient()
  const { data: org } = useQuery<{ settings?: { dateOrder?: DateOrder } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
  })
  const current: DateOrder = org?.settings?.dateOrder === 'DMY' ? 'DMY' : 'MDY'

  const save = useMutation({
    mutationFn: (dateOrder: DateOrder) => api.patch('/organization', { settings: { dateOrder } }).then(r => r.data),
    onSuccess: (_data, order) => {
      toast.success('Date format saved', { description: ORDERS.find(o => o.value === order)?.example })
      qc.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (e: { response?: { data?: { detail?: string } } }) => {
      toast.error('Save failed', { description: e.response?.data?.detail ?? 'Unknown error' })
    },
  })

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="date-order-section">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <CalendarDays className="size-4 text-ink-700" />
          Dates written with numbers
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          How your contracts and your team write dates like 03/04/2025. The AI reads contracts this way, and a date typed into a field is read this way.
          A date a contract writes so it could be read either way is still flagged for someone to check.
        </p>
      </header>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Dates written with numbers">
        {ORDERS.map(o => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            disabled={save.isPending}
            onClick={() => { if (o.value !== current) save.mutate(o.value) }}
            data-testid={`date-order-${o.value}`}
            className={`text-left rounded-md border p-3 transition-colors ${
              current === o.value ? 'border-ink-950 bg-paper-50' : 'border-paper-200 hover:border-paper-300'
            }`}
          >
            <span className="block text-[12.5px] font-semibold text-ink-950">{o.label}</span>
            <span className="block text-[11.5px] text-ink-500 mt-0.5">{o.example}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
