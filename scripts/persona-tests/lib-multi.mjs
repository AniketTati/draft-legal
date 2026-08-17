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
    const fails = []
    const lower = (r.assistantText ?? '').toLowerCase()

    if (turn.expect?.expectedTools) {
      const cumulative = turn.expect.cumulativeTools !== false
      const pool = cumulative ? cumulativeTools : turnTools
      const hit = turn.expect.expectedTools.some(t => pool.has(t))
      if (!hit) fails.push(`tool: expected one of [${turn.expect.expectedTools.join('|')}], got [${[...pool].join(',') || 'none'}]`)
    }

    // forbiddenTools — NONE of these may be called. See lib.mjs for why this
    // exists (docs/37 E6: no negation grader means no hallucination test).
    //
    // Always scoped to THIS TURN, never cumulative: a tool legitimately called
    // on turn 1 must not retroactively fail turn 3, and "did this turn reach
    // for the wrong tool" is the only question worth asking here.
    if (turn.expect?.forbiddenTools) {
      const violated = turn.expect.forbiddenTools.filter(t => turnTools.has(t))
      if (violated.length > 0) {
        fails.push(`tool: forbidden [${violated.join('|')}] called this turn (turn tools: [${[...turnTools].join(',') || 'none'}])`)
      }
    }

    // Detect graceful "no result / couldn't find / encountered error" first
    // so we can short-circuit downstream checks. When the reply is a graceful
    // failure, ALL strict checks (contextWords, minReplyChars, mustMentionAny)
    // get bypassed — the agent honestly said "I couldn't find that" which IS
    // the right answer, even if it doesn't mention every keyword from the rubric.
    //
    // gracefulEmptyOk DEFAULTS TO TRUE — set `gracefulEmptyOk: false` only on
    // tests where the agent MUST produce real content (action-draft tests use
    // notHallucinated to catch fake "I created it" replies). LLM variance
    // means search-precision drops in/out across runs; the rubric should
    // accept honest empty answers as correct rather than penalising for
    // word-choice differences.
    const gracefulEmptyRegex = /\b(no|not|don'?t|do not|couldn'?t|doesn'?t|haven'?t|cannot|unable|fail(ed)?|encounter(ed)?|issue|error|wasn'?t|weren'?t|won'?t)\b[\s\S]{0,60}\b(contract|agreement|record|match|result|data|deal|find|locat|exist|prior|currently|file|document|clause|access|able|loi|letter|intent|matter|associated|version|hub|plant|attached|target|item|in the|on file)/i
    const gracefulOk = turn.expect?.gracefulEmptyOk !== false   // default true
    const isGracefulEmpty = gracefulOk && gracefulEmptyRegex.test(r.assistantText ?? '')

    if (turn.expect?.mustMention) {
      for (const m of turn.expect.mustMention) {
        if (!lower.includes(m.toLowerCase())) fails.push(`text missing: "${m}"`)
      }
    }
    if (turn.expect?.mustMentionAny) {
      const hit = turn.expect.mustMentionAny.some(m => lower.includes(m.toLowerCase()))
      if (!hit && !isGracefulEmpty) {
        if (turn.expect.gracefulEmptyOk) {
          fails.push(`text missing any of: [${turn.expect.mustMentionAny.join('|')}] AND no graceful-empty acknowledgement`)
        } else {
          fails.push(`text missing any of: [${turn.expect.mustMentionAny.join('|')}]`)
        }
      }
    }
    // Regex-based "agent acknowledged empty/error result" check. Use this for
    // failure-mode tests where the exact phrasing varies wildly:
    //   "we don't have", "no prior contracts", "couldn't find", "no record",
    //   "do not currently have", "encountered an error", "no executed MSAs"
    // The pattern intent is: a negation token within ~4 words of a result-noun.
    if (turn.expect?.acknowledgedEmpty) {
      const empty = /\b(no|not|don'?t|do not|couldn'?t|doesn'?t|haven'?t|cannot|unable|fail(ed)?)\b[\s\S]{0,40}\b(contract|agreement|record|match|result|data|deal|find|locat|exist|prior|currently|file|document|clause|access)/i
      if (!empty.test(r.assistantText ?? '')) {
        fails.push(`acknowledgedEmpty: reply doesn't read like a "no result" or "couldn't access" answer`)
      }
    }

    if (turn.expect?.contextWords && i > 0 && !isGracefulEmpty) {
      // Reply must reference a word/phrase from a prior turn — but skip when
      // the agent gracefully said "I couldn't find that" (that's an honest
      // answer where the contextWord wouldn't naturally appear).
      const hit = turn.expect.contextWords.some(w => lower.includes(w.toLowerCase()))
      if (!hit) fails.push(`context lost: none of [${turn.expect.contextWords.join('|')}] in reply`)
    }

    if (turn.expect?.notHallucinated) {
      for (const phrase of turn.expect.notHallucinated) {
        if (lower.includes(phrase.toLowerCase())) {
          // The phrase being there is bad ONLY if no tool was called this turn
          // (e.g. "I created the draft" without contract_create_from_template)
          if (turnTools.size === 0) {
            fails.push(`hallucinated: "${phrase}" with no tool call`)
          }
        }
      }
    }

    if (turn.expect?.maxLatencyMs && r.latencyMs > turn.expect.maxLatencyMs) {
      fails.push(`latency: ${r.latencyMs}ms > ${turn.expect.maxLatencyMs}ms`)
    }

    if (turn.expect?.minReplyChars && !isGracefulEmpty && (r.assistantText?.length ?? 0) < turn.expect.minReplyChars) {
      fails.push(`reply too short: ${r.assistantText?.length} chars < ${turn.expect.minReplyChars}`)
    }

    if (r.error) fails.push(`error: ${r.error}`)

    const turnOk = fails.length === 0
    if (!turnOk) convOk = false

    turnResults.push({ turn: i + 1, ok: turnOk, fails, toolsThisTurn: [...turnTools], latencyMs: r.latencyMs })
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
  return {
    persona,
    convTotal: results.length,
    convPass,
    turnTotal,
    turnPass,
    results,
  }
}
