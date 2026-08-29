#!/usr/bin/env node
/**
 * E14 — the multi-turn grader tells the truth about HOW a turn passed.
 *
 * `lib-multi.mjs` grades 152 asks and its most permissive path is one regex.
 * `gracefulEmptyOk` defaults to true and NO case in the corpus sets it false,
 * so any reply reading like "I couldn't find that" suppresses mustMentionAny,
 * contextWords and minReplyChars. Separately, 53 of the 91 mustMentionAny
 * lists carry a phrase that only matches when the agent declined — 'no
 * carrier', 'not specified' — so on those rows a refusal satisfies the rubric
 * outright, without the regex being involved at all.
 *
 * Both behaviours are DEFENSIBLE: an honest empty answer is the correct answer
 * on a lot of these rows, and penalising it would push the agent toward
 * confident guessing, which is the worse failure in a contract product. What
 * was not defensible is that neither was visible. An agent that declined every
 * question scored well and the summary line said "passed", with nothing
 * anywhere reporting how much of the green was shrugs.
 *
 * So the grader now reports `shrugPass` per turn, and this check is what keeps
 * that honest. It drives scoreMultiTurn directly with synthetic replies — no
 * model, no stack, no key — which is the only way to watch a grader fail
 * without buying a model call to do it.
 *
 * Run BEFORE (2026-08-17): scoreMultiTurn did not exist; the rubric was inline
 *             in runConversation and reachable only through a live model call.
 * Run AFTER:  every bypass the rubric takes is named in `suppressed`, and a
 *             turn that went green without being examined is `shrugPass`.
 */
import { check, report, section } from '../week-zero/lib/harness.mjs'
import {
  scoreMultiTurn, GRACEFUL_EMPTY, NULL_ANSWER_PHRASE, WRITE_TOOLS,
} from '../persona-tests/lib-multi.mjs'

/** Build the shape askAgent returns, so these cases stay honest about the
 *  input the real grader gets rather than a convenient subset of it. */
const reply = (assistantText, { tools = [], latencyMs = 1000, error } = {}) => ({
  assistantText, latencyMs, error,
  tools: tools.map(name => ({ name, args: {}, result: null, ok: true })),
  allEvents: [],
})

const score = (turn, response, opts = {}) => scoreMultiTurn({
  turn, response,
  index: opts.index ?? 0,
  turnTools: new Set((response.tools ?? []).map(t => t.name)),
  cumulativeTools: opts.cumulativeTools ?? new Set((response.tools ?? []).map(t => t.name)),
})

// A rubric in the shape the corpus actually uses: the null-answer phrases at
// the end are copied from beacon-001, not invented for this test.
const SEARCH_TURN = {
  ask: 'Show all carrier agreements that include a fuel surcharge cap clause.',
  expect: {
    expectedTools: ['contract_search', 'clause_search'],
    mustMentionAny: ['carrier', 'fuel', 'surcharge', 'no carrier', 'no clause'],
    maxLatencyMs: 90_000,
  },
}

// ─── 1. A real answer passes, and is not slandered as a shrug ───────────────

section('1. A genuine answer passes clean')
{
  const v = score(SEARCH_TURN, reply(
    'Three carrier agreements include a fuel surcharge cap: Maersk (capped at 12%), '
    + 'MSC (capped at 15%), and CMA CGM (capped at 10%).',
    { tools: ['contract_search'] },
  ))
  check('a substantive answer passes', v.ok, v.fails.join('; '))
  check('…and is NOT counted as a shrug', v.shrugPass === false,
    'if a real answer trips the shrug detector the metric is worthless')
  check('…and suppressed nothing', v.suppressed.length === 0, JSON.stringify(v.suppressed))
  check('…and did not read as graceful-empty', v.gracefulEmpty === false,
    'GRACEFUL_EMPTY matching a real answer would suppress checks on rows that had a real answer to check')
}

// ─── 2. The bypass is recorded rather than silent ───────────────────────────

section('2. A "could not find" reply still passes — and says so')
{
  const v = score(SEARCH_TURN, reply(
    "I couldn't find any agreements matching that in your contracts.",
    { tools: ['contract_search'] },
  ))
  check('a refusal still passes (the bypass is intact)', v.ok, v.fails.join('; '))
  check('…and is flagged as a shrug pass', v.shrugPass === true,
    'this is the whole point: green, but the rubric checked nothing it was written to check')
  check('…and names the check the bypass ate', v.suppressed.some(s => s.startsWith('mustMentionAny')),
    `suppressed was ${JSON.stringify(v.suppressed)}`)
  check('…and records that it read as graceful-empty', v.gracefulEmpty === true)
}

section('3. A refusal that satisfies the rubric outright is caught too')
{
  // The case that motivates keying shrugPass on the REPLY rather than on
  // which checks got skipped. Rubrics list the noun AND its refusal
  // ('carrier' and 'no carrier'), so a decline matches the bare noun as well:
  // mustMentionAny passes, NOTHING is suppressed, and the turn is still a
  // refusal. An implementation keyed on `suppressed` scores this as a normal
  // pass — and this is how 53 rows of the corpus are written.
  const v = score(SEARCH_TURN, reply(
    'There is no carrier arrangement on file that I can report on.',
    { tools: ['contract_search'] },
  ))
  check('it passes', v.ok, v.fails.join('; '))
  check('…having suppressed nothing (mustMentionAny matched "carrier")',
    v.suppressed.length === 0, JSON.stringify(v.suppressed))
  check('…and is STILL counted as a shrug pass', v.shrugPass === true,
    'keying on suppression alone would miss every row whose rubric lists the noun and its refusal')
}

section('3b. The rubric\'s own escape-hatch phrase, without a refusal reading')
{
  // 'not specified' is a mustMentionAny phrase that only a non-answer matches,
  // and this reply is too terse to trip GRACEFUL_EMPTY. nullAnswerOnly is the
  // arm that catches it.
  const turn = { ask: 'x', expect: { mustMentionAny: ['volume', 'commit', 'not specified'] } }
  const v = score(turn, reply('That is not specified.'))
  check('it passes', v.ok, v.fails.join('; '))
  check('…did not read as graceful-empty', v.gracefulEmpty === false,
    'if this trips GRACEFUL_EMPTY the nullAnswerOnly arm is never exercised and this case proves nothing')
  check('…is flagged nullAnswerOnly', v.nullAnswerOnly === true)
  check('…and counts as a shrug pass', v.shrugPass === true)
}

section('4. Every suppressible check reports its own suppression')
{
  const turn = {
    ask: 'For Maersk specifically, what is the volume commitment?',
    expect: {
      mustMentionAny: ['volume', 'commit'],
      contextWords: ['ocean', 'carrier'],
      minReplyChars: 400,
    },
  }
  // index 1 so contextWords is live — it is skipped on the first turn.
  const v = score(turn, reply("I couldn't locate that contract."), { index: 1 })
  check('the turn passes', v.ok, v.fails.join('; '))
  check('contextWords suppression is recorded',
    v.suppressed.some(s => s.startsWith('contextWords')), JSON.stringify(v.suppressed))
  check('minReplyChars suppression is recorded',
    v.suppressed.some(s => s.startsWith('minReplyChars')), JSON.stringify(v.suppressed))
  check('all three suppressions are listed, not just the first',
    v.suppressed.length === 3, `got ${v.suppressed.length}: ${JSON.stringify(v.suppressed)}`)
}

// ─── 5. The opt-out still works ─────────────────────────────────────────────

section('5. gracefulEmptyOk:false turns the bypass off')
{
  const turn = {
    ask: SEARCH_TURN.ask,
    expect: { ...SEARCH_TURN.expect, mustMentionAny: ['carrier', 'fuel'], gracefulEmptyOk: false },
  }
  const v = score(turn, reply("I couldn't find any matching contracts.", { tools: ['contract_search'] }))
  check('a refusal FAILS when the row opted out', v.ok === false,
    'no corpus row sets this today; if the flag does not bite, tightening a row would be a no-op')
  check('…and is not counted as a shrug (a shrug must have passed)', v.shrugPass === false)
}

// ─── 6. The negation graders bite ───────────────────────────────────────────

section('6. forbiddenTools is scoped to this turn')
{
  const turn = { ask: 'x', expect: { forbiddenTools: ['contract_create_from_template'] } }

  const violated = score(turn, reply('Done.', { tools: ['contract_create_from_template'] }))
  check('a forbidden tool called THIS turn fails', violated.ok === false, violated.fails.join('; '))

  // Same forbidden tool, called on an EARLIER turn only. Must not fail now,
  // or a legitimate turn-1 write would poison every later turn.
  const earlier = score(turn, reply('Here it is.', { tools: ['contract_search'] }),
    { cumulativeTools: new Set(['contract_create_from_template', 'contract_search']) })
  check('…but a forbidden tool from an EARLIER turn does not', earlier.ok === true,
    earlier.fails.join('; '))
}

section('7. expectedTools honours the cumulative flag')
{
  const cumulative = { ask: 'x', expect: { expectedTools: ['contract_search'] } }
  const thisTurnOnly = { ask: 'x', expect: { expectedTools: ['contract_search'], cumulativeTools: false } }
  const noToolsNow = reply('Following up on those.', { tools: [] })
  const pool = new Set(['contract_search'])

  check('cumulative (default): a tool from an earlier turn satisfies it',
    score(cumulative, noToolsNow, { cumulativeTools: pool }).ok === true)
  check('cumulativeTools:false: it does not',
    score(thisTurnOnly, noToolsNow, { cumulativeTools: pool }).ok === false)
}

// ─── 8. The two patterns behave as documented ───────────────────────────────

section('8. The detectors themselves')
{
  check('GRACEFUL_EMPTY matches a refusal',
    GRACEFUL_EMPTY.test("I couldn't find any matching contracts."))
  check('GRACEFUL_EMPTY does not match a substantive answer',
    !GRACEFUL_EMPTY.test('The liability cap is $5,000,000 under section 9.2.'),
    'a false positive here silently disables the rubric on a row that had a real answer')

  for (const phrase of ['no carrier', 'not specified', 'none', 'unable to determine']) {
    check(`NULL_ANSWER_PHRASE matches ${JSON.stringify(phrase)}`, NULL_ANSWER_PHRASE.test(phrase))
  }
  for (const phrase of ['carrier', 'fuel', 'surcharge', 'notice period', 'nonexclusive']) {
    check(`NULL_ANSWER_PHRASE does not match ${JSON.stringify(phrase)}`, !NULL_ANSWER_PHRASE.test(phrase),
      'over-matching here would brand real answers as shrugs — note "notice"/"nonexclusive" start with "no"')
  }
}

// ─── 9. A failing turn is never a shrug ─────────────────────────────────────

section('9. shrugPass requires an actual pass')
{
  const turn = { ask: 'x', expect: { expectedTools: ['clause_search'], mustMentionAny: ['fuel'] } }
  const v = score(turn, reply("I couldn't find any matching clauses.", { tools: [] }))
  check('a turn that failed its tool check does not pass', v.ok === false, v.fails.join('; '))
  check('…and is not counted as a shrug pass', v.shrugPass === false,
    'shrug counts must be a subset of passes or the two numbers cannot be read together')
  check('…while still recording what the bypass suppressed', v.suppressed.length > 0,
    'suppression is a property of the reply, not of the verdict')
}

// ─── 10. notHallucinated fires on a claimed write, not on silence ───────────

section('10. A claimed write with no write tool is a fabrication')
{
  const turn = {
    ask: 'Draft a mutual NDA for Plaid.',
    expect: {
      expectedTools: ['contract_create_from_template', 'contract_search'],
      notHallucinated: ['i have created', "i've created", 'has been created'],
    },
  }

  // THE CASE THAT WAS INERT. Every corpus row using notHallucinated lists
  // SEARCH_TOOLS in expectedTools, so this exact shape — search, find nothing,
  // then claim the draft exists — passed. `thisTurn.size === 0` was never true.
  const lied = score(turn, reply(
    "I've created the NDA for Plaid and saved it to your drafts.",
    { tools: ['contract_search'] },
  ))
  check('claiming a write after only a READ tool fails', lied.ok === false,
    'this is the product\'s only fabrication test, and a single read call used to disarm it')
  check('…and the failure names the missing write', lied.fails.some(f => /no write tool/.test(f)),
    JSON.stringify(lied.fails))

  const wrote = score(turn, reply(
    "I've created the NDA for Plaid.",
    { tools: ['contract_create_from_template'] },
  ))
  check('claiming a write after a real write passes', wrote.ok === true, wrote.fails.join('; '))

  const silent = score(turn, reply(
    'Three NDA templates are available; which would you like?',
    { tools: ['contract_search'] },
  ))
  check('not claiming a write is fine with no write tool', silent.ok === true, silent.fails.join('; '))

  // The set must be the apply-RPC one. The confirm-gate set and the prompt's
  // prose list both EXCLUDE contract_create_from_template, which is the tool
  // all five corpus rows are about — scoping to either makes them unsatisfiable.
  check('contract_create_from_template counts as a write',
    WRITE_TOOLS.has('contract_create_from_template'),
    'the confirm-gate set omits it; using that set would make every notHallucinated row impossible to pass')
  for (const t of ['contract_search', 'clause_search', 'portfolio_search', 'counterparty_get']) {
    check(`${t} does not count as a write`, !WRITE_TOOLS.has(t))
  }
}

// ─── 11. Latency is reported, never mixed into correctness ──────────────────

section('11. A slow turn is slow, not wrong')
{
  const turn = {
    ask: 'Show all carrier agreements.',
    expect: { expectedTools: ['contract_search'], mustMentionAny: ['carrier'], maxLatencyMs: 60_000 },
  }
  const slow = score(turn, reply(
    'Three carrier agreements include a fuel surcharge cap: Maersk, MSC and CMA CGM.',
    { tools: ['contract_search'], latencyMs: 95_000 },
  ))

  // Latency used to land in the same `fails` array as "text missing". A slow CI
  // runner therefore failed rows in CORRELATED BURSTS, which invalidates any
  // interval over the corpus — and would have recorded infrastructure variance
  // as model variance in the noise floor, inflating it permanently.
  check('a correct but slow answer still passes on correctness', slow.ok === true,
    slow.fails.join('; ') || 'ok')
  check('…and no latency string leaks into fails',
    !slow.fails.some(f => /latency/i.test(f)), JSON.stringify(slow.fails))
  check('…while the breach IS reported', slow.overBudget === true,
    'separating them must not mean losing the signal')
  check('…with the numbers to act on',
    slow.latencyMs === 95_000 && slow.latencyBudgetMs === 60_000)

  const fast = score(turn, reply(
    'Three carrier agreements include a fuel surcharge cap: Maersk, MSC and CMA CGM.',
    { tools: ['contract_search'], latencyMs: 1_200 },
  ))
  check('a fast turn is not flagged', fast.overBudget === false)

  const noBudget = score(
    { ask: 'x', expect: { mustMentionAny: ['carrier'] } },
    reply('carrier', { latencyMs: 999_999 }),
  )
  check('a row with no budget is never over it', noBudget.overBudget === false,
    'absence of a budget must not read as a breach')
}

report('E14 grader truth')
