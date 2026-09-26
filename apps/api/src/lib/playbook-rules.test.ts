/**
 * DD1 — the demo org's liability rules on §3 of the Brightwave agreement, as
 * extraction left it: the cap sentences in one row, the "Excluded Claims"
 * definition in another. The check said the cap wasn't stated (walkaway),
 * wasn't mutual, and left both cap limits for the chat model to work out.
 * §3 matches the org's preferred position; its one real gap is that it
 * doesn't exclude consequential damages.
 */
import { describe, it, expect } from 'vitest'
import { evaluatePlaybookRules, dedupeViolations, pickWorstSeverity, ruleTextsFor, type PlaybookRules } from './playbook-rules.js'
import { LIABILITY_RULES } from './demo-liability-rules.js'

const CAP = {
  id: 'cap',
  content: "Except for the Excluded Claims set forth below, each party's aggregate liability arising out of or related to this Agreement shall not exceed two (2) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim. For claims arising from a breach of Section 6 (Confidentiality) involving unauthorized disclosure of Customer Data, the aggregate liability cap shall be three (3) times the fees paid or payable in the twelve (12) months preceding the event giving rise to the claim.",
}
const EXCLUDED = {
  id: 'excluded',
  content: '"Excluded Claims" means:(a) either party\'s indemnification obligations under Section 4 (Indemnification);(b) a breach of Section 6 (Confidentiality) (except as specifically provided above for Customer Data);(c) Customer\'s payment obligations under Section 2 (FEES AND PAYMENT);(d) either party\'s gross negligence or willful misconduct; and(e) either party\'s infringement or misappropriation of the other party\'s intellectual property rights.',
}
const PREFERRED = LIABILITY_RULES as unknown as PlaybookRules
const WALKAWAY = { must_not: LIABILITY_RULES.must_not } as unknown as PlaybookRules
// The demo org has two preferred liability positions carrying the same rules.
const POSITIONS: Array<[PlaybookRules, string]> = [[PREFERRED, 'preferred'], [PREFERRED, 'preferred'], [WALKAWAY, 'walkaway']]

function judge(id: string) {
  const { texts } = ruleTextsFor([CAP, EXCLUDED])
  return dedupeViolations(POSITIONS.flatMap(([rules, type]) => evaluatePlaybookRules(rules, texts.get(id)!, type)))
}

describe('liability rules on the Brightwave §3', () => {
  it('finds the cap stated and mutual, and only the consequential-damages gap', () => {
    const failed = judge('cap').filter(v => v.passed === false)
    expect(failed.map(v => v.ruleId)).toEqual(['lol.consequential_damages_carveout'])
    expect(pickWorstSeverity(judge('cap'))).toBe('high')
  })

  it('measures the cap against both limits', () => {
    const bounds = judge('cap').filter(v => v.kind === 'bound')
    expect(bounds.map(b => [b.boundKey, b.passed, b.value, b.computed])).toEqual([
      ['liability_cap_months', true, 24, true],
      ['cap_multiplier_of_annual', true, 2, true],
    ])
    expect(bounds[0].reason).toContain('That is 24 months of fees, within the limit.')
  })

  it('judges the definition row on its own words only', () => {
    const v = judge('excluded')
    expect(v.every(x => x.kind === 'must_not' && x.passed === true)).toBe(true)
  })

  it('reports a rule two positions share once', () => {
    const v = judge('cap')
    const ids = v.map(x => `${x.kind}:${x.ruleId ?? x.boundKey}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('still fails a cap outside the limit, and one-sided wording', () => {
    const one = { id: 'one', content: "Supplier's total liability shall not exceed three (3) times the fees paid in the twelve (12) months before the claim." }
    const { texts } = ruleTextsFor([one])
    const v = dedupeViolations(evaluatePlaybookRules(PREFERRED, texts.get('one')!, 'preferred'))
    const failed = v.filter(x => x.passed === false).map(x => x.ruleId ?? x.boundKey)
    expect(failed).toEqual(['lol.mutual_cap', 'lol.consequential_damages_carveout', 'liability_cap_months'])
  })
})
