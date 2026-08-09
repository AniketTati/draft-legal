/**
 * NewContractFlow — Phase 4.5 gap fix
 * Two-step modal:
 *   Step 1: Pick a template (TemplateSelectorModal)
 *   Step 2: Fill title / counterparty / context → call Draft Agent → navigate to contract
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Loader2, X, ArrowLeft, Wand2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { TemplateSelectorModal } from '@/components/TemplateSelectorModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Template } from '@clm/types'

interface Props {
  onClose: () => void
  onCreated: (contractId: string) => void
}

export function NewContractFlow({ onClose, onCreated }: Props) {
  const user = useAuthStore(s => s.user)
  const [step, setStep] = useState<'template' | 'details'>('template')
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [title, setTitle] = useState('')
  const [counterparty, setCounterparty] = useState('')
  const [context, setContext] = useState('')

  const draftMutation = useMutation({
    mutationFn: async () => {
      const message = [
        `Draft a ${selectedTemplate?.contractType ?? 'contract'} contract titled "${title}"`,
        counterparty ? `for ${counterparty}` : '',
        context ? `. ${context}` : '',
      ].filter(Boolean).join(' ')

      const res = await api.post('/agent/draft', {
        userMessage: message,
        templateId: selectedTemplate?.id,
        orgId: user?.orgId,
        userId: user?.id,
        saveAs: {
          title,
          orgId: user?.orgId,
          createdById: user?.id,
        },
      })
      return res.data
    },
    onSuccess: (data) => {
      const contractId = data.contractId ?? data.contract?.id
      if (contractId) onCreated(contractId)
    },
  })

  // ── Step 1: template picker ────────────────────────────────────────────────

  if (step === 'template') {
    return (
      <TemplateSelectorModal
        onSelect={(t) => {
          setSelectedTemplate(t)
          setTitle(t.name)
          setStep('details')
        }}
        onClose={onClose}
      />
    )
  }

  // ── Step 2: draft details form ─────────────────────────────────────────────

  const canSubmit = title.trim().length > 0 && !draftMutation.isPending

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg bg-card rounded-card shadow-e3 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-paper-200">
          <button
            onClick={() => setStep('template')}
            className="text-ink-400 hover:text-ink-700"
            title="Back to templates"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="flex-1">
            <h2 className="text-section text-ink-950">Draft Details</h2>
            <p className="text-dense text-ink-500">
              Template: <span className="font-medium text-ink-700">{selectedTemplate?.name}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <X className="size-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Contract title <span className="text-risk-600">*</span>
            </label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. NDA with Acme Corp"
              data-testid="draft-title-input"
            />
          </div>

          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Counterparty name
            </label>
            <Input
              value={counterparty}
              onChange={e => setCounterparty(e.target.value)}
              placeholder="e.g. Acme Corporation"
              data-testid="draft-counterparty-input"
            />
          </div>

          <div>
            <label className="block text-dense font-medium text-ink-700 mb-1.5">
              Additional context for AI
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="e.g. 2-year term, mutual NDA, governing law Delaware, SaaS licensing deal..."
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-card px-[11px] py-2 text-[13px] text-ink-950 placeholder:text-ink-400 focus-visible:outline-none focus-visible:border-brand-700 focus-visible:ring-[3px] focus-visible:ring-brand-700/15"
            />
          </div>

          {draftMutation.isError && (
            <p className="text-dense text-risk-700" data-testid="draft-error">
              {(() => {
                // P61 audit (2026-05-02). Surface the API's typed detail
                // (NO_TEMPLATE_MATCH, etc.) instead of a generic "failed"
                // — users need to know to publish a template / pick a
                // different type, not just retry.
                const err = draftMutation.error as { response?: { data?: { detail?: string } }; message?: string } | undefined
                return err?.response?.data?.detail
                  ?? err?.message
                  ?? 'Draft generation failed — please try again.'
              })()}
            </p>
          )}

          {draftMutation.isPending && (
            <div className="flex items-center gap-2 text-dense text-ink-500">
              <Loader2 className="size-4 animate-spin" />
              Generating draft with AI… this takes 20–40 seconds
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-paper-200 bg-paper-50">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => draftMutation.mutate()}
            disabled={!canSubmit}
            data-testid="draft-generate-btn"
          >
            <Wand2 className="size-3.5" />
            Generate Draft
          </Button>
        </div>
      </div>
    </div>
  )
}
