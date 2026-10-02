/**
 * SigningPolicySection (docs/41 P0.8) — whether a contract may be sent for
 * signature before it is approved. Off by default: approval comes first.
 * Changing it needs the organization permission and is audited.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PenLine } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/components/common/Toaster'

export function SigningPolicySection() {
  const qc = useQueryClient()
  const { data: org } = useQuery<{ settings?: { allowSignWithoutApproval?: boolean } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
  })
  const allowed = org?.settings?.allowSignWithoutApproval === true

  const save = useMutation({
    mutationFn: (allow: boolean) => api.patch('/organization', { settings: { allowSignWithoutApproval: allow } }).then(r => r.data),
    onSuccess: (_d, allow) => {
      toast.success(allow ? 'Contracts can be signed without approval' : 'Approval is required before signing')
      qc.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (e: { response?: { data?: { detail?: string } } }) => {
      toast.error('Save failed', { description: e.response?.data?.detail ?? 'Unknown error' })
    },
  })

  return (
    <section className="bg-card rounded-card border border-paper-200 p-5 space-y-3" data-testid="signing-policy-section">
      <header>
        <h2 className="text-section text-ink-950 flex items-center gap-2">
          <PenLine className="size-4 text-ink-700" />
          Approval before signing
        </h2>
        <p className="text-dense text-ink-500 mt-1">
          A contract is sent for signature only once it has been approved. Turn this off only if your team approves contracts outside this app.
        </p>
      </header>
      <label className="flex items-center gap-2 text-[13px] text-ink-950">
        <input
          type="checkbox"
          checked={!allowed}
          disabled={save.isPending || !org}
          onChange={e => save.mutate(!e.target.checked)}
          data-testid="require-approval-before-signing"
        />
        Require approval before a contract is sent for signature
      </label>
    </section>
  )
}
