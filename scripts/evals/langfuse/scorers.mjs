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

import fs from 'node:fs'

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

// ─── Guardrails ──────────────────────────────────────────────────────────────
//
// Deterministic safety checks that run on EVERY trace, not a sample. They cost
// nothing per call, so sampling them would only mean missing violations for no
// saving. This is the class of failure no rubric looks for: a judge grades
// whether an answer is good, not whether it quietly leaked a credential.
//
// ── What we deliberately DO NOT flag ────────────────────────────────────────
//
// Emails, phone numbers, postal addresses and personal names. This is a
// CONTRACT product: the documents are full of them, and surfacing them is the
// entire job. A PII guardrail that fires on every counterparty email would be
// noise on nearly every trace, and a guardrail that cries wolf gets switched
// off within a week — at which point it protects nothing.
//
// What is flagged is what can NEVER legitimately appear in an answer: machine
// credentials, and payment instruments. Those are unambiguous.

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{20,}/g,                 'OpenAI-style secret key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g,             'Anthropic key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g,               'Google API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g,            'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/g,                    'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,          'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key block'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT'],
]

/** Luhn — the checksum every real card number satisfies and almost no other long number does. */
function luhnValid(digits) {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

/**
 * Card-shaped AND Luhn-valid AND written in card-like groups.
 *
 * All three, because a contract is full of long numbers — values, reference
 * numbers, registration numbers. Length alone false-positives constantly; Luhn
 * alone still catches roughly 1 in 10 random 16-digit strings. Requiring the
 * grouped formatting people actually write card numbers in cuts the rest.
 */
function findCardNumbers(text) {
  const hits = []
  const re = /\b(?:\d[ -]?){12,18}\d\b/g
  for (const m of text.match(re) ?? []) {
    const digits = m.replace(/[^0-9]/g, '')
    if (digits.length < 13 || digits.length > 19) continue
    if (!luhnValid(digits)) continue
    if (!/[ -]/.test(m)) continue          // grouped formatting only
    hits.push(m.trim())
  }
  return hits
}

/** Phrases that mean the assistant declined or could not help. */
const REFUSAL_PATTERNS = [
  /\bI (?:can(?:'|’)?t|cannot|am unable to|'m unable to) (?:help|assist|do|provide|answer)/i,
  /\bI(?:'|’)?m (?:sorry|afraid)[, ].{0,40}(?:can(?:'|’)?t|cannot|unable)/i,
  /\bI do(?:n(?:'|’)?t| not) have (?:access|the ability|enough information)/i,
  /\bI(?:'|’)?m not able to\b/i,
]

export const GUARDRAILS = {
  /** Any machine credential in the output. Never legitimate. */
  secret_leak(text) {
    const found = []
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) found.push(label)
      re.lastIndex = 0
    }
    return {
      name: 'guard:secret_leak', value: found.length ? 0 : 1, dataType: 'BOOLEAN',
      // The LABEL, never the secret itself — a leak detector that copies the
      // leak into a second system has doubled the problem.
      comment: found.length ? `LEAKED: ${[...new Set(found)].join(', ')}` : 'no credentials in output',
    }
  },

  /** Payment instruments. Also never legitimate in an answer. */
  payment_data(text) {
    const cards = findCardNumbers(text)
    const iban = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/.test(text)
    const bad = cards.length > 0 || iban
    return {
      name: 'guard:payment_data', value: bad ? 0 : 1, dataType: 'BOOLEAN',
      comment: bad
        ? `payment data in output: ${cards.length ? `${cards.length} card-like number(s)` : ''}${cards.length && iban ? ' + ' : ''}${iban ? 'IBAN' : ''}`
        : 'no payment instruments',
    }
  },

  /**
   * The answer is parseable JSON with the keys the caller expects.
   * Extractors return JSON; nothing currently notices when one returns prose,
   * a fenced block, or an object missing half its fields.
   */
  schema_valid(text, requiredKeys = []) {
    let obj = null
    const raw = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    try { obj = JSON.parse(raw) } catch { /* not JSON */ }
    if (obj === null || typeof obj !== 'object') {
      return { name: 'guard:schema_valid', value: 0, dataType: 'BOOLEAN', comment: 'output is not parseable JSON' }
    }
    const missing = requiredKeys.filter((k) => !(k in obj))
    return {
      name: 'guard:schema_valid', value: missing.length ? 0 : 1, dataType: 'BOOLEAN',
      comment: missing.length ? `missing key(s): ${missing.join(', ')}` : 'valid JSON with expected keys',
    }
  },

  /**
   * Did the assistant decline? A METRIC, not a failure — refusing to invent a
   * contract it cannot find is correct behaviour. What matters is the RATE:
   * a spike means retrieval broke or a prompt changed, and the answers went
   * from useful to apologetic without anything erroring.
   */
  refusal(text) {
    const refused = REFUSAL_PATTERNS.some((re) => re.test(text))
    return {
      name: 'guard:refusal', value: refused ? 1 : 0, dataType: 'BOOLEAN',
      comment: refused ? 'assistant declined or said it could not help' : 'answered',
    }
  },

  /** Nothing came back. Distinct from a refusal, which is at least an answer. */
  empty(text) {
    const blank = !String(text ?? '').trim()
    return {
      name: 'guard:empty', value: blank ? 0 : 1, dataType: 'BOOLEAN',
      comment: blank ? 'empty response — the user saw nothing' : 'non-empty',
    }
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
/**
 * ── What the rest of the field calls these ──────────────────────────────────
 *
 * Our names are chosen to be plain English, which is right for the people
 * reading a dashboard. But a new engineer googling "retrieval sufficiency"
 * finds nothing, and every vendor doc and paper uses different words. The
 * mapping, so both audiences are served:
 *
 *   groundedness           = faithfulness (RAGAS) · groundedness (Azure, Vertex)
 *   retrieval_sufficiency  = context recall / context relevance (RAGAS)
 *   tool_selection         = tool-call accuracy · agent trajectory evaluation
 *   correctness            = answer correctness / semantic similarity
 *   citation               = attribution / source-grounding
 *   session_coherence      = multi-turn coherence / conversational consistency
 *
 * The score NAMES are deliberately not renamed to match: they are already
 * attached to recorded scores, and renaming would orphan that history and
 * break every trend line. Documenting the mapping costs nothing and breaks
 * nothing.
 */
export const RUBRICS = {
  // ── NUMERIC (0.0–1.0) — graded qualities ──────────────────────────────────
  //
  // Boolean threw away most of the signal. "Mostly right with one unsupported
  // date" and "entirely fabricated" both scored 0, so a dashboard could not
  // distinguish a drafting nit from a serious hallucination, and a small
  // regression was invisible until it crossed the pass/fail line.
  //
  // Every numeric rubric carries ANCHORS. Asking a model for "a score out of 1"
  // without them produces a number that drifts between runs and between models
  // — the anchors are what make 0.7 mean the same thing tomorrow.
  groundedness: {
    dataType: 'NUMERIC',
    criterion:
      'Is every factual claim in the ANSWER supported by the SOURCE material or the conversation input? ' +
      'Fluent invention is the failure this catches.',
    anchors: [
      '1.0 — every claim traceable to the source, OR a correct "I could not find that"',
      '0.7 — substantively grounded; one peripheral detail unsupported (a rounded figure, an inferred label)',
      '0.3 — a CENTRAL claim is unsupported, even though parts of the answer are sourced',
      '0.0 — invented: contract terms, parties, dates or figures that appear nowhere in the source',
    ],
  },
  helpfulness: {
    dataType: 'NUMERIC',
    criterion: 'Would a busy contracts lawyer consider this a useful reply to their request?',
    anchors: [
      '1.0 — answers the actual question, directly, at the right length',
      '0.7 — answers it, but buries the point or omits an obvious follow-through',
      '0.3 — partially responsive; answers a narrower question than the one asked',
      '0.0 — a non-answer, or refuses something the product can actually do',
    ],
  },
  correctness: {
    dataType: 'NUMERIC',
    criterion:
      'Does the ANSWER convey the same substance as the EXPECTED answer? ' +
      'Wording, ordering and extra detail do not matter.',
    anchors: [
      '1.0 — same substance',
      '0.7 — central point right, a secondary point missing or muddled',
      '0.3 — touches the topic but misses the central point',
      '0.0 — contradicts the expected answer, or answers a different question',
    ],
  },
  citation: {
    dataType: 'NUMERIC',
    criterion: 'Does the ANSWER point at the clause, section or document it relies on, where the source makes that possible?',
    anchors: [
      '1.0 — specific and checkable ("clause 9.4 of the Helio MSA")',
      '0.7 — names the document but not the clause',
      '0.3 — gestures at a source ("your standard terms") without identifying it',
      '0.0 — asserts contract content with no pointer at all',
    ],
  },
  retrieval_sufficiency: {
    dataType: 'NUMERIC',
    criterion:
      'Does the TOOL OUTPUT contain the information needed to answer the USER REQUEST? ' +
      'You are grading the LOOKUP, not the reading — score high if the data is present even when a later answer misreads it.',
    anchors: [
      '1.0 — everything needed is present',
      '0.7 — enough to answer, but the answer would need caveats',
      '0.3 — related data that does not actually answer the question',
      '0.0 — an error, nothing useful, or data scoped to the wrong thing',
    ],
  },
  session_coherence: {
    dataType: 'NUMERIC',
    criterion:
      'Read the whole conversation. Did the assistant carry context across turns — remember what it was told, ' +
      'stay consistent with its own earlier answers, and keep track of which contract was being discussed?',
    anchors: [
      '1.0 — held the thread throughout',
      '0.7 — one small slip that did not derail the conversation',
      '0.3 — repeatedly re-asked for information it already had, or lost the subject',
      '0.0 — contradicted itself, or forgot the contract under discussion entirely',
    ],
  },
  session_goal_progress: {
    dataType: 'NUMERIC',
    criterion:
      'Did the conversation move TOWARD what the user was trying to achieve? ' +
      'Judge the direction of travel, not the politeness of individual turns. ' +
      'Correctly establishing that a goal CANNOT be met, and saying so, is progress.',
    anchors: [
      '1.0 — reached the goal, or established clearly that it could not be reached',
      '0.7 — made real progress but stopped short',
      '0.3 — circled without advancing',
      '0.0 — pursued the wrong interpretation and never corrected, or ended further away than it started',
    ],
  },

  // ── BOOLEAN — genuinely binary ────────────────────────────────────────────
  // A partial credit here would be meaningless: either the right tool was
  // called or a different one was.
  tool_selection: {
    dataType: 'BOOLEAN',
    criterion:
      'Given the USER REQUEST, was calling this particular tool the right move? ' +
      'Judge the CHOICE only, not the quality of what came back. ' +
      'Score 0 if a different tool was clearly right, or if no tool was needed.',
  },

  // ── Trajectory: the one thing a per-call score cannot see ────────────────
  //
  // `tool_selection` grades each call in isolation, so an agent that calls
  // contract_search four times with the same query scores 1.0 four times — every
  // individual call was a defensible choice. The failure only exists in the
  // SEQUENCE. Multi-step agents fail this way constantly: looping, re-fetching
  // what they already have, or answering after the first result when the
  // question needed two lookups. Judged once per turn, over the whole tool list.
  trajectory: {
    dataType: 'NUMERIC',
    criterion:
      'Look at the ORDERED list of tool calls for this turn as a plan. Did it get ' +
      'to what the USER REQUEST needed, without wasted or repeated steps? ' +
      'Judge the path, not the final wording of the answer.',
    anchors: [
      '1.0 — every call earned its place, in a sensible order, and together they cover the request',
      '0.7 — reaches the answer but with one redundant or out-of-order call',
      '0.3 — repeats a call it already had the result of, or stops one lookup short of the request',
      '0.0 — loops on the same call, or the sequence never gathers what was asked for',
    ],
  },

  // ── CATEGORICAL — a taxonomy, not a grade ─────────────────────────────────
  //
  // "Quality is down 8 points" tells you to worry. "Nine of the twelve failures
  // are misread_data" tells you what to fix. A number cannot carry that, no
  // matter how fine-grained the scale — this is a different KIND of question,
  // which is why it is a different score type rather than another rubric.
  failure_mode: {
    dataType: 'CATEGORICAL',
    categories: [
      'fine',            // nothing wrong
      'hallucinated',    // stated something with no source at all
      'misread_data',    // the source was right; the reading of it was wrong
      'wrong_tool',      // looked in the wrong place
      'incomplete',      // true as far as it goes, but stops short
      'refused_wrongly', // declined something it could actually do
      'malformed',       // right content, unusable shape
    ],
    criterion:
      'Classify the PRIMARY problem with this answer, if any. Pick exactly one label. ' +
      'Choose "fine" when nothing is wrong. ' +
      'The distinction that matters most: "hallucinated" means the source did not contain it, ' +
      'while "misread_data" means the source DID contain it and the answer got it wrong — ' +
      'those two have completely different fixes.',
  },
}

/** Just the criterion text, for callers that only want the wording. */
export const RUBRIC_TEXT = Object.fromEntries(
  Object.entries(RUBRICS).map(([k, v]) => [k, v.criterion]),
)

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

/**
 * The output contract varies by score type. One shared "give me a score" prompt
 * cannot serve three: a numeric rubric needs a range, a categorical one needs
 * its label set, a boolean needs neither.
 */
function judgeSystem(dataType) {
  const shape = dataType === 'NUMERIC'
    ? '"score":<a number between 0.0 and 1.0>'
    : dataType === 'CATEGORICAL'
      ? '"score":"<exactly one of the allowed labels>"'
      : '"score":<0 or 1>'
  return 'You are grading the output of a contract-lifecycle assistant. ' +
    'Reason briefly first, then give a verdict. ' +
    `Return ONLY minified JSON: {"reasoning":"<one or two sentences>",${shape}}. ` +
    'Do not wrap it in markdown fences.'
}

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

/**
 * Human-corrected cases, injected into the rubric as worked examples.
 *
 * This is the ONLY way a judge gets "updated". There is no training, no
 * gradient, no fine-tune — an LLM judge does not learn from labels. The prompt
 * is the only lever, and a concrete "you scored this wrong, here is the right
 * answer and why" moves it far more reliably than another sentence of rule,
 * because the failure is usually an ambiguous rule rather than a missing one.
 *
 * Generated by `pnpm evals annotate -- --emit-examples` from traces where a
 * human labelled a case and the judge disagreed. Loaded once per process.
 */
let _examples
function calibrationExamples(criterion) {
  if (_examples === undefined) {
    try {
      const raw = fs.readFileSync(new URL('./calibration/examples.json', import.meta.url), 'utf8')
      _examples = JSON.parse(raw).examples ?? []
    } catch { _examples = [] }
  }
  const mine = _examples.filter((e) => e.criterion === criterion)
  if (!mine.length) return ''
  const blocks = mine.slice(0, 8).map((e, i) => [
    `--- CORRECTED EXAMPLE ${i + 1} ---`,
    `INPUT: ${String(e.input ?? '').slice(0, 900)}`,
    `ANSWER: ${String(e.output ?? '').slice(0, 900)}`,
    `CORRECT SCORE: ${e.correct}`,
    `WHY: ${String(e.why ?? '').slice(0, 400)}`,
  ].join('\n'))
  return [
    '',
    'The following cases were previously scored INCORRECTLY and then corrected by',
    'a human reviewer. Match their reasoning; they define the boundary this',
    'criterion actually cares about.',
    '',
    ...blocks,
    '',
  ].join('\n')
}

export function judgePrompt(criterion, { input, output, expectedOutput }) {
  const src = clip(input, SOURCE_BUDGET)
  const ans = clip(output, ANSWER_BUDGET)
  const spec = RUBRICS[criterion]
  // Anchors are what stop a numeric score drifting. Without them "0.7" means
  // whatever the model felt like today and the trend line is noise.
  const scaleBlock = spec?.dataType === 'NUMERIC' && spec.anchors
    ? ['', 'SCALE — use these anchors, interpolate between them:', ...spec.anchors.map((a) => `  ${a}`)].join('\n')
    : spec?.dataType === 'CATEGORICAL' && spec.categories
      ? `\nALLOWED LABELS (pick exactly one): ${spec.categories.join(' | ')}`
      : null
  return [
    `CRITERION (${criterion}): ${spec?.criterion ?? criterion}`,
    scaleBlock,
    calibrationExamples(criterion) || null,
    '',
    src.truncated
      ? 'NOTE: the SOURCE below was truncated for length. Do NOT treat a detail\'s absence from it as invention — if a claim is merely unverifiable here, do not penalise it.'
      : '',
    `INPUT / SOURCE:\n${src.text}`,
    expectedOutput ? `\nEXPECTED:\n${clip(expectedOutput, 3000).text}` : '',
    `\nANSWER TO GRADE:\n${ans.text}`,
  ].filter(Boolean).join('\n')
}

async function callJudge(cfg, prompt, dataType = 'BOOLEAN') {
  const JUDGE_SYSTEM = judgeSystem(dataType)
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

/**
 * Parse a verdict per score type. A parse failure THROWS rather than returning
 * 0 — "the grader broke" and "the answer was bad" must never look the same.
 */
function parseVerdict(text, criterion) {
  const spec = RUBRICS[criterion]
  const type = spec?.dataType ?? 'BOOLEAN'
  const raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`)
  const v = JSON.parse(match[0])
  const reasoning = String(v.reasoning ?? '').slice(0, 500)

  if (type === 'CATEGORICAL') {
    const label = String(v.score ?? '').trim().toLowerCase()
    // An unknown label is a broken grader, not a bad answer. Silently mapping
    // it to a valid one would invent data and hide the real problem.
    if (!spec.categories.includes(label)) {
      throw new Error(`judge returned label "${label}", not one of: ${spec.categories.join(', ')}`)
    }
    return { score: label, reasoning }
  }

  const n = Number(v.score)
  if (!Number.isFinite(n)) throw new Error(`judge returned no numeric score: ${raw.slice(0, 200)}`)
  if (type === 'NUMERIC') {
    // Clamp rather than reject: a model that answers 1.2 meant "the top of the
    // scale", and throwing away an otherwise-good judgement over that is worse
    // than recording the intent.
    return { score: Math.max(0, Math.min(1, n)), reasoning }
  }
  return { score: n >= 0.5 ? 1 : 0, reasoning }
}

export function judgeAvailable() {
  return judgeConfig() !== null
}

async function judge(criterion, ctx) {
  const cfg = judgeConfig()
  if (!cfg) return null   // caller reports this as a skip, never as a pass
  const type = RUBRICS[criterion]?.dataType ?? 'BOOLEAN'
  const text = await callJudge(cfg, judgePrompt(criterion, ctx), type)
  const { score, reasoning } = parseVerdict(text, criterion)
  return {
    name: `judge:${criterion}`,
    value: score,
    dataType: type,
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
