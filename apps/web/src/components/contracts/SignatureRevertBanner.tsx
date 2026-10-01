/**
 * docs/41 P0.8 — a way out of "Out for signature" once its signature
 * request was voided, declined or expired.
 *
 * The contract stayed PENDING_SIGNATURE with nothing to sign and no way back.
 * This offers to take it back to where it was worked on (Draft, In review or
 * Negotiating), with a reason that goes on the record. Its approval no longer
 * stands: it is approved again before it is sent for signature again.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Undo2, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { invalidateApproval, serverMessage } from '@/lib/approval-keys'
import { toast } from '@/components/common/Toaster'
import { statusWords } from '@/lib/activity'

const ENDED: Record<string, string> = { VOIDED: 'was voided', EXPIRED: 'expired' }

export function SignatureRevertBanner({ contractId, canRevert }: { contractId: string; canRevert: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const { data } = useQuery<{ data: Array<{ id: string; status: string; signers?: Array<{ status: string; name: string }> }> }>({
    queryKey: ['signature-requests', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/signature-requests`).then(r => r.data),
    staleTime: 5_000,
  })
  const list = data?.data ?? []
  const revert = useMutation({
    mutationFn: () => api.post(`/contracts/${contractId}/revert-signature`, { reason: reason.trim() }).then(r => r.data as { status: string }),
    onSuccess: (r) => {
      toast.success(`Back to ${statusWords(r.status)}`, { description: 'Send it for approval again before it goes out for signature.' })
      setOpen(false)
      setReason('')
      invalidateApproval(qc, contractId)
      qc.invalidateQueries({ queryKey: ['signature-requests', contractId] })
    },
    // Shown in the banner.
    onError: () => {},
  })

  if (!list.length || list.some(r => r.status === 'PENDING')) return null
  const last = list[0]
  const declined = last.signers?.find(s => s.status === 'DECLINED')
  const what = declined ? `was declined by ${declined.name}` : ENDED[last.status] ?? 'has ended'

  return (
    <div className="bg-attention-50 border-b border-attention-200 text-ink-950 px-6 py-2 text-dense" data-testid="signature-revert-banner">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Undo2 className="size-4 flex-shrink-0 text-attention-700" />
        <span className="font-medium">The signature request {what}.</span>
        <span className="text-ink-700">Nothing is out for signature. Take the contract back to change it.</span>
        {canRevert && !open && (
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => setOpen(true)} data-testid="signature-revert-open">
            Take it back
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <input
            autoFocus
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why it goes back (recorded on the contract)…"
            className="flex-1 min-w-[240px] text-[13px] bg-card px-2.5 py-1.5 border border-paper-200 rounded-md focus:outline-none focus:border-ink-950"
            data-testid="signature-revert-reason"
          />
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={revert.isPending}>Cancel</Button>
          <Button size="sm" onClick={() => revert.mutate()} disabled={revert.isPending || reason.trim().length < 3} data-testid="signature-revert-confirm">
            {revert.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Take it back
          </Button>
          {revert.isError && <p className="basis-full text-risk-700" role="alert">{serverMessage(revert.error)}</p>}
        </div>
      )}
    </div>
  )
}
