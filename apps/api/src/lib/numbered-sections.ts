/**
 * Z9 — clause rows for documents whose text we wrote ourselves: the AI-demo
 * contracts (scripts/fixtures/ai-demo). They came with full text and no
 * clauses, so the Clauses tab, clause search and the playbook check had
 * nothing to work on until someone ran analysis on each.
 *
 * Splits a contract at its numbered top-level headings ("7. LIMITATION OF
 * LIABILITY") and names each section's clause type from its heading, using the
 * review agent's types (apps/agents/app/agents/review_agent.py). Nothing here
 * rates risk: that is the analysis's job, and it replaces these rows when run.
 */

export interface NumberedSection {
  /** "7" */
  number:     string
  /** "LIMITATION OF LIABILITY" */
  heading:    string
  /** The heading line and everything up to the next heading. */
  content:    string
  clauseType: string
}

const HEADING = /^(\d{1,2})\.\s+([A-Z][A-Z0-9 ,;:&'()/—-]{2,})$/

// First match wins: the more specific headings come first. Only the review
// agent's types, so playbook positions match them by category.
const TYPES: Array<[RegExp, string]> = [
  [/UNCAPPED|UNLIMITED LIABILITY/,                   'uncapped_liability'],
  [/LIQUIDATED DAMAGES/,                             'liquidated_damages'],
  [/LIMITATION OF LIABILITY|LIABILITY/,              'limitation_of_liability'],
  [/INDEMNI/,                                        'indemnification'],
  [/CONFIDENTIAL|NON-DISCLOSURE|OBLIGATIONS OF RECEIVING PARTY/, 'confidentiality'],
  [/DATA PROTECTION|DATA PROCESSING|PRIVACY|PERSONAL DATA|SECURITY|PROCESSOR|INTERNATIONAL TRANSFER|DELETION OF DATA/, 'data_protection'],
  [/TERMINATION/,                                    'termination'],
  [/AUTO-RENEWAL|AUTOMATIC RENEWAL/,                 'auto_renewal'],
  [/RENEWAL/,                                        'renewal_term'],
  [/PAYMENT|FEES|COMPENSATION|PRICING|PRICE|INVOIC|COMMISSION|FINANCIAL TERMS/, 'payment'],
  [/INTELLECTUAL PROPERTY|OWNERSHIP|\bIP\b|WORK PRODUCT/, 'ip_ownership'],
  [/LICENSE|LICENCE/,                                'license_grant'],
  [/WARRANT|REPRESENTATION/,                         'warranty'],
  [/NON-COMPET/,                                     'non_compete'],
  [/NON-SOLICIT/,                                    'non_solicitation'],
  [/GOVERNING LAW|JURISDICTION/,                     'governing_law'],
  [/DISPUTE|ARBITRATION/,                            'dispute_resolution'],
  [/FORCE MAJEURE/,                                  'force_majeure'],
  [/CHANGE OF CONTROL/,                              'change_of_control'],
  [/ASSIGNMENT/,                                     'assignment'],
  [/EXCLUSIV/,                                       'exclusivity'],
  [/MOST FAVOU?RED|\bMFN\b/,                         'mfn'],
  [/AUDIT/,                                          'audit_rights'],
  [/INSURANCE/,                                      'insurance'],
  [/ACCEPTANCE/,                                     'acceptance'],
  [/NOTICE/,                                         'notice'],
]

export function clauseTypeOfHeading(heading: string): string {
  const h = heading.toUpperCase()
  return TYPES.find(([re]) => re.test(h))?.[1] ?? 'general'
}

export function numberedSections(text: string): NumberedSection[] {
  const sections: NumberedSection[] = []
  let current: { number: string; heading: string; lines: string[] } | null = null
  const close = () => {
    if (!current) return
    const content = current.lines.join('\n').trim()
    sections.push({ number: current.number, heading: current.heading, content, clauseType: clauseTypeOfHeading(current.heading) })
  }
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line.trim())
    if (m) {
      close()
      current = { number: m[1], heading: m[2].trim(), lines: [line.trim()] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  close()
  return sections
}
