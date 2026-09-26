/**
 * Unit coverage for the clause-matching tiers in clause-apply.
 *
 * These run against the exported helpers rather than the database, because the
 * interesting behaviour is entirely in how the clause text is located: the
 * consequences of getting it wrong (editing the wrong clause, or silently
 * appending an amendment the user never approved) are legal, not technical.
 */
import { describe, it, expect } from 'vitest'
import { escapeHtml, __testing, underHeading } from './clause-apply.js'

const { spliceInto, findNormalizedSpan } = __testing
const id = (s: string) => s

const CLAUSE = 'Liability is capped at the fees paid in the prior twelve months.'
const PROPOSED = 'Liability is capped at two times the fees paid in the prior twelve months.'

describe('spliceInto — match tiers', () => {
  it('replaces on an exact match', () => {
    const body = `<p>Intro.</p><p>${CLAUSE}</p>`
    const r = spliceInto(body, CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('exact')
    expect(r.text).toContain(PROPOSED)
    expect(r.text).not.toContain(CLAUSE)
  })

  it('replaces when the document stores the clause HTML-escaped', () => {
    const clause = 'Fees < $50,000 & costs are excluded.'
    const body = `<p>${escapeHtml(clause)}</p>`
    const r = spliceInto(body, clause, PROPOSED, escapeHtml)
    expect(r.mode).toBe('escaped')
    expect(r.text).toContain(PROPOSED)
  })

  it('replaces across whitespace reflow and &nbsp;', () => {
    const drifted = CLAUSE.replace('capped at the fees', 'capped at\n   the&nbsp;fees')
    const r = spliceInto(`<p>${drifted}</p>`, CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('normalized')
    expect(r.text).toBe(`<p>${PROPOSED}</p>`)
  })

  it('replaces across smart quotes and en dashes', () => {
    const clause = "The Company's term is 12-24 months."
    const stored = 'The Company’s term is 12–24 months.'
    const r = spliceInto(`<p>${stored}</p>`, clause, 'Replaced.', escapeHtml)
    expect(r.mode).toBe('normalized')
    expect(r.text).toBe('<p>Replaced.</p>')
  })

  it('reports no match rather than guessing', () => {
    const r = spliceInto('<p>Entirely different text.</p>', CLAUSE, PROPOSED, escapeHtml)
    expect(r.mode).toBe('none')
    expect(r.text).toBe('<p>Entirely different text.</p>')
  })

  it('escapes the replacement so proposed language cannot break the document', () => {
    const body = `<p>${CLAUSE}</p>`
    const risky = 'Fees < $50,000 & costs > $1,000 are excluded.'
    const r = spliceInto(body, CLAUSE, risky, escapeHtml)
    expect(r.text).toContain('&lt; $50,000')
    expect(r.text).toContain('&amp; costs')
    expect(r.text).not.toContain('< $50,000')
  })

  it('treats $& in the replacement as literal text, not a substitution pattern', () => {
    // String.replace would expand `$&` to the matched text. Index splicing
    // must not.
    const body = `<p>${CLAUSE}</p>`
    const r = spliceInto(body, CLAUSE, 'Payment of $& and $100 is due.', id)
    expect(r.text).toBe('<p>Payment of $& and $100 is due.</p>')
  })

  it('leaves plain text unescaped when no escaper is supplied', () => {
    const r = spliceInto(CLAUSE, CLAUSE, 'a < b & c', id)
    expect(r.text).toBe('a < b & c')
  })
})

describe('findNormalizedSpan — ambiguity and bounds', () => {
  it('refuses when the clause appears more than once', () => {
    // Picking the first occurrence would edit an arbitrary clause; a miss is
    // recoverable, a wrong edit to a contract is not.
    const body = `<p>${CLAUSE}</p><p>Something else.</p><p>${CLAUSE}</p>`
    // Force the normalized tier by making both copies drift.
    const drifted = body.replace(/ /g, '&nbsp;')
    expect(findNormalizedSpan(drifted, CLAUSE)).toBeNull()
  })

  it('refuses to match on a fragment too short to be distinctive', () => {
    expect(findNormalizedSpan('<p>the fees are due</p>', 'the fees')).toBeNull()
  })

  it('returns a span that indexes the original string exactly', () => {
    const drifted = CLAUSE.replace('capped at', 'capped&nbsp;&nbsp;at')
    const body = `<p>lead-in</p><p>${drifted}</p>`
    const span = findNormalizedSpan(body, CLAUSE)
    expect(span).not.toBeNull()
    expect(body.slice(span![0], span![1])).toBe(drifted)
  })
})

describe('a clause stored across line breaks', () => {
  const { spliceInto } = __testing
  const html = '<p>8. INDEMNITY<br />8.1 Each party indemnifies the other.</p>\n<p>9. LIMITATION OF LIABILITY<br />9.1 NEITHER PARTY SHALL BE LIABLE FOR ANY INDIRECT DAMAGES.<br />9.2 CAP. Liability is capped at fees paid.</p>'
  const clause = '9. LIMITATION OF LIABILITY\n9.1 NEITHER PARTY SHALL BE LIABLE FOR ANY INDIRECT DAMAGES.\n9.2 CAP. Liability is capped at fees paid.'

  it('is found and replaced, keeping its line breaks', () => {
    const out = spliceInto(html, clause, '9. LIMITATION OF LIABILITY\n9.1 Capped at 2x fees.', escapeHtml)
    expect(out.mode).toBe('normalized')
    expect(out.text).toBe('<p>8. INDEMNITY<br />8.1 Each party indemnifies the other.</p>\n<p>9. LIMITATION OF LIABILITY<br />9.1 Capped at 2x fees.</p>')
  })

  it('is not matched across paragraphs', () => {
    const across = '8.1 Each party indemnifies the other.\n9. LIMITATION OF LIABILITY'
    expect(spliceInto(html, across, 'x'.repeat(30), escapeHtml).mode).toBe('none')
  })
})

describe('a clause extracted with its section heading', () => {
  const html = '<h1>2. FEES AND PAYMENT</h1><ol><li>Customer shall pay all invoices within <em>fifteen (15)</em> days of the invoice date.</li></ol>'
    + '<h1>3. LIMITATION OF LIABILITY</h1><ol><li>Supplier’s liability shall not exceed one month of fees.</li></ol>'

  it('is rewritten under its heading, which stays as it is', () => {
    const under = underHeading(html,
      '2. FEES AND PAYMENT Customer shall pay all invoices within fifteen (15) days of the invoice date.',
      '2. FEES AND PAYMENT Customer shall pay all invoices within sixty (60) days of the invoice date.')
    expect(under).toEqual({
      clauseText: 'Customer shall pay all invoices within fifteen (15) days of the invoice date.',
      proposed:   'Customer shall pay all invoices within sixty (60) days of the invoice date.',
    })
    const { text } = __testing.spliceInto(html, under!.clauseText, under!.proposed, escapeHtml)
    expect(text).toContain('<h1>2. FEES AND PAYMENT</h1><ol><li>Customer shall pay all invoices within sixty (60) days of the invoice date.</li></ol>')
  })

  it('drops the heading from a rewrite that restates it, stop and all, or that left it out', () => {
    expect(underHeading(html, '3. LIMITATION OF LIABILITY\nSupplier’s liability shall not exceed one month of fees.',
      '3. LIMITATION OF LIABILITY. Each party’s liability shall not exceed twelve months of fees.')?.proposed)
      .toBe('Each party’s liability shall not exceed twelve months of fees.')
    expect(underHeading(html, '3. LIMITATION OF LIABILITY Supplier’s liability shall not exceed one month of fees.',
      'Each party’s liability shall not exceed twelve months of fees.')?.proposed)
      .toBe('Each party’s liability shall not exceed twelve months of fees.')
  })

  it('leaves a clause that does not start with a heading, or is only one, to the ordinary match', () => {
    expect(underHeading(html, 'Customer shall pay all invoices within fifteen (15) days.', 'x')).toBeNull()
    expect(underHeading(html, '2. FEES AND PAYMENT', 'x')).toBeNull()
  })
})

describe('a clause that runs through formatting', () => {
  it('is found, and replaced with the formatting around it kept balanced', () => {
    const html = '<ol><li>Customer shall pay all invoices within <em>fifteen (15)</em> days of the invoice date.</li></ol>'
    const { text, mode } = __testing.spliceInto(html, 'Customer shall pay all invoices within fifteen (15) days of the invoice date.', 'Customer shall pay all invoices within sixty (60) days.', escapeHtml)
    expect(mode).not.toBe('none')
    expect(text).toBe('<ol><li>Customer shall pay all invoices within sixty (60) days.</li></ol>')
  })

  it('closes formatting it starts inside of, and reopens formatting it ends inside of', () => {
    const html = '<p>The <strong>Supplier Party</strong> shall deliver the Services on time, <em>subject to clause 9 and</em> the Order Form.</p>'
    const { text } = __testing.spliceInto(html, 'Party shall deliver the Services on time, subject to clause 9', 'Party shall deliver the Services promptly', escapeHtml)
    expect(text).toBe('<p>The <strong>Supplier </strong>Party shall deliver the Services promptly<em> and</em> the Order Form.</p>')
  })
})

describe('a clause whose text runs across paragraphs', () => {
  const { planEditsInBoth, applySpans } = __testing
  const html = '<h1>3. LIMITATION OF LIABILITY</h1><ol><li>Supplier’s aggregate liability shall not exceed the fees paid in the one (1) month preceding the claim.</li>'
    + '<li>Customer’s liability under this Agreement shall be unlimited.</li></ol><table><tr><td><p>Plan</p></td><td><p>USD 120,000</p></td></tr></table>'
  const plain = '3. LIMITATION OF LIABILITY Supplier’s aggregate liability shall not exceed the fees paid in the one (1) month preceding the claim. Customer’s liability under this Agreement shall be unlimited. Plan USD 120,000'
  const clause = '3. LIMITATION OF LIABILITY Supplier’s aggregate liability shall not exceed the fees paid in the one (1) month preceding the claim. Customer’s liability under this Agreement shall be unlimited. Plan USD 120,000'

  it('applies the rewrite\'s own edits, each inside its paragraph, leaving the table as it is', () => {
    const edits = planEditsInBoth(html, plain, clause, [
      { before: 'one (1) month', after: 'twelve (12) months' },
      { before: "Customer's liability under this Agreement shall be unlimited.", after: 'Each party’s liability is capped as above.' },
    ])!
    expect(edits).not.toBeNull()
    expect(applySpans(html, edits.html, true)).toBe(
      '<h1>3. LIMITATION OF LIABILITY</h1><ol><li>Supplier’s aggregate liability shall not exceed the fees paid in the twelve (12) months preceding the claim.</li>'
      + '<li>Each party’s liability is capped as above.</li></ol><table><tr><td><p>Plan</p></td><td><p>USD 120,000</p></td></tr></table>')
    expect(applySpans(plain, edits.plain, false)).toContain('twelve (12) months preceding the claim. Each party’s liability is capped as above. Plan')
  })

  it('applies none of them when one can\'t be placed', () => {
    expect(planEditsInBoth(html, plain, clause, [
      { before: 'one (1) month', after: 'twelve (12) months' },
      { before: 'text that is not in the clause', after: 'x' },
    ])).toBeNull()
    expect(planEditsInBoth(html, plain, clause, [])).toBeNull()
  })
})

describe('a rewrite\'s edit that runs across paragraphs', () => {
  const { planEditsInBoth, applySpans } = __testing
  const html = '<h1>2. FEES</h1><ol><li>Customer shall pay all invoices within fifteen (15) days of the invoice date.</li><li>Supplier may increase the fees by up to 12% a year.</li><li>Late payments bear interest at 2% per month.</li></ol>'
    + '<h1>3. LIABILITY</h1><ol><li>Supplier’s aggregate liability shall not exceed one month of fees.</li><li>Customer’s liability shall be unlimited.</li></ol><table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>'
  const plain = '2. FEES Customer shall pay all invoices within fifteen (15) days of the invoice date. Supplier may increase the fees by up to 12% a year. Late payments bear interest at 2% per month. 3. LIABILITY Supplier’s aggregate liability shall not exceed one month of fees. Customer’s liability shall be unlimited. A B'

  it('finds an edit in the whole document when the clause skips a paragraph that is another clause', () => {
    const edits = planEditsInBoth(html, plain, '2. FEES Customer shall pay all invoices within fifteen (15) days of the invoice date. Late payments bear interest at 2% per month.',
      [{ before: 'Customer shall pay all invoices within fifteen (15) days of the invoice date.', after: 'Customer shall pay undisputed invoices within sixty (60) days.' }])
    expect(edits).not.toBeNull()
    expect(applySpans(html, edits!.html, true)).toContain('<ol><li>Customer shall pay undisputed invoices within sixty (60) days.</li><li>Supplier may increase')
  })

  it('merges neighbouring list items an edit runs across, keeping its line breaks', () => {
    const edits = planEditsInBoth(html, plain, '3. LIABILITY Supplier’s aggregate liability shall not exceed one month of fees. Customer’s liability shall be unlimited.',
      [{ before: 'Supplier’s aggregate liability shall not exceed one month of fees. Customer’s liability shall be unlimited.', after: 'Each party’s liability is capped at twelve months of fees.\n\n"Excluded Claims" means fraud.' }])
    expect(edits).not.toBeNull()
    expect(applySpans(html, edits!.html, true)).toContain('<h1>3. LIABILITY</h1><ol><li>Each party’s liability is capped at twelve months of fees.<br /><br />"Excluded Claims" means fraud.</li></ol><table>')
  })

  it('does not merge across a table, a heading or out of a list', () => {
    expect(planEditsInBoth(html, plain, 'x'.repeat(30), [{ before: 'Customer’s liability shall be unlimited. A B', after: 'x' }])).toBeNull()
    expect(planEditsInBoth(html, plain, 'x'.repeat(30), [{ before: 'Late payments bear interest at 2% per month. 3. LIABILITY', after: 'x' }])).toBeNull()
  })
})
