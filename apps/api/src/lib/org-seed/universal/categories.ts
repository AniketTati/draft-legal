/**
 * Universal clause categories — 18 industry-agnostic buckets covering the
 * commercial contract surface. Every fresh org gets these (idempotent: re-seed
 * skips any category whose `name` already exists for that org).
 *
 * `slug` is our internal join key (used by clauses.ts and playbook.ts to
 * reference categories without DB IDs). It is NOT a column on
 * ClauseCategory — the seeder maps slug → newly-created id at runtime.
 */

export interface SeedCategory {
  slug: string
  name: string
  description: string
  sortOrder: number
  /** docs/41 P0.3 — a clause of this category must be in contracts of these types. */
  required?: string[]
}

/** The contract types that stand on their own: an SOW or an order form takes its term and law from its master. */
const STANDALONE = ['NDA', 'MSA', 'VENDOR_AGREEMENT', 'LICENSE', 'PARTNERSHIP', 'SLA', 'EMPLOYMENT', 'DATA_PROCESSING']

export const UNIVERSAL_CATEGORIES: SeedCategory[] = [
  { slug: 'definitions',           name: 'Definitions & Interpretation',     description: 'Defined terms, rules of construction, document hierarchy.',                                 sortOrder: 10 },
  { slug: 'scope-services',        name: 'Scope of Services',                description: 'Services, deliverables, statements of work, change control.',                              sortOrder: 20 },
  { slug: 'fees-payment',          name: 'Fees & Payment',                   description: 'Pricing, invoicing, payment terms, taxes, expenses, late payment, currency.',             sortOrder: 30 },
  { slug: 'term-termination',      name: 'Term & Termination',               description: 'Initial term, renewals, termination for cause, termination for convenience, effects.',    sortOrder: 40, required: STANDALONE },
  { slug: 'confidentiality',       name: 'Confidentiality',                  description: 'Definition of confidential information, obligations, exclusions, residual rights.',       sortOrder: 50, required: ['NDA'] },
  { slug: 'ip-ownership',          name: 'Intellectual Property',            description: 'Background IP, foreground IP, work product, licenses, feedback, trademarks.',              sortOrder: 60 },
  { slug: 'data-privacy',          name: 'Data Protection & Privacy',        description: 'Personal data, GDPR/CCPA, DPA, sub-processors, security incidents, cross-border.',         sortOrder: 70 },
  { slug: 'security',              name: 'Information Security',             description: 'Security standards, audits, penetration testing, certifications, controls.',               sortOrder: 80 },
  { slug: 'warranties',            name: 'Representations & Warranties',     description: 'Mutual reps, service warranties, disclaimers, AS-IS clauses.',                              sortOrder: 90 },
  { slug: 'indemnification',       name: 'Indemnification',                  description: 'IP indemnity, third-party claims, defense, settlement, exclusions.',                        sortOrder: 100 },
  { slug: 'liability',             name: 'Limitation of Liability',          description: 'Liability caps, consequential damages exclusion, carve-outs, super-cap.',                  sortOrder: 110, required: ['MSA', 'VENDOR_AGREEMENT', 'LICENSE'] },
  { slug: 'insurance',             name: 'Insurance',                        description: 'Required coverages, limits, certificates, additional insured, waivers.',                   sortOrder: 120 },
  { slug: 'compliance',            name: 'Compliance with Laws',             description: 'Anti-bribery, sanctions, export controls, modern slavery, anti-money-laundering.',         sortOrder: 130 },
  { slug: 'dispute',               name: 'Dispute Resolution',               description: 'Governing law, venue, arbitration, jury waiver, equitable relief, escalation.',             sortOrder: 140, required: STANDALONE },
  { slug: 'assignment-change',     name: 'Assignment & Change of Control',   description: 'Assignment rights, novation, change of control consent, successors and assigns.',         sortOrder: 150 },
  { slug: 'force-majeure',         name: 'Force Majeure & Excused Events',   description: 'Excused performance, notice, mitigation, prolonged force majeure, allocation.',           sortOrder: 160 },
  { slug: 'notices-misc',          name: 'Notices & Miscellaneous',          description: 'Notices, severability, entire agreement, amendments, waiver, counterparts.',               sortOrder: 170 },
  { slug: 'service-levels',        name: 'Service Levels & Performance',     description: 'Uptime, response times, service credits, root-cause analysis, reporting.',                 sortOrder: 180 },
]
