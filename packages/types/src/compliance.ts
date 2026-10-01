/**
 * docs/41 Part 9 — which compliance frameworks apply to a contract, worked
 * out from facts about it and the org's policy, never picked by hand.
 *
 *   facts   what the AI reads from the contract, each with a quote and a
 *           confidence (personal data? whose? health data? card data?…);
 *           a person confirms one when the AI isn't sure
 *   policy  the org's rules from facts to frameworks ("personal data of EU
 *           data subjects → GDPR"); a default set ships
 *
 * The evaluation is deterministic (apps/api/src/lib/compliance-policy.ts).
 */
import { z } from 'zod'

export const COMPLIANCE_FRAMEWORK_IDS = ['GDPR', 'UK_GDPR', 'HIPAA', 'CCPA', 'SOX', 'PCI_DSS'] as const
export type ComplianceFrameworkId = typeof COMPLIANCE_FRAMEWORK_IDS[number]

export const COMPLIANCE_FRAMEWORK_LABELS: Record<ComplianceFrameworkId, string> = {
  GDPR: 'GDPR',
  UK_GDPR: 'UK GDPR',
  HIPAA: 'HIPAA',
  CCPA: 'CCPA / CPRA',
  SOX: 'SOX',
  PCI_DSS: 'PCI DSS',
}

export const COMPLIANCE_FACT_KEYS = [
  'personal_data',
  'personal_data_categories',
  'data_subject_regions',
  'health_data',
  'hipaa_covered_entity',
  'payment_card_data',
  'financial_reporting_impact',
  'public_company',
  'party_jurisdictions',
  'processing_role',
  'cross_border_transfer',
  'industry',
] as const
export type ComplianceFactKey = typeof COMPLIANCE_FACT_KEYS[number]

/** boolean: yes/no · list: codes ("EU", "US-CA") · choice: one value. */
export type ComplianceFactKind = 'boolean' | 'list' | 'choice'

export interface ComplianceFactSpec {
  kind: ComplianceFactKind
  label: string
  /** Asked when the AI isn't sure and a rule needs it. Absent: never asked. */
  question?: string
  options?: Array<{ value: string; label: string }>
}

const REGION_OPTIONS = [
  { value: 'EU', label: 'EU / EEA' },
  { value: 'UK', label: 'United Kingdom' },
  { value: 'US-CA', label: 'California' },
  { value: 'US', label: 'Elsewhere in the US' },
  { value: 'OTHER', label: 'Elsewhere' },
]

export const COMPLIANCE_FACTS: Record<ComplianceFactKey, ComplianceFactSpec> = {
  personal_data: { kind: 'boolean', label: 'Personal data', question: 'Does this agreement involve personal data (information about identifiable people)?' },
  personal_data_categories: { kind: 'list', label: 'Kinds of personal data' },
  data_subject_regions: { kind: 'list', label: 'Where the people in the data are', question: 'Where are the people whose personal data is involved?', options: REGION_OPTIONS },
  health_data: { kind: 'boolean', label: 'Health information', question: 'Does this agreement involve health or medical information about people?' },
  hipaa_covered_entity: { kind: 'boolean', label: 'US healthcare provider, plan or their business associate', question: 'Is either party a US healthcare provider, health plan, or a business associate of one?' },
  payment_card_data: { kind: 'boolean', label: 'Payment card data', question: 'Will either party store, process or send payment card numbers under this agreement?' },
  financial_reporting_impact: { kind: 'boolean', label: 'Affects financial reporting', question: 'Does this agreement affect financial reporting or internal financial controls?' },
  public_company: { kind: 'boolean', label: 'A party is a public company', question: 'Is either party a publicly listed company?' },
  party_jurisdictions: { kind: 'list', label: 'Where the parties are', question: 'Where are the parties based?', options: REGION_OPTIONS },
  processing_role: {
    kind: 'choice', label: 'Data role of the other party',
    options: [
      { value: 'processor', label: 'Processes data for us' },
      { value: 'controller', label: 'Decides how data is used' },
      { value: 'joint', label: 'Joint controllers' },
      { value: 'none', label: 'No personal data role' },
    ],
  },
  cross_border_transfer: { kind: 'boolean', label: 'Data crosses borders' },
  industry: { kind: 'choice', label: 'Industry' },
}

export type PolicyOp = 'is_true' | 'includes_any'

export interface PolicyCondition {
  fact: ComplianceFactKey
  op: PolicyOp
  /** For includes_any: region or value codes, e.g. ["EU"]. */
  values?: string[]
}

export interface PolicyRule {
  id: string
  framework: ComplianceFrameworkId
  /** Every condition must hold. Several rules for one framework: any of them. */
  when: PolicyCondition[]
  enabled: boolean
}

export const PolicyConditionSchema = z.object({
  fact: z.enum(COMPLIANCE_FACT_KEYS),
  op: z.enum(['is_true', 'includes_any']),
  values: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
}).refine(c => c.op !== 'includes_any' || (c.values?.length ?? 0) > 0, { message: 'includes_any needs values' })

export const PolicyRuleSchema = z.object({
  id: z.string().trim().min(1).max(60),
  framework: z.enum(COMPLIANCE_FRAMEWORK_IDS),
  when: z.array(PolicyConditionSchema).min(1).max(8),
  enabled: z.boolean(),
})

export const CompliancePolicyRulesSchema = z.array(PolicyRuleSchema).max(60)

/** A fact as the evaluation used it: the reason a framework applies or not. */
export interface ComplianceFactEvidence {
  key: ComplianceFactKey
  label: string
  value: unknown
  quote: string | null
  confidence: number
  /** A person answered it. */
  confirmed: boolean
}

export type ApplicabilityAnswer = 'yes' | 'no' | 'unsure'

export interface FrameworkApplicability {
  framework: ComplianceFrameworkId
  label: string
  applies: ApplicabilityAnswer
  /** yes: the facts of the rule that holds · no: the facts that rule it out · unsure: the facts not known. */
  because: ComplianceFactEvidence[]
  /** The rule that made it apply. */
  ruleId?: string
  /** Someone added it by hand ("Add a framework"). */
  addedByUser?: boolean
}

export interface ComplianceQuestion {
  key: ComplianceFactKey
  text: string
  kind: ComplianceFactKind
  options: Array<{ value: string; label: string }>
}
