// ─── Template & Clause Library Types — Phase 4.1 ─────────────────────────

export type PositionType = 'preferred' | 'acceptable' | 'fallback' | 'walkaway'
export type RiskRating = 'favorable' | 'unfavorable' | 'neutral' | 'standard'
export type VariableType = 'text' | 'number' | 'date' | 'boolean' | 'select'
export type ConditionOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_empty' | 'empty'

export interface VariableDef {
  key: string
  label: string
  type: VariableType
  required: boolean
  defaultValue?: string
  /**
   * docs/41 P0.4 — the org chose `defaultValue` as its own default for this
   * term. A legal choice (governing law, venue) is filled from a default only
   * when this is set; otherwise the draft leaves it as a choice to make
   * rather than guess (the seed's "Delaware" is a suggestion, not a rule).
   */
  orgDefault?: boolean
  options?: string[] // for select type
  /**
   * docs/39 H1/H2 — the contract field its value fills (a field key), when
   * the author named one: a draft's value, and a later change to it, reach
   * the field. Without it the key is matched to a field by name (H3).
   */
  field?: string | null
}

export interface ConditionalLogic {
  field: string
  operator: ConditionOperator
  value?: string | number | boolean
}

export interface TemplateSection {
  id: string
  templateId: string
  title: string
  sortOrder: number
  content: string
  conditionalLogic: ConditionalLogic | null
  clauseRefs: string[]
  /** docs/41 Part 1 — a clause slot: the words are the option of this family drafting picks. */
  slotFamilyId?: string | null
  createdAt: string
  updatedAt: string
}

export interface Template {
  id: string
  orgId: string
  name: string
  description: string | null
  contractType: string | null
  variables: VariableDef[]
  isPublished: boolean
  version: number
  usageCount: number
  /** docs/41 Part 1 — the template drafting uses for its type when nobody picks one. */
  isDefaultForType?: boolean
  /** The published snapshot drafts use, and whether edits since are waiting to be published. */
  publishedVersionId?: string | null
  hasUnpublishedChanges?: boolean
  createdById: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  sections?: TemplateSection[]
}

export interface ClauseCategory {
  id: string
  orgId: string
  name: string
  description: string | null
  parentCategoryId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  children?: ClauseCategory[]
}

export interface ClauseVersion {
  version: number
  content: string
  changedById: string
  changedAt: string
  note: string
}

export interface ClauseLibraryItem {
  id: string
  orgId: string
  categoryId: string
  title: string
  content: string
  tags: string[]
  riskRating: RiskRating | null
  isApproved: boolean
  usageCount: number
  versions: ClauseVersion[]
  createdById: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  category?: Pick<ClauseCategory, 'id' | 'name'>
}

export interface PlaybookPosition {
  id: string
  orgId: string
  clauseCategoryId: string
  positionType: PositionType
  content: string
  notes: string | null
  /** docs/41 Part 16 — offered as an external comment when a contract misses this position. */
  counterpartyNote?: string | null
  riskThreshold: number
  contractTypes: string[]
  sortOrder: number
  createdById: string
  createdAt: string
  updatedAt: string
  clauseCategory?: Pick<ClauseCategory, 'id' | 'name' | 'parentCategoryId'>
}

export interface GenerateResult {
  html: string
  sectionsIncluded: number
  sectionsExcluded: number
  unfilledVariables: string[]
  isSample?: boolean
}

export interface DraftResult {
  contractId?: string
  versionId?: string
  html: string
  usedTemplateId: string
  usedTemplateName: string
  variableValues: Record<string, string | number | boolean>
  completenessScore: number
  missingFields: string[]
}

export interface AssistResult {
  revisedText: string
  explanation: string
  action: 'rewrite' | 'simplify' | 'expand' | 'check_compliance' | 'suggest_alternative'
}

export interface PlaybookTestResult {
  clauseText: string
  bestMatch: PositionType
  score: number
  explanation: string
  deviations: Array<{
    positionType: PositionType
    deviation: string
    severity: 'low' | 'medium' | 'high'
  }>
}

// ─── Legal choices (docs/41 P0.4) ────────────────────────────────────────────
// Governing law, jurisdiction, venue, forum: terms a person chooses. A draft
// fills one from a template default only when the org marked that default as
// its own (VariableDef.orgDefault); otherwise, unless the request names it,
// it stays a choice to make. The agents service's draft_agent.py keeps the
// same list.

const LEGAL_CHOICE = /governing[\s_-]*law|choice[\s_-]*of[\s_-]*law|jurisdiction|venue|forum|seat[\s_-]*of[\s_-]*arbitration|arbitration[\s_-]*seat|court[\s_-]*location/i
const GOVERNING_LAW = /governing[\s_-]*law|choice[\s_-]*of[\s_-]*law|jurisdiction/i

export function isLegalChoiceVariable(v: { key?: string | null; label?: string | null }): boolean {
  return LEGAL_CHOICE.test(v.key ?? '') || LEGAL_CHOICE.test(v.label ?? '')
}

export function isGoverningLawVariable(v: { key?: string | null; label?: string | null }): boolean {
  return GOVERNING_LAW.test(v.key ?? '') || GOVERNING_LAW.test(v.label ?? '')
}
