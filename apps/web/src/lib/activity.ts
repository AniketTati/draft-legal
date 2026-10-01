/**
 * docs/41 P0.6 — a contract's Activity in words. It showed the raw action
 * names ("APPROVAL DECIDED") and user ids, so a returned approval and its
 * reason could not be read there.
 */
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Draft', PENDING_REVIEW: 'In review', UNDER_NEGOTIATION: 'Negotiating', PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved', PENDING_SIGNATURE: 'Out for signature', EXECUTED: 'Signed', EXPIRED: 'Expired',
  TERMINATED: 'Terminated', ARCHIVED: 'Archived', REJECTED: 'Returned',
}
export const statusWords = (s: unknown) => (typeof s === 'string' ? STATUS_WORDS[s] ?? s.replace(/_/g, ' ').toLowerCase() : '')

export interface ActivityEvent {
  action: string
  userName?: string | null
  metadata?: Record<string, unknown> | null
}

export function activityText(e: ActivityEvent): { title: string; detail: string | null } {
  const m = (e.metadata ?? {}) as Record<string, unknown>
  const who = e.userName ?? null
  const quote = (s: unknown) => (typeof s === 'string' && s.trim() ? `“${s.trim()}”` : null)
  switch (e.action) {
    case 'APPROVAL_DECIDED':
      if (m.decision === 'REJECTED') return { title: `Returned for changes${who ? ` by ${who}` : ''}`, detail: quote(m.reason) }
      if (m.decision === 'APPROVED') return { title: `Approved${who ? ` by ${who}` : ''}${m.stepName ? ` (${m.stepName})` : ''}`, detail: quote(m.comment) }
      if (m.decision === 'DELEGATED') return { title: `Approval delegated${who ? ` by ${who}` : ''}`, detail: null }
      return { title: 'Approval decided', detail: null }
    case 'APPROVAL_SUBMITTED':
      return { title: m.autoApproved ? "Approved automatically by your org's rules" : `Sent for approval${who ? ` by ${who}` : ''}`, detail: null }
    case 'CONTRACT_STATUS_CHANGED': {
      const title = `${statusWords(m.from)} → ${statusWords(m.to)}`
      return { title: who ? `${title} · ${who}` : title, detail: quote(m.reason) }
    }
    case 'CONTRACT_DRAFTED':
      return { title: `Drafted${m.templateName ? ` from ${m.templateName}` : ''}`, detail: Array.isArray(m.unfilled) && m.unfilled.length ? `${m.unfilled.length} term${m.unfilled.length === 1 ? '' : 's'} left to choose` : null }
    case 'SIGNATURE_VOIDED':
      return { title: m.declinedBy ? `Signing declined by ${m.declinedBy}` : 'Signature request voided', detail: quote(m.reason) }
    default: {
      const words = e.action.replace(/_/g, ' ').toLowerCase()
      return { title: `${words.charAt(0).toUpperCase()}${words.slice(1)}${who ? ` · ${who}` : ''}`, detail: null }
    }
  }
}
