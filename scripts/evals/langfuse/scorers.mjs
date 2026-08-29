/**
 * Scorers — deterministic checks and an LLM judge.
 *
 * A case names its scorers as strings ("field_match:contractType"), so the
 * corpus stays declarative data and the harness stays code. Each scorer
 * returns { name, value, dataType, comment }, which maps 1:1 onto a Langfuse
 * score.
 *
 * Order of preference, and it matters: use a deterministic scorer whenever the
 * question has a right answer. A judge is for the questions that genuinely do
 * not — "is this answer grounded in the contract", "is this redline
 * reasonable". Reaching for a judge on a question `field_match` could have
 * answered buys you nondeterminism, latency and a model bill in exchange for
 * nothing. Every judged score here is one a string comparison cannot express.
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Read a dotted path out of an object; returns undefined rather than throwing. */
function at(obj, path) {
  if (!path) return obj
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

const norm = (v) => String(v ?? '').trim().toLowerCase()

/** Langfuse renders BOOLEAN as 0/1; keep pass/fail scores numeric and binary. */
const bool = (name, ok, comment) => ({ name, value: ok ? 1 : 0, dataType: 'BOOLEAN', comment })

// ─── deterministic scorers ───────────────────────────────────────────────────

const DETERMINISTIC = {
  /** field_match:<path> — output[path] equals expectedOutput[path], case-insensitive. */
  field_match(arg, { output, expectedOutput }) {
    const got = at(output, arg)
    const want = at(expectedOutput, arg)
    const ok = norm(got) === norm(want)
    return bool(`field_match:${arg}`, ok, ok ? `matched "${want}"` : `expected "${want}", got "${got}"`)
  },

  /** contains:<path> — output[path] contains the expected string, case-insensitive. */
  contains(arg, { output, expectedOutput }) {
    const got = norm(at(output, arg))
    const want = norm(at(expectedOutput, arg))
    const ok = Boolean(want) && got.includes(want)
    return bool(`contains:${arg}`, ok, ok ? `found "${want}"` : `"${want}" not found in "${got.slice(0, 120)}"`)
  },

  /** not_empty:<path> — the field exists and is a non-empty string/array. */
  not_empty(arg, { output }) {
    const got = at(output, arg)
    const ok = Array.isArray(got) ? got.length > 0 : Boolean(norm(got))
    return bool(`not_empty:${arg}`, ok, ok ? 'present' : `"${arg}" was empty or missing`)
  },

  /**
   * json_subset — every leaf in expectedOutput appears, equal, in output.
   * A subset rather than deep equality on purpose: extraction responses carry
   * confidence scores, ids and reasons that no golden file should have to
   * predict, and asserting on them makes the corpus fail on harmless additions.
   */
  json_subset(_arg, { output, expectedOutput }) {
    const misses = []
    const walk = (want, got, path) => {
      if (want && typeof want === 'object' && !Array.isArray(want)) {
        for (const [k, v] of Object.entries(want)) walk(v, got?.[k], path ? `${path}.${k}` : k)
      } else if (Array.isArray(want)) {
        if (!Array.isArray(got) || got.length < want.length) misses.push(`${path}: expected ≥${want.length} items, got ${got?.length ?? 0}`)
      } else if (norm(want) !== norm(got)) {
        misses.push(`${path}: expected "${want}", got "${got}"`)
      }
    }
    walk(expectedOutput ?? {}, output ?? {}, '')
    return bool('json_subset', misses.length === 0, misses.length ? misses.slice(0, 5).join('; ') : 'all expected fields matched')
  },

  /** tool_used:<name> — the chat turn actually called this tool. */
  tool_used(arg, { output }) {
    const tools = (output?.tools ?? []).map((t) => (typeof t === 'string' ? t : t?.name ?? ''))
    const ok = tools.map(norm).includes(norm(arg))
    return bool(`tool_used:${arg}`, ok, ok ? `called ${arg}` : `expected ${arg}; called [${tools.join(', ') || 'none'}]`)
  },

  /**
   * no_tool — the turn answered without calling anything. The inverse matters:
   * an agent that reaches for a tool on "hello" is burning latency and budget,
   * and that regression is invisible unless something asserts on it.
   */
  no_tool(_arg, { output }) {
    const tools = output?.tools ?? []
    return bool('no_tool', tools.length === 0, tools.length ? `called ${tools.length} tool(s)` : 'answered directly')
  },

  /**
   * latency_ms — a metric, not a verdict. Recorded as NUMERIC so it trends in
   * the dashboard; nothing fails on it, because a slow correct answer and a
   * fast wrong one are different problems and folding them into one number
   * hides both.
   */
  latency_ms(_arg, { meta }) {
    const ms = meta?.latencyMs
    if (ms == null) return null
    return { name: 'latency_ms', value: Number(ms), dataType: 'NUMERIC', comment: `${ms} ms` }
  },
}

// ─── LLM-as-a-judge ──────────────────────────────────────────────────────────

/**
 * Rubrics. Each asks for ONE property, with explicit fail conditions.
 *
 * The single most common way a judge goes wrong is a vague rubric ("is this a
 * good answer?"), which produces a number that drifts with the model and
 * correlates with nothing. Each of these names what a 0 looks like.
 */
export const RUBRICS = {
  groundedness:
    'Is every factual claim in the ANSWER supported by the SOURCE material or the conversation input? ' +
    'Score 0 if the answer states a contract term, party, date, or figure that does not appear in the source. ' +
    'An answer that correctly says it does not know scores 1. Fluent invention is the failure this catches.',
  correctness:
    'Does the ANSWER convey the same substance as the EXPECTED answer? ' +
    'Wording, ordering and extra detail do not matter. Score 0 if it contradicts the expected answer, ' +
    'omits its central point, or answers a different question.',
  helpfulness:
    'Would a busy contracts lawyer consider this a useful reply to their request? ' +
    'Score 0 for a non-answer, a refusal to do something the product can do, or a wall of text that buries the point. ' +
    'Being brief is not a fault.',
  citation:
    'Does the ANSWER cite the specific clause, section or document it relies on, where the source makes that possible? ' +
    'Score 0 for an assertion about contract content with no pointer to where it came from.',
}

/**
 * Judge providers, in the same precedence order as apps/agents/app/config.py so
 * a machine that can run the product can run the judge.
 *
 * The judge SHOULD be a different model from the one under test — a model
 * grading its own output scores it generously (self-preference bias), which
 * quietly inflates every number in the suite. Pin it explicitly with
 * EVAL_JUDGE_MODEL when the system under test is on the same family.
 */
/**
 * A key must be long enough to be real. Truthiness is not enough: Secret
 * Manager and .env templates seed placeholders like `REPLACE` and `unset`,
 * which are truthy, capture judge selection, and then 401 every case — which
 * reads exactly like the model failing rather than the key being fake. Same
 * `usableKey` guard scripts/evals/run.mjs applies to the model probe, and the
 * same placeholder set apps/agents/app/config.py filters.
 */
const PLACEHOLDERS = new Set(['', 'placeholder', 'REPLACE', 'TODO', 'unset', 'changeme'])
const usableKey = (v) => typeof v === 'string' && v.trim().length >= 20 && !PLACEHOLDERS.has(v.trim())

function judgeConfig() {
  const model = process.env.EVAL_JUDGE_MODEL
  const a = process.env.ANTHROPIC_API_KEY
  const o = process.env.OPENAI_API_KEY
  const g = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY
  if (usableKey(a)) return { provider: 'anthropic', model: model ?? 'claude-sonnet-4-6', key: a }
  if (usableKey(o)) return { provider: 'openai',    model: model ?? 'gpt-4.1',           key: o }
  if (usableKey(g)) return { provider: 'google',    model: model ?? 'gemini-2.5-pro',    key: g }
  return null
}

const JUDGE_SYSTEM =
  'You are grading the output of a contract-lifecycle assistant. ' +
  'Reason briefly first, then give a verdict. ' +
  'Return ONLY minified JSON: {"reasoning":"<one or two sentences>","score":<0 or 1>}. ' +
  'Do not wrap it in markdown fences.'

/**
 * Evidence budget. Deliberately large, and truncation is DECLARED.
 *
 * This cost us a full scoring pass. At a 6k cap, a grounded answer over a
 * 20-item tool result was judged a hallucination four separate times — the
 * judge saw the first six rows, did not see the rows the answer actually cited,
 * and reported invention with complete confidence. Every one of those verdicts
 * was wrong, and they read exactly like a real product defect.
 *
 * So: a big budget, and when it is still exceeded, SAY SO in the prompt. A
 * judge that knows the source was cut cannot treat "absent from the source" as
 * "invented", which is the single inference groundedness turns on.
 */
const SOURCE_BUDGET = 24000
const ANSWER_BUDGET = 8000

function clip(text, budget) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  if (!s || s.length <= budget) return { text: s ?? '', truncated: false }
  return { text: s.slice(0, budget), truncated: true }
}

function judgePrompt(criterion, { input, output, expectedOutput }) {
  const src = clip(input, SOURCE_BUDGET)
  const ans = clip(output, ANSWER_BUDGET)
  return [
    `CRITERION (${criterion}): ${RUBRICS[criterion] ?? criterion}`,
    '',
    src.truncated
      ? 'NOTE: the SOURCE below was truncated for length. Do NOT treat a detail\'s absence from it as invention — if a claim is merely unverifiable here, score 1 and say so.'
      : '',
    `INPUT / SOURCE:\n${src.text}`,
    expectedOutput ? `\nEXPECTED:\n${clip(expectedOutput, 3000).text}` : '',
    `\nANSWER TO GRADE:\n${ans.text}`,
  ].filter(Boolean).join('\n')
}

async function callJudge(cfg, prompt) {
  const timeout = AbortSignal.timeout(60_000)
  if (cfg.provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 512, system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: timeout,
    })
    if (!r.ok) throw new Error(`judge(anthropic) ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const b = await r.json()
    return b.content?.map((c) => c.text ?? '').join('') ?? ''
  }
  if (cfg.provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model, temperature: 0,
        messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }],
      }),
      signal: timeout,
    })
    if (!r.ok) throw new Error(`judge(openai) ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const b = await r.json()
    return b.choices?.[0]?.message?.content ?? ''
  }
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JUDGE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          // Gemini 2.5 is a THINKING model and its thinking tokens count
          // against maxOutputTokens. At 512 it spent 509 on hidden reasoning
          // and returned empty `parts` with finishReason MAX_TOKENS — every
          // judgement failed as "judge returned no JSON" with nothing to
          // diagnose. Thinking cannot be switched off either ("this model only
          // works in thinking mode"), so the fix is headroom: budget for the
          // reasoning AND the answer, not just the answer.
          maxOutputTokens: 3072,
        },
      }),
      signal: timeout,
    },
  )
  if (!r.ok) throw new Error(`judge(google) ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const b = await r.json()
  const cand = b.candidates?.[0]
  const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) {
    // Say WHY it was empty. "no JSON" with a blank body is undiagnosable, and
    // the two real causes — token exhaustion and a safety block — need
    // opposite fixes.
    throw new Error(`judge(google) returned no text (finishReason=${cand?.finishReason}, thoughtTokens=${b.usageMetadata?.thoughtsTokenCount ?? 0})`)
  }
  return text
}

/** Judges tolerate a fenced or chatty response; a parse failure must not read as a 0. */
function parseVerdict(text) {
  const raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`)
  const v = JSON.parse(match[0])
  const score = Number(v.score)
  if (!Number.isFinite(score)) throw new Error(`judge returned no numeric score: ${raw.slice(0, 200)}`)
  return { score: score >= 0.5 ? 1 : 0, reasoning: String(v.reasoning ?? '').slice(0, 500) }
}

export function judgeAvailable() {
  return judgeConfig() !== null
}

async function judge(criterion, ctx) {
  const cfg = judgeConfig()
  if (!cfg) return null   // caller reports this as a skip, never as a pass
  const text = await callJudge(cfg, judgePrompt(criterion, ctx))
  const { score, reasoning } = parseVerdict(text)
  return {
    name: `judge:${criterion}`,
    value: score,
    dataType: 'BOOLEAN',
    comment: `[${cfg.provider}/${cfg.model}] ${reasoning}`,
  }
}

// ─── dispatch ────────────────────────────────────────────────────────────────

/**
 * Run one scorer spec against a result.
 *
 * Returns null when the scorer could not run (no judge key, missing latency).
 * The runner counts that as a SKIP. A scorer that could not run must never
 * report 0 — a red suite and an unrunnable suite need different reactions, and
 * collapsing them is how a corpus quietly stops testing anything.
 */
export async function runScorer(spec, ctx) {
  const [kind, ...rest] = String(spec).split(':')
  const arg = rest.join(':')
  if (kind === 'judge') return judge(arg, ctx)
  const fn = DETERMINISTIC[kind]
  if (!fn) throw new Error(`unknown scorer "${spec}" — known: ${[...Object.keys(DETERMINISTIC), 'judge:<criterion>'].join(', ')}`)
  return fn(arg, ctx)
}

export const SCORER_NAMES = [...Object.keys(DETERMINISTIC), ...Object.keys(RUBRICS).map((r) => `judge:${r}`)]
