/**
 * The demo org's structured rules for its "Limitation of Liability"
 * positions (P1.2 / docs/28 C.2.1), seeded by scripts/seed-playbook-rules.ts.
 *
 * Structured rule sample: cap type, consequential-damages carve-out, the
 * liability cap itself. The evaluator walks `must_have[]` over the clause
 * type's text and measures the cap against `bounds` (lib/liability-cap.ts).
 *
 * DD1 — the patterns read how contracts are written. "mutual" failed
 * "each party's aggregate liability"; the cap pattern failed "two (2) times
 * the fees … in the twelve (12) months", at walkaway severity.
 */
export const LIABILITY_RULES = {
  must_have: [
    {
      id: 'lol.mutual_cap',
      description: 'Liability cap must apply MUTUALLY (both parties).',
      check: 'regex',
      value: String.raw`\bmutual(?:ly)?\b|\b(?:each|either|neither)\s+party(?:'s|’s)?\s+(?:(?:total|aggregate|cumulative|entire|maximum|overall)\s+)*liabilit|\b(?:each|either|neither)\s+party\s+(?:shall|will)\s+(?:not\s+)?be\s+liable|\bthe\s+parties(?:'|’)?\s+(?:(?:total|aggregate|cumulative)\s+)*liabilit`,
      severity: 'high',
    },
    {
      id: 'lol.consequential_damages_carveout',
      description: 'Must exclude consequential / indirect / special damages for both sides.',
      check: 'contains',
      value: 'consequential',
      severity: 'high',
    },
    {
      id: 'lol.cap_is_stated',
      description: 'A specific liability cap amount or multiple must be stated.',
      check: 'regex',
      value: String.raw`(?:us\$|\$|€|£|\b(?:usd|eur|gbp))\s?\d|\d\s*(?:x|×|%)(?![a-z])|\(\d+(?:\.\d+)?%?\)\s*(?:times|months?|years?|percent)|\b\d+(?:\.\d+)?\s*(?:times|months?|years?)\b|\b(?:one|two|three|four|five|six|nine|twelve|eighteen|twenty-four|thirty-six)\s+(?:times|months?|years?)\b|\btwice\b`,
      severity: 'walkaway',
    },
  ],
  must_not: [
    {
      id: 'lol.uncapped',
      description: 'Must NOT contain "unlimited" or "uncapped" liability language.',
      check: 'contains',
      value: 'unlimited',
      severity: 'walkaway',
    },
    {
      id: 'lol.uncapped_2',
      description: 'Must NOT contain "uncapped" liability language.',
      check: 'contains',
      value: 'uncapped',
      severity: 'walkaway',
    },
  ],
  bounds: {
    liability_cap_months: {
      min: 6,
      max: 24,
      units: 'months of fees',
      severity: 'high',
      description: 'Cap should be 6-24 months of fees. >24 months = off-market.',
    },
    cap_multiplier_of_annual: {
      max: 3,
      units: 'x annual contract value',
      severity: 'walkaway',
      description: 'Any cap > 3× annual contract value → escalate to General Counsel.',
    },
  },
  variables: [
    { key: 'cap_amount', type: 'string', required: true },
    { key: 'cap_unit',   type: 'string', required: true },
  ],
}
