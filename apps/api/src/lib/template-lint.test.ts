/**
 * docs/41 Part 2 — a template that says what the playbook only falls back to
 * is flagged when it is published (deterministically, no LLM).
 */
import { describe, it, expect } from 'vitest'
import { lintSnapshot, yearsIn, type LintPosition } from './template-lint.js'
import { evaluateNumericBound } from './playbook-rules.js'
import type { TemplateSnapshot } from './template-snapshot.js'
import { UNIVERSAL_TEMPLATES } from './org-seed/universal/templates.js'
import { UNIVERSAL_PLAYBOOK } from './org-seed/universal/playbook.js'
import { UNIVERSAL_CATEGORIES } from './org-seed/universal/categories.js'
import { matchCategory } from './clause-category.js'

const CONF = { id: 'cat_conf', name: 'Confidentiality' }
const DISPUTE = { id: 'cat_dispute', name: 'Dispute Resolution' }
const pos = (id: string, positionType: string, content: string, extra: Partial<LintPosition> = {}): LintPosition => ({
  id, positionType, content, contractTypes: [], libraryItemId: null, rules: null, category: CONF, ...extra,
})
const POSITIONS = [
  pos('p5', 'preferred', '<p>5-year confidentiality term, indefinite for trade secrets.</p>'),
  pos('a5', 'acceptable', '<p>5-year confidentiality term. Standard exclusions.</p>'),
  pos('f3', 'fallback', '<p>3-year confidentiality term, indefinite for trade secrets. Standard exclusions.</p>'),
  pos('w2', 'walkaway', '<p>Confidentiality term of 2 years or less with NO trade-secret carve-out.</p>'),
]

const snap = (sections: TemplateSnapshot['sections'], variables: unknown[] = [], contractType = 'NDA'): TemplateSnapshot => ({
  templateId: 't', name: 'NDA', contractType, version: 1, variables, sections,
})
const TERM = { id: 'term', title: 'Term', sortOrder: 60, content: '<p>The obligations of confidentiality continue for {{confidentialityYears}} years from the date of disclosure.</p>', conditionalLogic: null, clauseRefs: [] }

describe('template lint', () => {
  it('a confidentiality term of 3 years is the fallback, not the preferred position', () => {
    const w = lintSnapshot(snap([TERM], [{ key: 'confidentialityYears', defaultValue: 3 }]), POSITIONS)
    expect(w).toEqual([expect.objectContaining({
      sectionId: 'term', severity: 'warning', code: 'fallback_position', positionId: 'f3', positionType: 'fallback',
      message: 'Confidentiality term of 3 years is your fallback position, not your preferred one (5 years).',
    })])
  })

  it('5 years is the preferred position: nothing to say', () => {
    expect(lintSnapshot(snap([TERM], [{ key: 'confidentialityYears', defaultValue: 5 }]), POSITIONS)).toEqual([])
  })

  it('a walkaway figure is an error', () => {
    const w = lintSnapshot(snap([{ ...TERM, content: '<p>Confidentiality lasts two (2) years.</p>' }]), POSITIONS)
    expect(w[0]).toMatchObject({ severity: 'error', code: 'walkaway_position', positionId: 'w2' })
  })

  it('the exact words of a fallback position are flagged; positions for another contract type are not used', () => {
    const exact = { ...TERM, content: POSITIONS[2].content }
    expect(lintSnapshot(snap([exact]), POSITIONS)[0]).toMatchObject({ code: 'fallback_position', positionId: 'f3' })
    const msaOnly = POSITIONS.map(p => ({ ...p, contractTypes: ['MSA'] }))
    expect(lintSnapshot(snap([exact]), msaOnly)).toEqual([])
  })

  it('a slot variant a position names is that position', () => {
    const slot = {
      id: 'law', title: 'Governing Law', sortOrder: 70, content: '', conditionalLogic: null, clauseRefs: [],
      slot: { family: { id: 'f', name: 'Governing Law', requestKey: 'governingLaw' }, variants: [
        { id: 'v_tx', label: 'Texas', version: 1, content: '<p>Texas law.</p>', condition: null, matchValues: [], isDefault: false, order: 0 },
      ] },
    }
    const w = lintSnapshot(snap([slot]), [pos('pw', 'walkaway', '<p>Unfamiliar law.</p>', { category: DISPUTE, libraryItemId: 'v_tx' })])
    expect(w[0]).toMatchObject({ variantId: 'v_tx', variantLabel: 'Texas', code: 'walkaway_position', message: '“Governing Law” (Texas) uses your walkaway position for Dispute Resolution, not your preferred one.' })
  })

  it('a slot with no approved wording says every draft will ask', () => {
    const slot = { id: 'law', title: 'Governing Law', sortOrder: 70, content: '', conditionalLogic: null, clauseRefs: [], slot: { family: { id: 'f', name: 'Governing Law', requestKey: null }, variants: [] } }
    expect(lintSnapshot(snap([slot]), POSITIONS)[0]).toMatchObject({ code: 'slot_without_wording' })
  })

  it('a structured bound in years is judged (lib/playbook-rules.ts)', () => {
    const bounded = [pos('pb', 'preferred', '<p>Confidentiality protected.</p>', { rules: { bounds: { confidentiality_years: { min: 4, units: 'years', severity: 'high' } } } })]
    const w = lintSnapshot(snap([TERM], [{ key: 'confidentialityYears', defaultValue: 3 }]), bounded)
    expect(w[0]).toMatchObject({ code: 'below_bound', message: '“Term”: 3 years is below your minimum of 4 years.'.replace('“Term”', 'Confidentiality in “Term”') })
    expect(evaluateNumericBound(6, { max: 5, units: 'years' })).toEqual({ passed: false, reason: '6 years is above your maximum of 5 years' })
  })

  it('reads terms in years written either way', () => {
    expect(yearsIn('a period of five (5) years')).toBe(5)
    expect(yearsIn('3-year term')).toBe(3)
    expect(yearsIn('twelve months')).toBeNull()
  })
})

describe('the seeded NDA and the seeded playbook agree', () => {
  // The seed's positions, as lint reads them (category by slug → name).
  const categories = new Map(UNIVERSAL_CATEGORIES.map(c => [c.slug, { id: c.slug, name: c.name }]))
  const positions: LintPosition[] = UNIVERSAL_PLAYBOOK.map(p => ({
    id: p.key, positionType: p.positionType, content: p.content, contractTypes: p.contractTypes, libraryItemId: null, rules: null, category: categories.get(p.categorySlug)!,
  }))

  for (const name of ['Mutual Non-Disclosure Agreement', 'One-Way Non-Disclosure Agreement (Inbound)']) {
    it(`${name}: no lint warning`, () => {
      const t = UNIVERSAL_TEMPLATES.find(x => x.name === name)!
      const s = snap(t.sections.map((x, i) => ({ id: `s${i}`, title: x.title, sortOrder: x.sortOrder, content: x.content, conditionalLogic: null, clauseRefs: [] })), t.variables)
      expect(lintSnapshot(s, positions)).toEqual([])
    })
  }

  it('as first seeded (3 years), the Mutual NDA was flagged by its own playbook', () => {
    const t = UNIVERSAL_TEMPLATES.find(x => x.name === 'Mutual Non-Disclosure Agreement')!
    const s = snap(t.sections.map((x, i) => ({ id: `s${i}`, title: x.title, sortOrder: x.sortOrder, content: x.content, conditionalLogic: null, clauseRefs: [] })),
      t.variables.map(v => (v.key === 'confidentialityYears' ? { ...v, defaultValue: 3 } : v)))
    expect(lintSnapshot(s, positions).map(w => w.message)).toEqual(['Confidentiality term of 3 years is your fallback position, not your preferred one (5 years).'])
  })
})

describe('a seeded NDA has the term its presence rule asks for (41: browser QA)', () => {
  // Term & Termination is required for NDAs; a section that only said how
  // long confidentiality lasts read as confidentiality, so every NDA drafted
  // from the seed was "Term & Termination — not detected".
  const termCategory = UNIVERSAL_CATEGORIES.find(c => c.slug === 'term-termination')!
  it('Term & Termination is required for an NDA, and a termination clause is of that category', () => {
    expect(termCategory.required).toContain('NDA')
    const cats = UNIVERSAL_CATEGORIES.map(c => ({ id: c.slug, name: c.name }))
    expect(matchCategory(cats, 'termination')?.id).toBe('term-termination')
  })

  for (const t of UNIVERSAL_TEMPLATES.filter(x => x.contractType === 'NDA')) {
    it(`${t.name}: says how long it runs and how either party ends it`, () => {
      const term = t.sections.find(x => x.title === 'Term and Termination')
      expect(term?.content).toMatch(/continues until either Party terminates it/i)
      expect(term?.content).toMatch(/written notice/)
    })
  }
})

