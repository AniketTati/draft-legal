/**
 * Expanding a clause topic into the phrases contracts actually use.
 *
 * `portfolio_compare` and `clause_search` both located topics with a literal
 * `text.toLowerCase().indexOf(topic.toLowerCase())`. That only ever matches when
 * the contract contains the search phrase verbatim — and for the phrases agents
 * actually search with, it essentially never does. Contracts do not say
 * "liability cap"; they say "Limitation of Liability", or
 * "in no event shall either party's aggregate liability exceed". They do not say
 * "termination rights"; they say "Termination for Convenience".
 *
 * The result was a tool that answered "not found" for a clause sitting in
 * paragraph 9 of the document, on every contract, while reporting no error. The
 * agent then relayed that as fact. Worse, `portfolio_compare`'s own tool
 * description offers `['termination', 'liability cap', 'auto-renew']` as the
 * example topics — two of those three cannot match a real contract.
 *
 * Found by reading Langfuse traces: `tool_selection` scored 1.0 (the agent chose
 * correctly) while `retrieval_sufficiency` scored 0.0 (what came back was
 * useless). That split is the whole diagnosis — the model was fine, the lookup
 * was broken. A single pass/fail score on the answer could not have told them
 * apart.
 *
 * This is a LEXICAL fallback, not semantic retrieval. The real answer is the
 * Elasticsearch BM25 path (see the note in clause_search). This exists so the
 * tools stop confidently reporting absence in the meantime, and it is
 * deliberately conservative: aliases are drawn from standard commercial-contract
 * drafting, and an unknown topic falls back to the literal phrase, i.e. exactly
 * today's behaviour rather than a guess.
 */

/**
 * Canonical topic → phrases that appear in the documents.
 *
 * Keyed by normalised topic. Values are lowercase substrings, ordered
 * most-specific first so the excerpt lands on a heading rather than a passing
 * mention where both appear.
 */
const TOPIC_ALIASES: Record<string, string[]> = {
  'liability cap': [
    'limitation of liability', 'limitations of liability', 'liability cap',
    'aggregate liability', 'total liability', 'liability shall not exceed',
    'shall not exceed the fees',
  ],
  'limitation of liability': [
    'limitation of liability', 'limitations of liability', 'aggregate liability',
    'total liability', 'liability shall not exceed',
  ],
  'indemnity': [
    'indemnification', 'indemnify', 'indemnities', 'hold harmless', 'indemnitee',
  ],
  'termination': [
    'termination', 'terminate this agreement', 'right to terminate', 'may terminate',
  ],
  'termination rights': [
    'termination for convenience', 'termination for cause', 'right to terminate',
    'may terminate', 'termination',
  ],
  'termination for convenience': ['termination for convenience', 'terminate for convenience', 'without cause'],
  'auto-renew': [
    'automatically renew', 'renew automatically', 'renews automatically', 'auto-renew', 'automatic renewal',
    'renewal term', 'shall renew', 'will renew', 'non-renewal', 'unless either party gives',
  ],
  'renewal': [
    'renewal term', 'automatically renew', 'renew automatically', 'renews automatically', 'automatic renewal',
    'shall renew', 'will renew', 'non-renewal', 'renewal',
  ],
  'governing law': ['governing law', 'governed by the laws', 'choice of law', 'applicable law'],
  'confidentiality': ['confidential information', 'confidentiality', 'non-disclosure', 'nondisclosure'],
  'payment terms': [
    'payment terms', 'net thirty', 'net 30', 'shall pay each invoice',
    'invoice', 'payment shall be due', 'fees and payment',
  ],
  'data protection': [
    'data protection', 'personal data', 'gdpr', 'data processing', 'processing of personal data',
    'data privacy', 'security incident',
  ],
  'intellectual property': [
    'intellectual property', 'ownership of', 'work product', 'proprietary rights', 'license grant',
  ],
  'warranty': ['warranty', 'warranties', 'represents and warrants', 'disclaimer of warranties'],
  'assignment': ['assignment', 'may not assign', 'assign this agreement'],
  'force majeure': ['force majeure', 'acts of god', 'beyond its reasonable control'],
  'dispute resolution': ['dispute resolution', 'arbitration', 'mediation', 'venue', 'jurisdiction'],
  'insurance': ['insurance', 'insurance coverage', 'commercial general liability'],
  'sla': ['service level', 'uptime', 'availability', 'service credits', 'sla'],
  'notice period': ['written notice', 'days notice', 'notice period', 'prior written notice'],
}

/** Same normalisation rule as clause-category, so the two stay comparable. */
function normalise(s: string): string {
  return s.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Lookup keyed by NORMALISED topic.
 *
 * Built rather than hand-written because the literal keys above contain
 * hyphens (`auto-renew`), and a lookup normalises its argument to `auto renew`
 * — so those entries were unreachable and the topic silently fell through to
 * the literal-match path this module exists to replace. Normalising both sides
 * from one source removes the chance to get it wrong again.
 *
 * Alias VALUES are deliberately left alone: they are matched against raw
 * document text, where a hyphen in `non-disclosure` is real.
 */
const ALIASES_BY_KEY: Record<string, string[]> = Object.fromEntries(
  Object.entries(TOPIC_ALIASES).map(([k, v]) => [normalise(k), v]),
)

/**
 * Phrases to search for, given one topic. Always includes the literal topic, so
 * this can only ever find MORE than the old behaviour, never less.
 */
export function topicPhrases(topic: string): string[] {
  // CC4 — the assistant searches as it would a search engine ("auto-renew OR
  // renewal", "notice, termination"): each part is its own topic, not one
  // phrase that no contract contains.
  const parts = topic.split(/\s+OR\s+|\s*\|\s*|\s*,\s*/).map(p => p.replace(/^["'(]+|["')]+$/g, '').trim()).filter(Boolean)
  if (parts.length > 1) return [...new Set(parts.flatMap(p => topicPhrases(p)))]
  const key = normalise(topic)
  const aliases = ALIASES_BY_KEY[key]
  if (aliases) return [...new Set([...aliases, key])]

  // Unknown topic. Try the singular — agents pluralise inconsistently
  // ("liability caps" vs "liability cap") and that alone caused misses.
  const singular = key.replace(/s$/, '')
  if (singular !== key && ALIASES_BY_KEY[singular]) {
    return [...new Set([...ALIASES_BY_KEY[singular], key, singular])]
  }
  return [key]
}

export interface TopicHit {
  /** Index into the ORIGINAL text (not lowercased) where the phrase begins. */
  index: number
  /** The phrase that actually matched — worth surfacing, since it is not always the topic. */
  matchedPhrase: string
}

/**
 * First occurrence of any phrase for `topic`, searching from `fromIndex`.
 *
 * Returns the earliest hit among all phrases rather than the first phrase that
 * hits anywhere: a document mentioning "liability" in the recitals and carrying
 * the real "Limitation of Liability" heading in section 9 should excerpt the
 * heading. Ordering by position in the document approximates that better than
 * alias order does, and costs one extra scan.
 */
export function findTopic(text: string, topic: string, fromIndex = 0): TopicHit | null {
  const lower = text.toLowerCase()
  let best: TopicHit | null = null
  for (const phrase of topicPhrases(topic)) {
    const idx = lower.indexOf(phrase, fromIndex)
    if (idx === -1) continue
    if (!best || idx < best.index) best = { index: idx, matchedPhrase: phrase }
  }
  return best
}
