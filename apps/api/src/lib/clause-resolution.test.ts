/**
 * docs/41 Part 1 — a clause slot is decided by rule, in a fixed order, and
 * the same inputs always decide it the same way.
 */
import { describe, it, expect } from 'vitest'
import { conditionHolds, describeCondition, isClauseCondition, matchKey, resolveSlot, slotChoiceKey, type SlotVariant, type ClauseCondition } from '@clm/types'
import { resolveSlots, sentenceNaming, quoteIn } from './clause-resolution.js'
import { fingerprint, normaliseForFingerprint } from './fingerprint.js'
import { generateDocument, type TemplateWithSections } from './template-engine.js'
import type { TemplateSnapshot } from './template-snapshot.js'

const EU: ClauseCondition = { op: 'in', key: 'counterparty.country', value: ['DE', 'FR', 'IE', 'GB'] }
const BIG: ClauseCondition = { op: 'gt', key: 'value', value: 250000 }

const variant = (id: string, label: string, extra: Partial<SlotVariant> = {}): SlotVariant => ({
  id, label, version: 1, content: `<p>Governed by the laws of ${label}.</p>`, condition: null, matchValues: [label], isDefault: false, order: 0, ...extra,
})
const NY = variant('ny', 'New York', { matchValues: ['New York', 'NY'], order: 0 })
const EW = variant('ew', 'England and Wales', { matchValues: ['England and Wales', 'England'], condition: EU, order: 1 })
const DE = variant('de', 'Delaware', { order: 2, isDefault: true })
const family = { id: 'fam_law', name: 'Governing Law', requestKey: 'governingLaw' }

describe('the condition language', () => {
  it('eq / neq / in compare as words, case aside', () => {
    expect(conditionHolds({ op: 'eq', key: 'contractType', value: 'nda' }, { contractType: 'NDA' })).toBe(true)
    expect(conditionHolds({ op: 'neq', key: 'paperSource', value: 'ours' }, { paperSource: 'theirs' })).toBe(true)
    expect(conditionHolds(EU, { 'counterparty.country': 'gb' })).toBe(true)
    expect(conditionHolds(EU, { 'counterparty.country': 'US' })).toBe(false)
  })

  it('gt / gte / lt / lte compare as numbers', () => {
    expect(conditionHolds(BIG, { value: 300000 })).toBe(true)
    expect(conditionHolds(BIG, { value: '250000' })).toBe(false)
    expect(conditionHolds({ op: 'gte', key: 'value', value: 250000 }, { value: 250000 })).toBe(true)
    expect(conditionHolds({ op: 'lt', key: 'value', value: 10 }, { value: 'ten' })).toBe(false)
    expect(conditionHolds({ op: 'lte', key: 'value', value: 10 }, { value: 10 })).toBe(true)
  })

  it('and / or combine; a missing fact makes a test false, never true', () => {
    const both: ClauseCondition = { op: 'and', all: [EU, BIG] }
    expect(conditionHolds(both, { 'counterparty.country': 'DE', value: 500000 })).toBe(true)
    expect(conditionHolds(both, { 'counterparty.country': 'DE' })).toBe(false)
    expect(conditionHolds({ op: 'or', all: [EU, BIG] }, { value: 500000 })).toBe(true)
    expect(conditionHolds({ op: 'neq', key: 'paperSource', value: 'ours' }, {})).toBe(false)
  })

  it('malformed conditions are refused and never hold', () => {
    expect(isClauseCondition({ op: 'in', key: 'value', value: [] })).toBe(false)
    expect(isClauseCondition({ op: 'gt', key: 'value', value: 'big' })).toBe(false)
    expect(isClauseCondition({ op: 'and', all: [] })).toBe(false)
    expect(isClauseCondition({ op: 'regex', key: 'x', value: '.*' })).toBe(false)
    expect(isClauseCondition({ op: 'or', all: [EU, BIG] })).toBe(true)
    expect(conditionHolds({ op: 'nope' } as never, {})).toBe(false)
  })

  it('reads in words', () => {
    expect(describeCondition({ op: 'and', all: [EU, BIG] })).toBe('Counterparty country is one of DE, FR, IE, GB and Contract value is more than 250000')
  })

  it('matches names exactly, "the State of" and "law" aside', () => {
    expect(matchKey('the State of New York')).toBe(matchKey('New York'))
    expect(matchKey('New York law')).toBe('newyork')
    expect(matchKey('England & Wales')).toBe(matchKey('England and Wales'))
    expect(matchKey('New Jersey')).not.toBe(matchKey('New York'))
  })
})

describe('resolution order', () => {
  const variants = [NY, EW, DE]

  it('1. the user\'s choice wins over everything', () => {
    const d = resolveSlot({ family, variants, choice: 'de', requestValues: { governingLaw: { value: 'New York' } }, facts: { 'counterparty.country': 'GB' } })
    expect(d).toMatchObject({ decidedBy: 'user', variantId: 'de', variantVersion: 1 })
  })

  it('2. a value the request named, matched exactly, with its quote', () => {
    const d = resolveSlot({ family, variants, requestValues: { governingLaw: { value: 'NY', quote: 'under NY law' } }, facts: { 'counterparty.country': 'GB' } })
    expect(d).toMatchObject({ decidedBy: 'request_value', variantId: 'ny', evidence: { key: 'governingLaw', value: 'NY', quote: 'under NY law' } })
  })

  it('2. a named value no variant is for leaves the choice open — never the default', () => {
    const d = resolveSlot({ family, variants, requestValues: { governingLaw: { value: 'Texas' } } })
    expect(d).toMatchObject({ decidedBy: 'unresolved', variantId: null })
    expect(d.reason).toContain('Texas')
  })

  it('3. the first variant whose condition holds, in order', () => {
    const d = resolveSlot({ family, variants, facts: { 'counterparty.country': 'IE' } })
    expect(d).toMatchObject({ decidedBy: 'rule', variantId: 'ew', ruleId: 'ew', rule: 'Counterparty country is one of DE, FR, IE, GB' })
  })

  it('4. the family default', () => {
    expect(resolveSlot({ family, variants, facts: { 'counterparty.country': 'US' } })).toMatchObject({ decidedBy: 'default', variantId: 'de' })
  })

  it('5. unresolved when nothing decides', () => {
    const d = resolveSlot({ family, variants: [NY, EW] })
    expect(d).toMatchObject({ decidedBy: 'unresolved', variantId: null, reason: 'No rule decided it and there is no default.' })
    expect(resolveSlot({ family, variants: [] }).reason).toBe('This clause has no approved wording yet.')
  })

  it('an unknown choice is ignored, not trusted', () => {
    expect(resolveSlot({ family, variants, choice: 'someone-elses' })).toMatchObject({ decidedBy: 'default', variantId: 'de' })
  })

  it('is deterministic whatever order the variants arrive in', () => {
    const a = resolveSlot({ family, variants: [DE, EW, NY], facts: { 'counterparty.country': 'FR' } })
    const b = resolveSlot({ family, variants: [NY, DE, EW], facts: { 'counterparty.country': 'FR' } })
    expect(a).toEqual(b)
  })
})

const snapshot: TemplateSnapshot = {
  templateId: 'tpl', name: 'NDA', contractType: 'NDA', version: 3, variables: [],
  sections: [
    { id: 's1', title: 'Purpose', sortOrder: 0, content: '<p>For {{purpose}}.</p>', conditionalLogic: null, clauseRefs: [] },
    { id: 's2', title: 'Governing Law', sortOrder: 1, content: '', conditionalLogic: null, clauseRefs: [], slot: { family, variants: [NY, EW] } },
  ],
}

describe('a template\'s slots in a draft', () => {
  const REQUEST = 'NDA with Initech.\nIt should be governed by New York law, please.'

  it('quotes the request\'s own sentence for a value it named', () => {
    const r = resolveSlots({ snapshot, requestValues: { governingLaw: { value: 'New York' } }, requestText: REQUEST, requireQuote: true })
    expect(r.slots[0]).toMatchObject({ decidedBy: 'request_value', variantId: 'ny', evidence: { quote: 'It should be governed by New York law, please.' } })
    expect(r.slotText.get('s2')).toMatchObject({ source: 'library:ny:1', familyId: 'fam_law' })
    expect(r.impliedValues.governingLaw).toEqual({ value: 'New York', familyId: 'fam_law' })
  })

  it('on the request path, a value the request\'s words don\'t say is not used', () => {
    const r = resolveSlots({ snapshot, requestValues: { governingLaw: { value: 'England' } }, requestText: REQUEST, requireQuote: true })
    expect(r.slots[0].decidedBy).toBe('unresolved')
  })

  it('an undecided slot is a blank listing the options: an open choice', () => {
    const r = resolveSlots({ snapshot })
    const blank = r.slotText.get('s2')!.html
    expect(blank).toContain(`data-key="${slotChoiceKey('fam_law')}"`)
    expect(blank).toContain('template-variable-unfilled')
    expect(blank).toContain('[[Choose governing law: New York · England and Wales]]')
    expect(r.slots[0].options).toEqual([{ id: 'ny', label: 'New York' }, { id: 'ew', label: 'England and Wales' }])
  })

  it('finds sentences by whole words and checks quotes ignoring spacing', () => {
    expect(sentenceNaming('Use NYC courts. Under NY law.', ['NY'])).toBe('Under NY law.')
    expect(sentenceNaming('Nothing here', ['NY'])).toBeNull()
    expect(quoteIn(REQUEST, 'governed  by new york LAW')).toBe(true)
    expect(quoteIn(REQUEST, 'governed by Delaware law')).toBe(false)
  })
})

describe('fingerprints at generation', () => {
  const template = {
    id: 'tpl', version: 3, name: 'NDA',
    sections: snapshot.sections.map(s => ({ ...s, templateId: 'tpl', slotFamilyId: s.slot?.family.id ?? null })),
  } as unknown as TemplateWithSections

  it('stamps each section with the fingerprint of its words and where they came from', () => {
    const { slotText } = resolveSlots({ snapshot, choices: { fam_law: 'ew' } })
    const g = generateDocument({ template, variables: { purpose: 'a partnership' }, slotText })
    expect(g.sections).toEqual([
      { sectionId: 's1', fp: fingerprint('<p>For {{purpose}}.</p>'), source: 'template:tpl:3:s1' },
      { sectionId: 's2', slot: 'fam_law', fp: fingerprint(EW.content), source: 'library:ew:1' },
    ])
    expect(g.html).toContain(`data-fp="${g.sections[0].fp}" data-source="template:tpl:3:s1"`)
    expect(g.html).toContain('Governed by the laws of England and Wales.')
  })

  it('a value filled in doesn\'t change the fingerprint; changed words do', () => {
    const a = fingerprint('<p>For <span data-variable="purpose">a partnership</span>.</p>', { purpose: 'a partnership' })
    const b = fingerprint('<p>For <span data-variable="purpose">an acquisition</span>.</p>', { purpose: 'an acquisition' })
    expect(a).toBe(b)
    expect(a).toBe(fingerprint('<p>For {{purpose}}.</p>'))
    expect(fingerprint('<p>Only for {{purpose}}.</p>')).not.toBe(a)
    expect(normaliseForFingerprint('<p>“Hello”&nbsp; [[name]]</p>')).toBe('"hello" {{name}}')
  })
})
