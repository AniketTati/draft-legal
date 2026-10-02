/**
 * docs/41 Part 10 — the deterministic defined-terms checks, on fixtures that
 * carry each of the five problems, in curly and straight quotes, and the
 * capitalised words that must NOT be taken for undefined terms.
 */
import { describe, it, expect } from 'vitest'
import { analyseDefinedTerms, quoteAround, type DefinedTermIssue } from './defined-terms.js'

// Every problem once, with the curly quotes a DOCX file carries.
const MSA = [
  'MASTER SERVICES AGREEMENT',
  '',
  'This Master Services Agreement (the “Agreement”) is made on 4 January 2026 between Acme Corporation, a Delaware corporation (“Supplier”), and Beta Retail Ltd (“Customer”) (each a “Party” and together the “Parties”). Customer wishes to buy the Services.',
  '',
  '1. Definitions',
  '“Affiliate” means any entity that controls, is controlled by or is under common control with a Party.',
  '“Confidential Information” means all non-public information disclosed by a Party.',
  '“Exclusions” means the matters listed in Schedule 2.',
  '“Fees” means the charges set out in Schedule 1.',
  '“Services” means the services described in Schedule 1.',
  '',
  '2. Services',
  'Supplier shall provide the Services to Customer and its Affiliates. Supplier shall deliver the Deliverables by the agreed date.',
  '',
  '3. Fees',
  'Customer shall pay the Fees within thirty days, in accordance with the laws of the United States and the Data Protection Act 2018.',
  '“Fees” means the charges set out in the order form, excluding taxes.',
  '',
  '4. Confidentiality',
  'Each Party shall protect the Confidential Information with reasonable care, and shall not disclose the other Party’s confidential information to anyone.',
  '',
  'LIMITATION OF LIABILITY',
  'Neither Party is liable to the other in any month of March for losses under Section 4 of this Agreement.',
].join('\n')

const byKind = (issues: DefinedTermIssue[], kind: DefinedTermIssue['kind']) => issues.filter(i => i.kind === kind)
const terms = (issues: DefinedTermIssue[], kind: DefinedTermIssue['kind']) => byKind(issues, kind).map(i => i.term).sort()

describe('defined terms: the five problems', () => {
  const { glossary, issues } = analyseDefinedTerms(MSA)

  it('reads definitions written with curly quotes, “X” means and (the “X”)', () => {
    expect(glossary.map(g => g.term)).toEqual([
      'Agreement', 'Supplier', 'Customer', 'Party', 'Parties',
      'Affiliate', 'Confidential Information', 'Exclusions', 'Fees', 'Services',
    ])
    const supplier = glossary.find(g => g.term === 'Supplier')!
    expect(supplier.definition).toContain('Acme Corporation, a Delaware corporation')
    expect(MSA.slice(supplier.offset, supplier.offset + 8)).toBe('Supplier')
    expect(glossary.find(g => g.term === 'Affiliate')!.definition).toMatch(/^“Affiliate” means any entity/)
  })

  it('flags a term defined but not used', () => {
    expect(terms(issues, 'unused_definition')).toEqual(['Exclusions'])
    const [i] = byKind(issues, 'unused_definition')
    expect(i.message).toBe('“Exclusions” is defined but not used.')
    expect(i.evidence.quote).toContain('“Exclusions” means the matters')
    expect(MSA.slice(i.evidence.offset, i.evidence.offset + 10)).toBe('Exclusions')
  })

  it('flags a term defined twice, in different ways', () => {
    const dup = byKind(issues, 'duplicate_definition')
    expect(dup.map(d => d.term)).toEqual(['Fees'])
    expect(dup[0]).toMatchObject({ severity: 'medium', message: '“Fees” is defined twice, in different ways.', count: 2 })
    expect(dup[0].related!.offset).toBeLessThan(dup[0].evidence.offset)
  })

  it('flags a term used before its definition', () => {
    const before = byKind(issues, 'used_before_defined')
    expect(before.map(b => b.term)).toEqual(['Services'])
    expect(before[0].evidence.quote).toBe('Customer wishes to buy the Services.')
  })

  it('flags lower-case uses of a defined term', () => {
    const drift = byKind(issues, 'capitalisation_drift')
    expect(drift.map(d => d.term)).toEqual(['Confidential Information'])
    expect(drift[0].message).toContain('“confidential information” should be written “Confidential Information”')
  })

  it('flags a capitalised term used but never defined', () => {
    expect(terms(issues, 'undefined_term')).toEqual(['Deliverables'])
    expect(byKind(issues, 'undefined_term')[0].evidence.quote).toContain('deliver the Deliverables')
  })

  it('does not take ordinary capitalised words for undefined terms', () => {
    const flagged = issues.map(i => i.term)
    for (const word of ['Agreement', 'Schedule', 'Section', 'Delaware', 'Acme Corporation', 'United States', 'Data Protection Act', 'March', 'January', 'Definitions', 'LIMITATION OF LIABILITY', 'Neither']) {
      expect(flagged).not.toContain(word)
    }
  })

  it('counts a plural defined alongside its singular as used', () => {
    expect(glossary.find(g => g.term === 'Parties')!.uses).toBe(0)
    expect(terms(issues, 'unused_definition')).not.toContain('Parties')
  })

  it('does not count a heading as a use', () => {
    const services = glossary.find(g => g.term === 'Services')!
    expect(services.uses).toBe(2)    // the preamble and §2, not the "2. Services" heading
  })
})

describe('defined terms: other ways of defining', () => {
  it('reads straight quotes and "shall mean"', () => {
    const { glossary, issues } = analyseDefinedTerms('"Territory" shall mean India. The Distributor sells in the Territory.\n(the "Distributor")')
    expect(glossary.map(g => g.term)).toContain('Territory')
    expect(terms(issues, 'unused_definition')).toEqual([])
  })

  it('reads unquoted definitions in a Definitions section', () => {
    const text = 'DEFINITIONS\n1.1 Business Day means a day banks are open in London.\n1.2 Charges means the fees in Schedule 1.\n2. SERVICES\nPayment is due within five Business Days. The Charges are fixed.'
    const { glossary, issues } = analyseDefinedTerms(text)
    expect(glossary.map(g => g.term)).toEqual(['Business Day', 'Charges'])
    expect(glossary.find(g => g.term === 'Business Day')!.uses).toBe(1)
    expect(issues).toEqual([])
  })

  it('reads a bolded term from the HTML', () => {
    const html = '<p><strong>Term</strong> means two years from signature.</p><p>This agreement lasts for the Term.</p>'
    const text = 'Term means two years from signature.\nThis agreement lasts for the Term.'
    expect(analyseDefinedTerms(text, { html }).glossary.map(g => g.term)).toEqual(['Term'])
  })

  it('reads “X”: definitions lists and "referred to as"', () => {
    const text = '(a) “Product”: the goods in Annex A.\nGlobex Inc, hereinafter referred to as “Buyer”, buys the Product.\nBuyer pays.'
    expect(analyseDefinedTerms(text).glossary.map(g => g.term)).toEqual(['Product', 'Buyer'])
  })

  it('does not count "has the meaning given in" as a second definition', () => {
    const text = '“Losses” means all damages and costs.\nIn Schedule 2, “Losses” has the meaning given in clause 1. The Supplier covers Losses.\n(the “Supplier”)'
    expect(byKind(analyseDefinedTerms(text).issues, 'duplicate_definition')).toEqual([])
  })

  it('reports the same definition twice as low severity', () => {
    const text = '“Fees” means the charges.\nThe Fees are due.\n“Fees” means the charges.'
    expect(byKind(analyseDefinedTerms(text).issues, 'duplicate_definition')[0]).toMatchObject({ term: 'Fees', severity: 'low', message: '“Fees” is defined twice.' })
  })

  it('does not take a quoted label for a definition', () => {
    const text = 'Information disclosed in writing (marked “Confidential”) is protected.'
    expect(analyseDefinedTerms(text).glossary).toEqual([])
  })
})

describe('defined terms: guards against false positives', () => {
  it('skips used-before when the contract says terms are defined elsewhere', () => {
    const text = 'Capitalised terms used in this Order have the meanings given in the MSA.\nThe Services start now.\n“Services” means support.'
    expect(byKind(analyseDefinedTerms(text).issues, 'used_before_defined')).toEqual([])
  })

  it('skips used-before when the use says it is defined below', () => {
    const text = 'Supplier provides the Services (as defined below).\nMore text here.\n“Services” means support.'
    expect(byKind(analyseDefinedTerms(text).issues, 'used_before_defined')).toEqual([])
  })

  it('treats the parties\' names and known names as names', () => {
    const text = 'Agreement between Initech Systems (“Vendor”) and the Globex Group.\nThe Vendor works for Globex.'
    const { issues } = analyseDefinedTerms(text, { knownNames: ['Globex Group'] })
    expect(terms(issues, 'undefined_term')).toEqual([])
  })

  it('leaves single-word lower-case uses alone unless "the" points at the term', () => {
    const text = '“Services” means support.\nThe Services are provided. Other services are extra. Customer pays for the services monthly.\n(the “Customer”)'
    const drift = byKind(analyseDefinedTerms(text).issues, 'capitalisation_drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ term: 'Services', count: 1 })
  })

  it('does not flag all-caps words, statutes or company names', () => {
    const text = 'The SOW and the GDPR apply. The Companies Act 2006 applies. The Initech LLC team helps.'
    expect(terms(analyseDefinedTerms(text).issues, 'undefined_term')).toEqual([])
  })

  it('reads a numbered caption run into the text as a title, not a use', () => {
    // PDF text often loses its line breaks: "5.4 No Set-Off Customer shall pay …".
    const text = 'Beta Ltd (the "Customer") buys. 5.4 No Set-Off Customer shall pay all Charges. 9.3 Cap on Other Liability Except as stated, nothing.\n"Charges" means the fees.'
    const { issues } = analyseDefinedTerms(text)
    expect(terms(issues, 'undefined_term')).toEqual([])
  })

  it('does not take the words a parenthesis defines for terms or drift', () => {
    const text = 'The Lender, a company registered with the Reserve Bank of India (the "Lender"), lends at a unit price of $3 (the "Unit Price"). The Unit Price is fixed and the Lender lends.'
    const { issues } = analyseDefinedTerms(text)
    expect(issues).toEqual([])
  })

  it('does not flag a name that goes on, a capitalised determiner in a name, or a term defined elsewhere', () => {
    const text = 'Disputes go to arbitration under the Arbitration and Conciliation Act. The Contractor keeps a Contractor’s All Risk policy. An Excused Event (as defined in Schedule 3) excuses delay. This Statement of Work No. 3 applies.\n(the "Contractor")'
    expect(terms(analyseDefinedTerms(text).issues, 'undefined_term')).toEqual([])
  })

  it('does not report a use inside the definitions list as used before defined', () => {
    const text = '"Charges" means the Linehaul Charges and the Fuel Surcharge.\n"Fuel Surcharge" means the fuel charge.\n"Linehaul Charges" means the haul fee.\nThe Charges, the Fuel Surcharge and the Linehaul Charges are due.'
    expect(byKind(analyseDefinedTerms(text).issues, 'used_before_defined')).toEqual([])
  })

  it('is empty for empty text', () => {
    expect(analyseDefinedTerms('')).toEqual({ glossary: [], issues: [] })
  })
})

describe('quoteAround', () => {
  it('quotes the sentence the words are in', () => {
    const text = 'First sentence here. The Deliverables are late; nobody knows why. Last.'
    const at = text.indexOf('Deliverables')
    expect(quoteAround(text, at, at + 12)).toBe('The Deliverables are late;')
  })
})
