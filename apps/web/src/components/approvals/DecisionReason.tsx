/**
 * docs/41 Part 4 — what an approver says when the answer isn't "approve".
 *
 * Two different answers, named for what happens next:
 *   - Return for changes: the contract goes back to the person working on it,
 *     who fixes it and submits again;
 *   - Decline: it should not go ahead as it is; the owner decides whether to
 *     cancel it.
 * Either needs a reason (the owner sees it on the contract and in their
 * notification), and may point at the review findings it is about.
 * "Reject" meant nine things in the product; approvals no longer use it.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ContractReview } from '@/lib/review'

export type Decision = 'APPROVED' | 'RETURNED' | 'DECLINED' | 'DELEGATED'

export const DECISION_LABEL: Record<Decision, string> = {
  APPROVED: 'Approve',
  RETURNED: 'Return for changes',
  DECLINED: 'Decline',
  DELEGATED: 'Delegate',
}

/** What the confirm button says. */
export const CONFIRM_LABEL: Record<Decision, string> = {
  APPROVED: 'Confirm approval',
  RETURNED: 'Return for changes',
  DECLINED: 'Decline',
  DELEGATED: 'Delegate',
}

export const needsReason = (d: Decision | null) => d === 'RETURNED' || d === 'DECLINED'

export function DecisionReason({
  contractId, decision, reason, onReason, findingIds, onFindingIds, autoFocus,
}: {
  contractId: string
  decision: 'RETURNED' | 'DECLINED'
  reason: string
  onReason: (v: string) => void
  findingIds: string[]
  onFindingIds: (ids: string[]) => void
  autoFocus?: boolean
}) {
  // The findings still open on the version under review: what a return can point at.
  const { data } = useQuery<ContractReview>({
    queryKey: ['contract-review', contractId],
    queryFn: () => api.get(`/contracts/${contractId}/review`).then(r => r.data),
    staleTime: 30_000,
  })
  const open = [...(data?.groups.needsAttention ?? []), ...(data?.groups.notDetected ?? [])]
  const toggle = (id: string) => onFindingIds(findingIds.includes(id) ? findingIds.filter(x => x !== id) : [...findingIds, id])

  return (
    <div className="space-y-2" data-testid="decision-reason">
      <textarea
        autoFocus={autoFocus}
        value={reason}
        onChange={e => onReason(e.target.value)}
        rows={2}
        placeholder={decision === 'RETURNED'
          ? 'What needs to change (required). The owner sees this on the contract and in their notification.'
          : 'Why it should not go ahead (required). The owner decides whether to cancel it.'}
        className="w-full text-[13px] text-ink-950 bg-card px-2.5 py-1.5 border border-input rounded-md placeholder:text-ink-400 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15 resize-y min-h-[52px]"
        data-testid="decision-reason-text"
      />
      {open.length > 0 && (
        <fieldset className="text-dense">
          <legend className="text-ink-500 mb-1">Point at what it is about (optional)</legend>
          <ul className="max-h-32 overflow-y-auto space-y-1">
            {open.slice(0, 20).map(f => (
              <li key={f.id}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" className="mt-0.5 size-3.5 accent-ink-950" checked={findingIds.includes(f.id)} onChange={() => toggle(f.id)} />
                  <span className="text-ink-700">{f.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </div>
  )
}
