/**
 * lib-multi.mjs — multi-turn conversation runner.
 *
 * Each conversation is a list of turns sent on the SAME sessionId so the
 * agent's memory is exercised. Per-turn rubric checks:
 *   • mustMentionAny: at least one of the listed strings appears in reply
 *   • mustMention:    EVERY listed string appears in reply
 *   • expectedTools:  one of the named tools was called this turn (OR
 *                      since stream start if `cumulativeTools` is true)
 *   • contextWords:   reply references a phrase established in earlier turns
 *                     (proves multi-turn context retention)
 *   • maxLatencyMs:   reply lands within budget
 *   • minTurnTokens:  reply is at least N tokens (catches "..." stub replies)
 *   • notHallucinated: reply does NOT include any of the listed strings
 *                     (e.g. "I created" without a tool call = bad)
 *
 * Conversation pass = ALL turns pass. One failed turn fails the whole
 * conversation but later turns still run (their failure is informative).
 */
import { login, askAgent } from './lib.mjs'

export const PASSWORD = 'password123'

// ── Degenerate-answer detection ─────────────────────────────────────────────
//
// Both patterns describe the SAME agent behaviour — declining to answer — and
// both are load-bearing in the rubric below. They are named and exported so a
// grader test can drive them directly, and so the next person can see that the
// suite's most permissive path is one regex.

/** Reply reads as an honest "I couldn't find / couldn't reach that": a
 *  negation token within ~60 chars of a result-noun. */
export const GRACEFUL_EMPTY =
  /\b(no|not|don'?t|do not|couldn'?t|doesn'?t|haven'?t|cannot|unable|fail(ed)?|encounter(ed)?|issue|error|wasn'?t|weren'?t|won'?t)\b[\s\S]{0,60}\b(contract|agreement|record|match|result|data|deal|find|locat|exist|prior|currently|file|document|clause|access|able|loi|letter|intent|matter|associated|version|hub|plant|attached|target|item|in the|on file)/i

/** Tighter form, for rows that assert the agent acknowledged an empty result. */
export const ACKNOWLEDGED_EMPTY =
  /\b(no|not|don'?t|do not|couldn'?t|doesn'?t|haven'?t|cannot|unable|fail(ed)?)\b[\s\S]{0,40}\b(contract|agreement|record|match|result|data|deal|find|locat|exist|prior|currently|file|document|clause|access)/i

/** A `mustMentionAny` phrase that only matches when the agent DECLINED.
 *  53 of the 91 mustMentionAny lists in the corpus carry one — 'no carrier',
 *  'not specified', 'none' — so on those rows a refusal satisfies the rubric
 *  directly, without going near GRACEFUL_EMPTY at all.
 *
 *  Every alternative is \b-anchored on purpose. Without it `none` matches the
 *  prefix of 'nonexclusive' and `no` matches 'notice period', which would
 *  brand ordinary contract vocabulary as a refusal and inflate the shrug
 *  count with real answers. Caught by e14 section 8. */
export const NULL_ANSWER_PHRASE = /^(no\b|not\b|none\b|n\/a\b|couldn|cannot\b|unable\b|without\b)/i

/**
 * The tools that MUTATE something, mirrored from the WRITE_TOOLS map in
 * apps/api/src/routes/agent-threads.ts — the only programmatic classification
 * in the repo, and the one the apply-RPC permission gate uses.
 *
 * NOT the confirm-gate set (a tool is confirm-gated iff it returns
 * awaitingConfirmation) and NOT the prompt's prose list. Both of those exclude
 * `contract_create_from_template`, which is the very tool every
 * `notHallucinated` row in the corpus is about — scoping to either would make
 * the check unsatisfiable on all five.
 *
 * `l13-dead-names` is the pattern for keeping mirrors honest; if this drifts,
 * e14 section 10 is where it shows up.
 */
export const WRITE_TOOLS = new Set([
  'comment_add',
  'request_create',
  'contract_update',
  'approval_route',
  'contract_create_from_template',
  'redline_apply',
  'approval_decide',
])

export const TAXONOMY = {
  SINGLE:        'single-shot retrieval',
  NARROW:        'multi-turn narrowing',
  DRILL:         'multi-turn drill-in',
  AGGREGATE:     'cross-entity aggregation',
  ACTION_DRAFT:  'action-oriented (draft)',
  ACTION_OTHER:  'action-oriented (compare/etc.)',
  APPROVAL:      'approval-flow',
  LONG_CTX:      'long-context',
  AMBIGUOUS:     'ambiguous / failure',
}

/**
 * Score one turn against its rubric. PURE — everything it needs arrives as
 * arguments, so the grader can be driven with synthetic replies instead of a
 * model call. That is the only way to watch this grader fail, which docs/36's
 * rule requires of anything the suite's numbers rest on.
 *
 * Beyond `ok` / `fails`, it reports how the turn passed:
 *
 *   gracefulEmpty   the reply read as an honest "couldn't find that"
 *   suppressed      checks the graceful-empty bypass ATE — each of these
 *                   WOULD have failed had the reply not looked like a refusal
 *   nullAnswerOnly  mustMentionAny was satisfied ONLY by a phrase meaning
 *                   "no answer" ('not specified'), without the reply reading
 *                   as a refusal — the rubric's own escape hatch
 *   shrugPass       the turn passed AND the reply reads as a decline: green
 *                   without the rubric checking what it was written to check
 *
 * `shrugPass` is REPORTED, never enforced. An honest empty answer genuinely is
 * the right answer on many rows, and flipping those to failures wholesale
 * would be a worse lie in the other direction. What was missing is that
 * nobody could tell how many of the green turns were shrugs — an agent that
 * declined every question scored well and the summary said 'passed'. Now the
 * count is on the scorecard, and tightening individual rows is a decision
 * someone can make with the number in front of them.
 */
export function scoreMultiTurn({ turn, response, index = 0, turnTools, cumulativeTools }) {
  const fails = []
  const suppressed = []
  let nullAnswerOnly = false

  const text = response.assistantText ?? ''
  const lower = text.toLowerCase()
  const thisTurn = turnTools ?? new Set((response.tools ?? []).map(t => t.name))
  const pool = cumulativeTools ?? thisTurn

  if (turn.expect?.expectedTools) {
    const cumulative = turn.expect.cumulativeTools !== false
    const searched = cumulative ? pool : thisTurn
    const hit = turn.expect.expectedTools.some(t => searched.has(t))
    if (!hit) fails.push(`tool: expected one of [${turn.expect.expectedTools.join('|')}], got [${[...searched].join(',') || 'none'}]`)
  }

  // forbiddenTools — NONE of these may be called. See lib.mjs for why this
  // exists (docs/37 E6: no negation grader means no hallucination test).
  //
  // Always scoped to THIS TURN, never cumulative: a tool legitimately called
  // on turn 1 must not retroactively fail turn 3, and "did this turn reach
  // for the wrong tool" is the only question worth asking here.
  if (turn.expect?.forbiddenTools) {
    const violated = turn.expect.forbiddenTools.filter(t => thisTurn.has(t))
    if (violated.length > 0) {
      fails.push(`tool: forbidden [${violated.join('|')}] called this turn (turn tools: [${[...thisTurn].join(',') || 'none'}])`)
    }
  }

  // Detect a graceful "no result / couldn't find / encountered error" reply
  // first: when it fires, the strict text checks below are bypassed, because
  // the agent honestly said "I couldn't find that" and that IS the right
  // answer on many rows even though it mentions none of the rubric's words.
  //
  // gracefulEmptyOk DEFAULTS TO TRUE. Every bypass it takes is now recorded in
  // `suppressed` rather than happening silently — see this function's header.
  const gracefulOk = turn.expect?.gracefulEmptyOk !== false
  const gracefulEmpty = gracefulOk && GRACEFUL_EMPTY.test(text)

  if (turn.expect?.mustMention) {
    for (const m of turn.expect.mustMention) {
      if (!lower.includes(m.toLowerCase())) fails.push(`text missing: "${m}"`)
    }
  }
  if (turn.expect?.mustMentionAny) {
    const matched = turn.expect.mustMentionAny.filter(m => lower.includes(m.toLowerCase()))
    if (matched.length === 0) {
      if (gracefulEmpty) {
        suppressed.push(`mustMentionAny [${turn.expect.mustMentionAny.join('|')}]`)
      } else if (turn.expect.gracefulEmptyOk) {
        fails.push(`text missing any of: [${turn.expect.mustMentionAny.join('|')}] AND no graceful-empty acknowledgement`)
      } else {
        fails.push(`text missing any of: [${turn.expect.mustMentionAny.join('|')}]`)
      }
    } else if (matched.every(m => NULL_ANSWER_PHRASE.test(m))) {
      // Satisfied, but only by the rubric's own escape hatch.
      nullAnswerOnly = true
    }
  }

  if (turn.expect?.acknowledgedEmpty && !ACKNOWLEDGED_EMPTY.test(text)) {
    fails.push(`acknowledgedEmpty: reply doesn't read like a "no result" or "couldn't access" answer`)
  }

  if (turn.expect?.contextWords && index > 0) {
    const hit = turn.expect.contextWords.some(w => lower.includes(w.toLowerCase()))
    if (!hit) {
      if (gracefulEmpty) suppressed.push(`contextWords [${turn.expect.contextWords.join('|')}]`)
      else fails.push(`context lost: none of [${turn.expect.contextWords.join('|')}] in reply`)
    }
  }

  if (turn.expect?.notHallucinated) {
    // Fires when the reply CLAIMS a write happened and no write tool ran.
    //
    // This used to require `thisTurn.size === 0` — ANY tool call disarmed it.
    // Every row using it lists SEARCH_TOOLS in expectedTools, so a turn that
    // ran contract_search, found nothing, then said "I've created the draft"
    // passed. It is the product's only fabrication test and it was inert on
    // all five rows that use it.
    const wroteSomething = [...thisTurn].some(t => WRITE_TOOLS.has(t))
    for (const phrase of turn.expect.notHallucinated) {
      if (lower.includes(phrase.toLowerCase()) && !wroteSomething) {
        fails.push(`hallucinated: "${phrase}" with no write tool (turn tools: [${[...thisTurn].join(',') || 'none'}])`)
      }
    }
  }

  // Latency does NOT go in `fails`.
  //
  // It shared a denominator with correctness, so a slow CI runner or a degraded
  // provider failed rows in CORRELATED BURSTS — which invalidates any binomial
  // interval over the corpus and makes a latency regression indistinguishable
  // from a correctness one. Worst of all it would have polluted the noise-floor
  // measurement, recording infrastructure variance as model variance and
  // producing a permanently inflated floor that hides real regressions.
  //
  // Reported separately, with its own budget, per docs/38's own rule that
  // operational metrics stay out of the quality score.
  const overBudget = Boolean(
    turn.expect?.maxLatencyMs && response.latencyMs > turn.expect.maxLatencyMs,
  )

  if (turn.expect?.minReplyChars && text.length < turn.expect.minReplyChars) {
    if (gracefulEmpty) suppressed.push(`minReplyChars ${turn.expect.minReplyChars}`)
    else fails.push(`reply too short: ${text.length} chars < ${turn.expect.minReplyChars}`)
  }

  if (response.error) fails.push(`error: ${response.error}`)

  const ok = fails.length === 0
  return {
    ok,
    fails,
    latencyMs: response.latencyMs,
    latencyBudgetMs: turn.expect?.maxLatencyMs ?? null,
    overBudget,
    gracefulEmpty,
    suppressed,
    nullAnswerOnly,
    // A pass where the reply reads as the agent declining to answer.
    //
    // Deliberately NOT `suppressed.length > 0`. Rubrics list both the noun and
    // its refusal ('carrier' AND 'no carrier'), so "there is no carrier
    // agreement on file" matches the bare noun too, mustMentionAny is
    // satisfied, nothing is suppressed — and the turn is still a refusal.
    // Keying on the reply rather than on which checks got skipped is what
    // makes those rows countable. `suppressed` stays as the diagnostic for
    // WHICH checks the bypass ate.
    shrugPass: ok && (gracefulEmpty || nullAnswerOnly),
  }
}

/**
 * Run a single conversation. Returns:
 *   { id, persona, ok, results: [{turn, ok, fails:[]}], latencyMsTotal, transcripts: [...] }
 */
export async function runConversation({ token, persona, conversation }) {
  const sessionId = `${conversation.id}-${Date.now()}`
  const turnResults = []
  const transcripts = []
  let totalLatencyMs = 0
  let convOk = true

  // Track cumulative tools (some rubrics check "tool was used at any point")
  const cumulativeTools = new Set()

  // Track text from earlier turns for contextWords checks
  const priorTurnsText = []

  for (let i = 0; i < conversation.turns.length; i++) {
    const turn = conversation.turns[i]
    const r = await askAgent({
      token,
      sessionId,
      message: turn.ask,
      agentMode: true,
      provider: 'openai',
      modelId: 'gpt-4.1-mini',
    })
    transcripts.push({
      turn: i + 1,
      ask: turn.ask,
      assistantText: r.assistantText,
      tools: r.tools.map(t => ({ name: t.name, args: t.args, ok: t.ok ?? true })),
      latencyMs: r.latencyMs,
      error: r.error ?? null,
    })

    const turnTools = new Set(r.tools.map(t => t.name))
    for (const t of turnTools) cumulativeTools.add(t)
    totalLatencyMs += r.latencyMs ?? 0

    // ── Run rubric for this turn ─────────────────────────────────────
    const verdict = scoreMultiTurn({
      turn, response: r, index: i, turnTools, cumulativeTools,
    })
    if (!verdict.ok) convOk = false

    turnResults.push({
      turn: i + 1,
      ok: verdict.ok,
      fails: verdict.fails,
      toolsThisTurn: [...turnTools],
      latencyMs: r.latencyMs,
      // How it passed, not just that it did — see scoreMultiTurn's header.
      gracefulEmpty: verdict.gracefulEmpty,
      suppressed: verdict.suppressed,
      nullAnswerOnly: verdict.nullAnswerOnly,
      shrugPass: verdict.shrugPass,
      // Reported, never folded into ok. See scoreMultiTurn.
      latencyBudgetMs: verdict.latencyBudgetMs,
      overBudget: verdict.overBudget,
    })
    priorTurnsText.push(r.assistantText ?? '')
  }

  return {
    id:             conversation.id,
    title:          conversation.title,
    persona,
    type:           conversation.type,
    user:           conversation.user,
    ok:             convOk,
    turns:          turnResults,
    shrugTurns:     turnResults.filter(t => t.shrugPass).length,
    latencyMsTotal: totalLatencyMs,
    transcripts,
  }
}

/**
 * Run a list of conversations sequentially (so per-conversation sessionIds
 * don't collide). Returns aggregated stats.
 */
export async function runConversations({ token, persona, conversations, onProgress }) {
  const results = []
  for (const conv of conversations) {
    const r = await runConversation({ token, persona, conversation: conv })
    results.push(r)
    onProgress?.(r)
  }
  const turnTotal = results.reduce((s, r) => s + r.turns.length, 0)
  const turnPass  = results.reduce((s, r) => s + r.turns.filter(t => t.ok).length, 0)
  const convPass  = results.filter(r => r.ok).length
  // Of the turns that passed, how many did so without the rubric checking
  // anything — the agent declined and the bypass waved it through.
  const turnShrug = results.reduce((s, r) => s + r.turns.filter(t => t.shrugPass).length, 0)
  // Latency is counted, never subtracted from turnPass — a slow correct answer
  // is slow, not wrong, and mixing them makes both numbers unreadable.
  const turnOverBudget = results.reduce((s, r) => s + r.turns.filter(t => t.overBudget).length, 0)
  return {
    persona,
    convTotal: results.length,
    convPass,
    turnTotal,
    turnPass,
    turnShrug,
    turnOverBudget,
    results,
  }
}
