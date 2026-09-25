/**
 * Z8 — how personal data is handled before any text reaches an AI model
 * (lib/pii-policy.ts on the API). The mode could only be changed through the
 * API. Admin-only on the server, and every change is audited there.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/components/common/Toaster'

type Mode = 'redact' | 'tokenize' | 'off'

export const PRIVACY_MODES: Array<{ value: Mode; label: string; hint: string }> = [
  { value: 'redact',   label: 'Redact',   hint: 'Replace personal data with a marker such as [REDACTED:SSN]. The default.' },
  { value: 'tokenize', label: 'Tokenize', hint: 'Replace each value with a stable placeholder, so the AI can tell values apart without seeing them.' },
  { value: 'off',      label: 'Off',      hint: 'Send text as it is. Only for a model you host or have agreed terms with.' },
]

export function PrivacyModeSection() {
  const qc = useQueryClient()
  const { data: org } = useQuery<{ settings?: { piiRedactionMode?: Mode } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
  })
  const current: Mode = org?.settings?.piiRedactionMode ?? 'redact'

  const save = useMutation({
    mutationFn: (mode: Mode) => api.patch('/organization', { settings: { piiRedactionMode: mode } }).then(r => r.data),
    onSuccess: (_data, mode) => {
      toast.success('Privacy mode saved', { description: PRIVACY_MODES.find(m => m.value === mode)?.label })
      qc.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (e: { response?: { data?: { detail?: string } } }) => {
      toast.error('Save failed', { description: e.response?.data?.detail ?? 'Unknown error' })
    },
  })

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-4" data-testid="privacy-mode-section">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-700" />
          Personal data sent to AI
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          Before any text reaches an AI model, personal data such as SSNs, tax IDs, card and bank numbers, passport numbers
          and dates of birth is handled this way. Values are put back in the drafts you keep. Every change is recorded in the audit log.
        </p>
      </header>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Personal data sent to AI">
        {PRIVACY_MODES.map(mode => (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={current === mode.value}
            disabled={save.isPending}
            onClick={() => { if (mode.value !== current) save.mutate(mode.value) }}
            data-testid={`privacy-mode-${mode.value}`}
            className={`text-left rounded-md border p-3 transition-colors ${
              current === mode.value ? 'border-ink-700 bg-paper-100' : 'border-paper-200 hover:bg-paper-50'
            }`}
          >
            <p className="text-body font-medium text-ink-950">{mode.label}</p>
            <p className="text-dense text-ink-500 mt-0.5">{mode.hint}</p>
          </button>
        ))}
      </div>
    </section>
  )
}
