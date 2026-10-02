/**
 * docs/41 fix-up 7 — the Request exception dialog says who will decide: the
 * clause approver named on the finding's category (a person or a role). When
 * no one is named, it says so before anyone writes a reason, and someone who
 * can name one gets a link to the Playbook page to do it.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { serverMessage } from '@/lib/approval-keys'
import { useCanRequest } from '@/lib/permissions'

export interface ExceptionApprover { kind: 'user' | 'role'; name: string; category: string | null }

export const exceptionApproverKey = (contractId: string, findingId: string) => ['exception-approver', contractId, findingId]

/** What the dialog says, from who decides (or the refusal when no one can). */
export function ExceptionApproverText({ title, approver, error, canSetApprover }: {
  title: string
  approver?: ExceptionApprover | null
  error?: string | null
  canSetApprover: boolean
}) {
  if (error) {
    return (
      <span data-testid="exception-no-approver">
        <span className="text-risk-900">{error}</span>
        {canSetApprover && <> <Link to="/playbook" className="underline text-ink-950">Name a clause approver</Link></>}
      </span>
    )
  }
  const who = !approver ? 'the person who decides exceptions for this kind of clause'
    : approver.kind === 'user' ? approver.name
    : `anyone with the ${approver.name} role`
  return (
    <span data-testid="exception-approver">
      “{title}” goes to <span className="font-medium text-ink-950">{who}</span>{approver?.category ? <>, who decides exceptions for {approver.category}</> : null}. They see your reason.
    </span>
  )
}

export function ExceptionApproverNote({ contractId, findingId, title }: { contractId: string; findingId: string; title: string }) {
  const onPlaybook = useCanRequest('PATCH /playbook/categories/:id/rules')
  const onClauses = useCanRequest('PATCH /clauses/categories/:id')
  const canSetApprover = onPlaybook || onClauses
  const q = useQuery<ExceptionApprover>({
    queryKey: exceptionApproverKey(contractId, findingId),
    queryFn: () => api.get(`/contracts/${contractId}/findings/${findingId}/exception-approver`).then(r => r.data),
    retry: false,
    meta: { errorHandled: true },
  })
  return <ExceptionApproverText title={title} approver={q.data ?? null} error={q.isError ? serverMessage(q.error) : null} canSetApprover={canSetApprover} />
}
