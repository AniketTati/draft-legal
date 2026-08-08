/**
 * CreateAmendmentDialog (Phase 08 Step 8)
 *
 * Modal that creates a new draft contract linked to a parent via
 * parentContractId. Used to spawn amendments / SOWs / order forms /
 * renewals that should live as their own contract record but stay
 * connected to the parent for family-tree views.
 *
 * After creation the user is redirected to the new contract so they
 * can edit / draft via the agent / upload a file before signing.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GitBranch, X, Loader2 } from 'lucide-react'

interface Props {
  parentContractId: string
  parentTitle:      string
  open:             boolean
  onClose:          () => void
  onCreated?:       (newId: string) => void
}

const REL_TYPES = [
  { key: 'amendment',    label: 'Amendment',    desc: 'Modifies a clause, term, or value of the parent.' },
  { key: 'sow',          label: 'Statement of Work', desc: 'Project-specific scope under an MSA.' },
  { key: 'order_form',   label: 'Order Form',   desc: 'Procurement / pricing addendum.' },
  { key: 'renewal',      label: 'Renewal',      desc: 'Extends the parent past its expiry.' },
  { key: 'exhibit_only', label: 'Exhibit',      desc: 'Schedule, exhibit, or appendix.' },
]

export function CreateAmendmentDialog({ parentContractId, parentTitle, open, onClose, onCreated }: Props) {
  const navigate = useNavigate()
  const [title, setTitle]                         = useState('')
  const [relationshipType, setRelationshipType]   = useState('amendment')
  const [description, setDescription]             = useState('')
  const [error, setError]                         = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const r = await api.post(`/contracts/${parentContractId}/amendments`, {
        title:            title.trim() || undefined,
        relationshipType,
        description:      description.trim() || undefined,
      })
      return r.data as { id: string; title: string }
    },
    onSuccess: (data) => {
      onCreated?.(data.id)
      onClose()
      setTitle(''); setDescription(''); setRelationshipType('amendment'); setError(null)
      navigate(`/contracts/${data.id}`)
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail ?? 'Failed to create amendment.')
    },
  })

  if (!open) return null

  const selectedRel = REL_TYPES.find(r => r.key === relationshipType)

  return (
    <div
      role="dialog"
      aria-label="Create amendment"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto"
      onClick={onClose}
      data-testid="create-amendment-dialog"
    >
      <div
        className="bg-card rounded-card max-w-lg w-full shadow-e3 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-paper-200 flex items-start justify-between">
          <div>
            <h2 className="text-section text-ink-950 flex items-center gap-2">
              {/* Drafting an amendment is the user's act, not the assistant's,
                  so nothing here keeps the indigo it used to have. */}
              <GitBranch className="size-4 text-ink-500" />
              Create amendment
            </h2>
            <p className="text-dense text-ink-500 mt-1 truncate max-w-md">
              Linked to <span className="font-medium">{parentTitle}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-chip hover:bg-paper-100 text-ink-400"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Type */}
          <div>
            <label className="block text-body font-medium text-ink-700 mb-1.5">
              Relationship type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {REL_TYPES.map(rt => (
                <button
                  key={rt.key}
                  type="button"
                  onClick={() => setRelationshipType(rt.key)}
                  data-testid={`amendment-rel-${rt.key}`}
                  className={`text-left p-2.5 rounded-md border text-body transition-colors ${
                    relationshipType === rt.key
                      ? 'border-ink-950 bg-paper-100 ring-1 ring-ink-950'
                      : 'border-paper-200 hover:border-paper-300 bg-card'
                  }`}
                >
                  <div className="font-medium text-ink-950">{rt.label}</div>
                </button>
              ))}
            </div>
            {selectedRel && (
              <p className="text-dense text-ink-500 mt-2">{selectedRel.desc}</p>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block text-body font-medium text-ink-700 mb-1">
              Title <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <Input
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
              placeholder={`${parentTitle} — ${selectedRel?.label}`}
              data-testid="amendment-title"
            />
            <p className="text-dense text-ink-400 mt-1">Leave blank to auto-generate from the parent + type.</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-body font-medium text-ink-700 mb-1">
              Description <span className="text-ink-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What's changing? Effective date, scope, value impact, etc."
              rows={3}
              data-testid="amendment-description"
              className="w-full text-[13px] text-ink-950 bg-card border border-input rounded-md px-[11px] py-2 placeholder:text-ink-400 focus:border-brand-700 focus:outline-none focus:ring-[3px] focus:ring-brand-700/12 resize-y"
            />
          </div>

          {error && (
            <div className="text-body text-risk-700 bg-risk-50 border border-risk-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-paper-200 flex justify-end gap-2 bg-paper-50 rounded-b-card">
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            data-testid="amendment-create-confirm"
          >
            {create.isPending ? (
              <><Loader2 className="size-4 animate-spin mr-1" /> Creating…</>
            ) : (
              <><GitBranch className="size-4 mr-1" /> Create draft</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
