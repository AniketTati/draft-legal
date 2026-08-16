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
 *
 * ─── Why no status maps to `turn` ──────────────────────────────────────────
 *
 * "Your turn" is the load-bearing idea in this design system: it is the only
 * meaning that earns a badge count, and the whole colour model is justified by
 * a user being able to trust it. But it cannot be derived from a status.
 *
 * A status is a property of the CONTRACT. "Your turn" is a property of the
 * pair (contract, viewer). PENDING_REVIEW means "handed to a named reviewer and
 * waiting" — that is my turn if I am the reviewer, and emphatically not my turn
 * if I am the requester who is waiting on them. Mapping it to `turn` painted it
 * amber for everyone, which made amber mean "somebody's turn", i.e. nothing.
 * Worse, it cried wolf on the majority of viewers, which is how a signal stops
 * being believed.
 *
 * So every status here resolves viewer-NEUTRALLY: a gate that is waiting on a
 * person is `inflight`. `turn` is reserved for surfaces that genuinely know who
 * is looking — the approvals queue, the sidebar badge, the dashboard's "Your
 * turn" section — where the query is already scoped to the current user. Those
 * call sites pass `meaning="turn"` explicitly.
 *
 * The practical effect is that amber became rare, and rare is the entire point.
 */

export type Meaning = 'neutral' | 'inflight' | 'turn' | 'binding' | 'risk'

/** Tailwind classes per meaning. Sourced from the design system MEANING map. */
export const MEANING_CLASS: Record<
  Meaning,
  { dot: string; fg: string; wash: string; washFg: string; washBorder: string }
> = {
  neutral: {
    // ink-350, not 400 — see the palette note: the dot needs to stay separable
    // from brand emerald for red-green colour-vision deficiency, which the
    // darker text-grade neutral is not.
    dot: 'bg-ink-350',
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
  PENDING_REVIEW: { meaning: 'inflight', label: 'In review' },
  UNDER_NEGOTIATION: { meaning: 'inflight', label: 'In negotiation' },
  PENDING_APPROVAL: { meaning: 'inflight', label: 'Awaiting approval' },
  APPROVED: { meaning: 'binding', label: 'Approved' },
  PENDING_SIGNATURE: { meaning: 'inflight', label: 'Out for signature' },
  EXECUTED: { meaning: 'binding', label: 'Executed' },
  EXPIRED: { meaning: 'risk', label: 'Expired' },
  TERMINATED: { meaning: 'risk', label: 'Terminated' },
  ARCHIVED: { meaning: 'neutral', label: 'Archived' },

  // ── RequestStatus ───────────────────────────────────────────────────────────
  SUBMITTED: { meaning: 'inflight', label: 'Submitted' },
  IN_REVIEW: { meaning: 'inflight', label: 'In review' },
  ACCEPTED: { meaning: 'binding', label: 'Accepted' },
  REJECTED: { meaning: 'risk', label: 'Rejected' },
  MORE_INFO_NEEDED: { meaning: 'inflight', label: 'Needs info' },
  COMPLETED: { meaning: 'binding', label: 'Completed' },

  // ── ApprovalStatus ──────────────────────────────────────────────────────────
  PENDING: { meaning: 'inflight', label: 'Pending' },
  DELEGATED: { meaning: 'inflight', label: 'Delegated' },
  ESCALATED: { meaning: 'inflight', label: 'Escalated' },
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
 * Risk score (0-100) → the colour band the design system uses for a risk meter:
 * emerald below 34, amber below 67, red above.
 *
 * This deliberately does NOT return a `Meaning`. The rendered colours coincide
 * with binding/turn/risk, but severity and workflow state are different axes:
 * typing a low risk score as `binding` would let it be passed to <StatusPill>
 * and render a DRAFT contract labelled as though it were executed. Same pixels,
 * different vocabulary, kept apart on purpose.
 */
export type RiskBand = 'low' | 'medium' | 'high'

/**
 * Coerce a risk score to 0-100, whichever scale it arrived on.
 *
 * The API is inconsistent with itself: packages/types declares
 * `riskScore: z.number().min(0).max(1)`, but the great majority of stored rows
 * are 0-100 integers, and every frontend consumer multiplied by 100. With
 * 0-100 data that renders every contract at a full-width red bar labelled 100
 * — the risk column, the only quantitative triage signal in the repository,
 * ranks nothing and risk red becomes the resting state.
 *
 * This is a DISPLAY-LAYER GUARD, not a fix. The real fix is to settle on one
 * scale at the API boundary and make the schema and the data agree. Until then
 * this keeps the meter honest for both shapes: anything at or below 1 is read
 * as a fraction, anything above as an already-percentage value.
 *
 * The 0/1 ambiguity is real but harmless — a score of exactly 1 renders as 1%
 * rather than 1%, both of which are "low".
 */
export function normalizeRisk(score: number | null | undefined): number | null {
  if (score == null || Number.isNaN(score)) return null
  const pct = score <= 1 ? score * 100 : score
  return Math.max(0, Math.min(100, Math.round(pct)))
}

export function riskBand(score: number): RiskBand {
  if (score >= 67) return 'high'
  if (score >= 34) return 'medium'
  return 'low'
}

/** Meter fill per band — the only place the two vocabularies are allowed to meet. */
export const RISK_BAND_CLASS: Record<RiskBand, string> = {
  low: 'bg-brand-700',
  medium: 'bg-attention-600',
  high: 'bg-risk-600',
}
