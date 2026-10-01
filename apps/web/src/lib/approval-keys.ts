/**
 * docs/41 P0.6 — one set of cache keys for approvals.
 *
 * A decision changed the approval in five places the page reads it from, and
 * each decide button cleared its own guess at the keys: DecisionStrip cleared
 * ['approvals', 'my-queue'] while the Approvals page read ['approval-queue'],
 * so the queue, its badge and the contract page could each show the
 * approval as still pending. Every reader uses these keys, and every
 * decision clears them all.
 */
import type { QueryClient } from '@tanstack/react-query'

export const approvalKeys = {
  /** GET /contracts/:id/approval — the contract's approval, as the contract page shows it. */
  contract: (contractId: string) => ['contract-approval', contractId] as const,
  /** GET /approvals/my-queue */
  myQueue: ['approval-queue'] as const,
  /** GET /approvals/all */
  all: ['approval-all'] as const,
  /** GET /approvals/:instanceId */
  instance: (instanceId: string) => ['approval-instance', instanceId] as const,
}

/** Everything an approval decision (or a submission) changes. */
export function invalidateApproval(qc: QueryClient, contractId?: string | null, instanceId?: string | null): void {
  qc.invalidateQueries({ queryKey: approvalKeys.myQueue })
  qc.invalidateQueries({ queryKey: approvalKeys.all })
  // The sidebar's approvals badge and the dashboard's counts.
  qc.invalidateQueries({ queryKey: ['dashboard-stats'] })
  if (instanceId) qc.invalidateQueries({ queryKey: approvalKeys.instance(instanceId) })
  if (contractId) {
    qc.invalidateQueries({ queryKey: approvalKeys.contract(contractId) })
    qc.invalidateQueries({ queryKey: ['contract', contractId] })
    // Activity: the decision, with its reason, is on the contract's timeline.
    qc.invalidateQueries({ queryKey: ['contract-timeline', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-checks', contractId] })
    qc.invalidateQueries({ queryKey: ['contract-review', contractId] })
  }
}

/** The server's message for a failed request, in its words when it gave any. */
export function serverMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const data = (err as { response?: { data?: { detail?: unknown; error?: unknown; message?: unknown } } })?.response?.data
  const msg = [data?.detail, data?.error, data?.message].find(v => typeof v === 'string' && v.trim())
  return (msg as string | undefined) ?? fallback
}
