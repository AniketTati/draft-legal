/**
 * Status meaning — the design system's "nine states, five meanings" rule.
 *
 * Every status the product shows, from any enum, collapses to one of five
 * meanings. The meaning picks the color; the status only picks the words. That
 * is the whole point: a legal-ops user scanning two hundred rows learns five
 * colors once, not one color per enum member per feature.
 *
 *   neutral    Nothing is happening. Draft, archived, unassigned.
 *   inflight   Moving, but it's someone else's turn. Review, approval, signing.
 *   turn       Blocked on this user. The only meaning that earns a badge count.
 *   binding    Approved, executed, signed. The brand color, spent sparingly.
 *   risk       Legal exposure, failure, expiry. Never decoration.
 *
 * Default treatment is a NEUTRAL pill with a colored meaning dot — one colored
 * element per row. `wash` (full-color pill) exists for a single row-level
 * exception per screen, not as the norm.
 */

export type Meaning = 'neutral' | 'inflight' | 'turn' | 'binding' | 'risk'

/** Tailwind classes per meaning. Sourced from the design system MEANING map. */
export const MEANING_CLASS: Record<
  Meaning,
  { dot: string; fg: string; wash: string; washFg: string; washBorder: string }
> = {
  neutral: {
    dot: 'bg-ink-400',
    fg: 'text-ink-700',
    wash: 'bg-paper-100',
    washFg: 'text-ink-700',
    washBorder: 'border-paper-200',
  },
  inflight: {
    dot: 'bg-info-600',
    fg: 'text-info-700',
    wash: 'bg-info-100',
    washFg: 'text-info-700',
    washBorder: 'border-info-200',
  },
  turn: {
    dot: 'bg-attention-600',
    fg: 'text-attention-700',
    wash: 'bg-attention-100',
    washFg: 'text-attention-700',
    washBorder: 'border-attention-200',
  },
  binding: {
    dot: 'bg-brand-700',
    fg: 'text-brand-700',
    wash: 'bg-brand-100',
    washFg: 'text-brand-700',
    washBorder: 'border-brand-200',
  },
  risk: {
    dot: 'bg-risk-600',
    fg: 'text-risk-700',
    wash: 'bg-risk-100',
    washFg: 'text-risk-700',
    washBorder: 'border-risk-200',
  },
}

/**
 * Raw status → { meaning, label }. Keys are upper-snake as they arrive from the
 * API, across every enum in @clm/types. Where two enums share a key (PENDING,
 * COMPLETED, EXPIRED) the meaning is the same in both, so one entry serves.
 *
 * Sentence case, not SCREAMING_SNAKE: the pill is prose, not a database value.
 */
export const STATUS: Record<string, { meaning: Meaning; label: string }> = {
  // ── ContractStatus ──────────────────────────────────────────────────────────
  DRAFT: { meaning: 'neutral', label: 'Draft' },
  PENDING_REVIEW: { meaning: 'turn', label: 'In review' },
  UNDER_NEGOTIATION: { meaning: 'inflight', label: 'In negotiation' },
  PENDING_APPROVAL: { meaning: 'inflight', label: 'Awaiting approval' },
  APPROVED: { meaning: 'binding', label: 'Approved' },
  PENDING_SIGNATURE: { meaning: 'inflight', label: 'Out for signature' },
  EXECUTED: { meaning: 'binding', label: 'Executed' },
  EXPIRED: { meaning: 'risk', label: 'Expired' },
  TERMINATED: { meaning: 'risk', label: 'Terminated' },
  ARCHIVED: { meaning: 'neutral', label: 'Archived' },

  // ── RequestStatus ───────────────────────────────────────────────────────────
  SUBMITTED: { meaning: 'turn', label: 'Submitted' },
  IN_REVIEW: { meaning: 'turn', label: 'In review' },
  ACCEPTED: { meaning: 'binding', label: 'Accepted' },
  REJECTED: { meaning: 'risk', label: 'Rejected' },
  MORE_INFO_NEEDED: { meaning: 'turn', label: 'Needs info' },
  COMPLETED: { meaning: 'binding', label: 'Completed' },

  // ── ApprovalStatus ──────────────────────────────────────────────────────────
  PENDING: { meaning: 'inflight', label: 'Pending' },
  DELEGATED: { meaning: 'inflight', label: 'Delegated' },
  ESCALATED: { meaning: 'turn', label: 'Escalated' },
  AUTO_APPROVED: { meaning: 'binding', label: 'Auto-approved' },

  // ── SignatureStatus ─────────────────────────────────────────────────────────
  SENT: { meaning: 'inflight', label: 'Sent' },
  PARTIALLY_SIGNED: { meaning: 'inflight', label: 'Partially signed' },
  SIGNED: { meaning: 'binding', label: 'Signed' },
  DECLINED: { meaning: 'risk', label: 'Declined' },
  VOIDED: { meaning: 'risk', label: 'Voided' },

  // ── ObligationStatus ────────────────────────────────────────────────────────
  ACTIVE: { meaning: 'inflight', label: 'Active' },
  OPEN: { meaning: 'inflight', label: 'Open' },
  OVERDUE: { meaning: 'risk', label: 'Overdue' },
  WAIVED: { meaning: 'neutral', label: 'Waived' },
  DONE: { meaning: 'binding', label: 'Done' },
  CLOSED: { meaning: 'neutral', label: 'Closed' },

  // ── Async job / ingestion states ────────────────────────────────────────────
  // Machine work in progress. These read as "in flight" — the system's turn,
  // not the user's. FAILED is real risk: the document did not get processed.
  QUEUED: { meaning: 'neutral', label: 'Queued' },
  IDLE: { meaning: 'neutral', label: 'Idle' },
  RUNNING: { meaning: 'inflight', label: 'Running' },
  PARSING: { meaning: 'inflight', label: 'Parsing' },
  SPLITTING: { meaning: 'inflight', label: 'Splitting' },
  CLASSIFYING: { meaning: 'inflight', label: 'Classifying' },
  EXTRACTING: { meaning: 'inflight', label: 'Extracting' },
  ANALYZING: { meaning: 'inflight', label: 'Analyzing' },
  INDEXING: { meaning: 'inflight', label: 'Indexing' },
  DRAFTING: { meaning: 'inflight', label: 'Drafting' },
  MATCHED: { meaning: 'binding', label: 'Matched' },
  FAILED: { meaning: 'risk', label: 'Failed' },

  // ── User account states ─────────────────────────────────────────────────────
  // An invitation is out and the invitee hasn't acted, so it's in flight.
  // A deactivated seat is off, not dangerous — neutral, like an archived record.
  // (ACTIVE is above, shared with ObligationStatus.)
  INVITED: { meaning: 'inflight', label: 'Invited' },
  DEACTIVATED: { meaning: 'neutral', label: 'Deactivated' },

  // ── InvoiceStatus ───────────────────────────────────────────────────────────
  // A reconciled invoice is settled against its obligation — binding, the same
  // as an executed contract. A disputed one is money we may owe or may not:
  // exposure, so risk. (PENDING and MATCHED are above, shared with other enums.)
  RECONCILED: { meaning: 'binding', label: 'Reconciled' },
  DISPUTED: { meaning: 'risk', label: 'Disputed' },
}

/** Fallback for a status the map hasn't seen: neutral, humanised. */
export function statusMeta(raw: string | null | undefined): {
  meaning: Meaning
  label: string
} {
  if (!raw) return { meaning: 'neutral', label: '—' }
  const hit = STATUS[raw.toUpperCase()]
  if (hit) return hit
  const label = raw
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
  return { meaning: 'neutral', label }
}

/** Meaning for a status, without the label. */
export function statusMeaning(raw: string | null | undefined): Meaning {
  return statusMeta(raw).meaning
}

/**
 * Risk score → meaning. The thresholds are the design system's: a risk meter
 * turns amber at 34 and red at 67, so the bar and any adjacent pill agree.
 */
export function riskMeaning(score: number): Meaning {
  if (score >= 67) return 'risk'
  if (score >= 34) return 'turn'
  return 'binding'
}
