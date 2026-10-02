/**
 * docs/41 Parts 13 and 14 — a contract family and its renewals.
 *
 * A child contract hangs off its parent by one of a fixed set of
 * relationships. They were free text: the binder split wrote `exhibit_only`,
 * the amendment dialog offered five, and readers guessed. The set is fixed
 * now (the column has a CHECK constraint, migration lifecycle_family); an
 * older spelling a client still sends is read as the one it meant.
 */

export const RELATIONSHIP_TYPES = ['amendment', 'renewal', 'sow', 'order_form', 'exhibit', 'split_part', 'nda', 'other'] as const
export type RelationshipType = typeof RELATIONSHIP_TYPES[number]

/** What each relationship is called on a screen. */
export const RELATIONSHIP_LABEL: Record<RelationshipType, string> = {
  amendment:  'Amendment',
  renewal:    'Renewal',
  sow:        'Statement of work',
  order_form: 'Order form',
  exhibit:    'Exhibit',
  // A part of a scanned file that held several agreements, split at upload.
  split_part: 'Split from scanned file',
  nda:        'NDA',
  other:      'Related',
}

/**
 * The relationship an older or looser spelling means, or null for none.
 * `exhibit_only` was both an exhibit and a binder split's part; without the
 * parent's split record it reads as an exhibit (the migration told them apart).
 */
export function normaliseRelationshipType(raw: unknown): RelationshipType | null {
  if (raw === null || raw === undefined || raw === '') return null
  const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_')
  if ((RELATIONSHIP_TYPES as readonly string[]).includes(s)) return s as RelationshipType
  if (s === 'exhibit_only' || s === 'schedule' || s === 'appendix') return 'exhibit'
  if (s === 'statement_of_work') return 'sow'
  if (s === 'orderform' || s === 'order') return 'order_form'
  if (s === 'addendum' || s === 'amended_and_restated') return 'amendment'
  return 'other'
}

/** Relationships that change the parent's terms once signed. */
export const TERM_CHANGING: readonly RelationshipType[] = ['amendment', 'renewal']

/** Relationships that follow their parent's dates rather than renewing on their own. */
export const FOLLOWS_PARENT: readonly RelationshipType[] = ['amendment', 'exhibit', 'split_part']

/** Relationships that are numbered per parent ("Amendment No. 2", "SOW #3"). */
export const NUMBERED: readonly RelationshipType[] = ['amendment', 'renewal', 'sow', 'order_form']

/** "Amendment No. 2", "SOW #3", "Renewal No. 1"; null for an unnumbered relationship. */
export function familyLabel(type: string | null | undefined, n: number | null | undefined): string | null {
  const t = normaliseRelationshipType(type)
  if (!t || n == null || !NUMBERED.includes(t)) return null
  if (t === 'sow') return `SOW #${n}`
  if (t === 'order_form') return `Order form #${n}`
  return `${RELATIONSHIP_LABEL[t]} No. ${n}`
}

/** "A1", "R2": the short name an effective view marks a section with. */
export function familyShortLabel(type: string | null | undefined, n: number | null | undefined): string | null {
  const t = normaliseRelationshipType(type)
  if (!t || n == null) return null
  return t === 'amendment' ? `A${n}` : t === 'renewal' ? `R${n}` : t === 'sow' ? `SOW${n}` : t === 'order_form' ? `OF${n}` : null
}

// ─── Amendments ──────────────────────────────────────────────────────────────

/** One change an amendment makes, as drafted (Contract.metadata._amendment.changes). */
export type AmendmentChangeSpec =
  | {
    kind: 'clause'
    /** The parent's clause it replaces or deletes. */
    clauseId: string
    clauseType: string
    sectionRef: string | null
    /** The parent's words, as in effect when drafted: the evidence. */
    parentText: string
    /** The new words; empty when the section is deleted. */
    newText: string
    action: 'replace' | 'delete'
    /** Who wrote `newText`: the AI's draft a person kept, or a person. */
    source: 'ai' | 'user'
    instruction?: string | null
  }
  | {
    kind: 'term'
    key: string
    label: string
    from: string | null
    to: string
    source: 'user'
  }

export interface AmendmentSpec {
  parentId: string
  number: number | null
  effectiveDate: string | null
  templateId: string | null
  changes: AmendmentChangeSpec[]
}

// ─── Renewals ────────────────────────────────────────────────────────────────

export const RENEWAL_TYPES = ['auto', 'manual', 'evergreen', 'none'] as const
export type RenewalType = typeof RENEWAL_TYPES[number]

export const RENEWAL_TYPE_LABEL: Record<RenewalType, string> = {
  auto:      'Renews automatically',
  manual:    'Renews only if both agree',
  evergreen: 'Runs until ended',
  none:      'Doesn’t renew',
}

/** The field registry's options for renewalType, as people read them, and what each means. */
export const RENEWAL_TYPE_OPTIONS = ['Automatic', 'By agreement', 'Evergreen', 'None'] as const
const OPTION_TYPE: Record<string, RenewalType> = { automatic: 'auto', 'by agreement': 'manual', evergreen: 'evergreen', none: 'none' }

/** The renewal type a stored value means ("Automatic", "auto", "By agreement"…), or null. */
export function renewalTypeOf(raw: unknown): RenewalType | null {
  if (raw === null || raw === undefined || raw === '') return null
  const s = String(raw).trim().toLowerCase()
  if ((RENEWAL_TYPES as readonly string[]).includes(s)) return s as RenewalType
  return OPTION_TYPE[s] ?? null
}

/** The decision a person makes about a renewal, and the action each starts. */
export const RENEWAL_DECISIONS = ['renew', 'renegotiate', 'terminate'] as const
export type RenewalDecisionKind = typeof RENEWAL_DECISIONS[number]

export const RENEWAL_DECISION_LABEL: Record<RenewalDecisionKind, string> = {
  renew:       'Renew as is',
  renegotiate: 'Renegotiate',
  terminate:   'Let it lapse or end it',
}
