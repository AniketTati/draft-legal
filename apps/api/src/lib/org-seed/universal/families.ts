/**
 * docs/41 Part 1 — the seeded clause families: library clauses that are
 * approved alternatives for one clause, grouped by category and title.
 *
 * Governing Law is the one the seeded templates use as a clause slot. It has
 * no default: a fresh org's draft takes the law the request names, or asks.
 * An org that wants one (the demo orgs) marks it with
 * scripts/set-template-org-default.ts. The others are grouped so the library
 * shows them as alternatives, ready for a template to slot.
 */

export interface SeedFamilyVariant {
  /** The seeded library clause's title (clauses.ts). */
  title: string
  label: string
  /** Names a request may use for it, matched exactly ("NY"). */
  matchValues?: string[]
}

export interface SeedFamily {
  name: string
  categorySlug: string
  description: string
  requestKey?: string
  variants: SeedFamilyVariant[]
}

export const GOVERNING_LAW_FAMILY = 'Governing Law'

export const UNIVERSAL_FAMILIES: SeedFamily[] = [
  {
    name: GOVERNING_LAW_FAMILY,
    categorySlug: 'dispute',
    description: 'Which law governs the agreement.',
    requestKey: 'governingLaw',
    variants: [
      { title: 'Governing Law — Delaware', label: 'Delaware', matchValues: ['Delaware', 'DE'] },
      { title: 'Governing Law — New York', label: 'New York', matchValues: ['New York', 'NY'] },
      { title: 'Governing Law — England and Wales', label: 'England and Wales', matchValues: ['England and Wales', 'England & Wales', 'England', 'English'] },
    ],
  },
  {
    name: 'Confidentiality Term',
    categorySlug: 'confidentiality',
    description: 'How long confidentiality lasts.',
    variants: [
      { title: 'Confidentiality Term — Indefinite for Trade Secrets', label: '5 years, trade secrets for as long as they last' },
      { title: 'Confidentiality Term — 3 Years', label: '3 years' },
    ],
  },
  {
    name: 'Liability Cap',
    categorySlug: 'liability',
    description: 'The cap on each party’s liability.',
    variants: [
      { title: 'Liability Cap — 12 Months Fees', label: '12 months of fees' },
      { title: 'Liability Cap — 24 Months Fees', label: '24 months of fees' },
    ],
  },
  {
    name: 'Payment Terms',
    categorySlug: 'fees-payment',
    description: 'When invoices are due.',
    variants: [
      { title: 'Fees and Payment Terms — Net 30', label: 'Net 30' },
      { title: 'Fees and Payment Terms — Net 60', label: 'Net 60' },
    ],
  },
]
