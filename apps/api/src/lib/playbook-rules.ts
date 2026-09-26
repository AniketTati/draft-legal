/**
 * Structured playbook rules (P1.2, docs/28 C.2.1), judged against a
 * contract's clauses. Moved out of routes/internal-ai.ts for DD1.
 *
 * `PlaybookPosition.rules` is free-form JSON; we runtime-type it via the
 * shape below. Everything optional — orgs can ship must_have without
 * must_not, bounds-only configs, etc.
 *
 * DD1 — how a clause type's rules are judged:
 *   - must_have rules on all of that type's clauses together, once. A
 *     contract states its liability terms across sentences that extraction
 *     may split into rows: the "Excluded Claims" definition, a row of §3 on
 *     its own, "failed" the rule that a cap be stated, at walkaway severity.
 *   - must_not rules on each clause, where the words are.
 *   - bounds on the cap, measured from the words (liability-cap.ts). They
 *     were left `passed: null` for the chat model to work out.
 *   - two positions carrying the same rule report it once.
 */
import { liabilityCaps, evaluateCapBound, type LiabilityCap } from './liability-cap.js'

/**
 * One severity vocabulary for the whole playbook surface.
 *
 * The structured-rules path used `low|medium|high|walkaway`; the LLM review
 * path (playbook_review_agent.py) emits `low|medium|high|critical`. Both write
 * into the same field, so an org whose rules say `critical` was silently
 * mis-ranked. `critical` is accepted here and treated as equivalent to
 * `walkaway` — both mean "a human must look at this before it goes anywhere".
 */
export type PlaybookSeverity = 'low' | 'medium' | 'high' | 'critical' | 'walkaway'
type PlaybookRuleCheck = 'contains' | 'regex' | 'present' | 'absent'

interface PlaybookRule {
  id?:          string
  description:  string
  check:        PlaybookRuleCheck
  value:        string     // substring / regex source / marker token
  severity:     PlaybookSeverity
}

interface PlaybookBound {
  min?:         number
  max?:         number
  units?:       string
  severity:     PlaybookSeverity
  description?: string
}

export interface PlaybookRules {
  must_have?:   PlaybookRule[]
  must_not?:    PlaybookRule[]
  bounds?:      Record<string, PlaybookBound>
  variables?:   Array<{ key: string; type: string; required?: boolean; default?: unknown }>
}

// Ascending. `critical` and `walkaway` are peers — different words for the same
// stop condition, arriving from the LLM path and the rules path respectively.
const SEVERITY_ORDER: PlaybookSeverity[] = ['low', 'medium', 'high', 'critical', 'walkaway']

/**
 * Rank a severity, tolerating values written by hand into a rules JSON.
 *
 * `SEVERITY_ORDER.indexOf(x)` returns -1 for anything unrecognised, and -1 is
 * LOWER than every real rank — so an unknown severity lost to the next `low`
 * that came along. That is how a `critical` violation ended up reported as
 * `low`. Unknown values now rank at the TOP: if we cannot interpret how
 * serious something is, the safe reading is "serious".
 */
export function severityRank(sev: string | undefined | null): number {
  if (!sev) return -1
  const i = SEVERITY_ORDER.indexOf(sev as PlaybookSeverity)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/** What a clause's rules are judged against. */
export interface RuleTexts {
  /** The clause's own words: must_not rules. */
  own: string
  /** All of the clause type's words in the contract: must_have rules. Null: not judged here. */
  all: string | null
  /** The caps those words state: bounds. Null: bounds not judged here. */
  caps: LiabilityCap[] | null
}

/**
 * Walk a rules object against a clause. Returns one entry per evaluated
 * rule with `{passed, ...}`. A bound is judged when the caps give its
 * figure (`computed: true`, with the value and the reason); otherwise its
 * `passed` stays null and the agent LLM can still see the bound.
 */
export function evaluatePlaybookRules(
  rules:        PlaybookRules,
  texts:        RuleTexts | string,
  positionType: string,
): Array<Record<string, unknown>> {
  const t: RuleTexts = typeof texts === 'string' ? { own: texts, all: texts, caps: null } : texts
  const out: Array<Record<string, unknown>> = []
  const own = t.own.toLowerCase()

  if (t.all != null) {
    const all = t.all.toLowerCase()
    for (const r of rules.must_have ?? []) {
      out.push({
        kind: 'must_have', position: positionType,
        ruleId: r.id, description: r.description, severity: r.severity,
        check: r.check, value: r.value,
        // "passed" for a must_have rule means the match hit.
        passed: ruleMatches(r, all),
      })
    }
  }
  for (const r of rules.must_not ?? []) {
    out.push({
      kind: 'must_not', position: positionType,
      ruleId: r.id, description: r.description, severity: r.severity,
      check: r.check, value: r.value,
      // For must_not we flip: "passed" means the text does NOT contain it.
      passed: !ruleMatches(r, own),
    })
  }
  if (t.all != null) {
    for (const [key, b] of Object.entries(rules.bounds ?? {})) {
      const judged = t.caps ? evaluateCapBound(t.caps, b) : null
      out.push({
        kind: 'bound', position: positionType,
        boundKey: key, description: b.description, severity: b.severity,
        min: b.min, max: b.max, units: b.units,
        // Null when the words don't give the figure (or the bound isn't about
        // a cap): the P1.3 judge, or the reader, can still weigh it.
        passed: judged?.passed ?? null,
        ...(judged && { computed: judged.passed !== null, value: judged.value, reason: judged.reason }),
      })
    }
  }
  return out
}

function ruleMatches(rule: PlaybookRule, lowerText: string): boolean {
  switch (rule.check) {
    case 'contains': return lowerText.includes(rule.value.toLowerCase())
    case 'regex':
      try { return new RegExp(rule.value, 'i').test(lowerText) }
      catch { return false }
    case 'present':  return lowerText.includes(rule.value.toLowerCase())
    case 'absent':   return !lowerText.includes(rule.value.toLowerCase())
    default:         return false
  }
}

/** The same rule from two positions (the demo org has two preferred liability positions carrying the same rules) is one result: the failing one, if either fails. */
export function dedupeViolations(violations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const keep = new Map<string, Record<string, unknown>>()
  for (const v of violations) {
    const key = [v.kind, v.ruleId ?? v.boundKey ?? '', v.description ?? '', v.check ?? '', v.value ?? '', v.min ?? '', v.max ?? ''].join('|')
    const had = keep.get(key)
    const worse = !had
      || (had.passed !== false && v.passed === false)
      || (had.passed === false && v.passed === false && severityRank(v.severity as string) > severityRank(had.severity as string))
    if (worse) keep.set(key, v)
  }
  return [...keep.values()]
}

export function pickWorstSeverity(
  violations: Array<Record<string, unknown>>,
): PlaybookSeverity | null {
  let worst: PlaybookSeverity | null = null
  for (const v of violations) {
    if (v.passed === true || v.passed === null) continue // no violation
    const sev = v.severity as PlaybookSeverity | undefined
    if (!sev) continue
    if (!worst || severityRank(sev) > severityRank(worst)) {
      worst = sev
    }
  }
  return worst
}

export function ruleCountOf(rules: PlaybookRules | null): number {
  if (!rules) return 0
  return (rules.must_have?.length ?? 0)
       + (rules.must_not?.length  ?? 0)
       + Object.keys(rules.bounds ?? {}).length
}

/**
 * How each clause of one clause type is judged. The first clause stating a
 * cap (or, with none, the first clause) carries the type's must_have and
 * bound results; every clause carries its own must_not results.
 */
export function ruleTextsFor<T extends { id: string; content: string }>(group: readonly T[]): {
  lead: T
  texts: Map<string, RuleTexts>
  caps: LiabilityCap[]
} {
  const all = group.map(c => c.content).join('\n')
  const caps = liabilityCaps(all)
  const lead = group.find(c => liabilityCaps(c.content).length > 0) ?? group[0]
  const texts = new Map<string, RuleTexts>()
  for (const c of group) {
    texts.set(c.id, c === lead ? { own: c.content, all, caps } : { own: c.content, all: null, caps: null })
  }
  return { lead, texts, caps }
}
