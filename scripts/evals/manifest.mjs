/**
 * The eval suite's inventory — ADR-01, docs/37.
 *
 * One place that says what every check is, what it needs to run, and which tier
 * it belongs to. Tiers are defined by COST AND DETERMINISM, not by subject:
 *
 *   t1  static analysis only. No services, no database, no model. $0, ~seconds.
 *       Blocking on every PR, including PRs from forks (which cannot see repo
 *       secrets — see docs/37 E9).
 *   t2  needs Postgres/Redis/the API, but makes NO model call. Deterministic.
 *       Blocking on every PR once CI stands up the services (ci.yml already
 *       runs pgvector + redis for test-api).
 *   t3  makes real model calls. Costs money, varies run to run. NIGHTLY on
 *       main, never blocking a PR.
 *
 * `needs` is not documentation — run.mjs checks each precondition before
 * running a check and SKIPS loudly if unmet. A skipped check is never counted
 * as a pass; that is the difference between this and the step it replaces
 * (`pytest tests/ ... || true`, which reported success for a directory that did
 * not exist).
 *
 * Classification was done by reading each file's imports and call sites, not by
 * grepping: a naive probe for `login()`/`API}` misfiles the Playwright check as
 * static and l7-prompt-truth as stack-dependent. If you add a check, add it
 * here — run.mjs fails on any check file that is not listed.
 */

export const TIERS = ['t1', 't2', 't3']

export const CHECKS = [
  // ── t1 — static analysis, free, no services ─────────────────────────────
  { id: 'e1-gate-bites',      tier: 't1', needs: [],
    what: 'the eval gate itself can fail — four ways, watched' },
  { id: 'l6-dead-controls',   tier: 't1', needs: [],
    what: 'the five dead controls fixed in wave C stay wired' },
  { id: 'l8-chip-truth',      tier: 't1', needs: [],
    what: 'every action chip the prompt suggests maps to a real tool' },
  { id: 'l13-dead-names',     tier: 't1', needs: [],
    what: 'no layer references a tool that does not exist' },
  { id: 'l14-agents-url',     tier: 't1', needs: [],
    what: 'the API dials the port the agents service binds, and no call site reads an env var nothing sets' },

  // ── t2 — needs the stack, but no model call ─────────────────────────────
  { id: 'l4-draft-tenancy',   tier: 't2', needs: ['db', 'api'],
    what: 'drafting cannot write into another org — the cross-tenant write' },
  { id: 'l6b-dead-controls',  tier: 't2', needs: ['db', 'api'],
    what: 'the nine remaining dead controls do what their labels say' },
  { id: 'l7-prompt-truth',    tier: 't2', needs: ['db', 'api'],
    what: 'the system prompt describes the product that exists' },
  // Reclassified from t1 2026-08-08: it shells out to apps/agents/.venv/bin/python,
  // which no clean checkout has. Caught by running the suite from a git-archive
  // copy at a different path — the same thing CI does, and the thing a local run
  // can never tell you.
  { id: 'l5-redline-reach',   tier: 't2', needs: ['venv'],
    what: 'the redline tools the agent is told about are the ones it can reach' },
  { id: 'e8-eval-identity',   tier: 't2', needs: ['db', 'api'],
    what: 'a tier-3 run cannot spend a customer\'s BYOK budget or be halted by the cap' },
  { id: 'e12-replay',         tier: 't2', needs: ['db', 'api', 'replay'],
    what: 'a recorded turn replays deterministically with no model and no key' },
  // (l11-cost-cap was promoted to t2 here on 2026-08-16 and REVERTED the same
  // day — see the t3 block below for why. Kept as a marker so the next person
  // who notices "8 of its 9 assertions are static" does not repeat it.)
  // `playwright` added 2026-08-16: it drives a real browser at :84, but only
  // declared db/api/web. On a machine with the npm package and no chromium
  // binary it CRASHED — exit 1, no summary line — instead of skipping loudly.
  { id: 'l3-error-surface',   tier: 't2', needs: ['db', 'api', 'web', 'playwright'],
    what: 'a failed turn reaches the user instead of a blank bubble (SSE stubbed)' },

  // ── t3 — real model calls, nightly only ─────────────────────────────────
  { id: 'e2-model-observability', tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'the done frame reports what actually answered, and a pin is forwarded' },
  // Reclassified from t2 2026-08-08: it never calls /agent/chat, so a scan of
  // its call sites said "no model" — but redline_propose reaches one INDIRECTLY
  // through the tool it exercises. Running it under replay produced a 502 from
  // the upstream tool, not a meaningful failure. Indirect model dependencies are
  // the classification trap here; the tier gate is what surfaced it.
  { id: 'l2-redline-propose',  tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'redline_propose returns three usable variants' },
  // `venv` added 2026-08-16. readSession() at l1-thread-poisoning.mjs:80 calls
  // execFileSync on apps/agents/.venv/bin/python with NO try/catch, so on a
  // checkout without a built venv it throws ENOENT and the check dies with no
  // summary line — reported as an error rather than a skip. Same defect that
  // got l5-redline-reach reclassified (see its note above) and that
  // l3-error-surface had with playwright. The other venv-shelling checks
  // (l2, l10, l12) guard theirs, so they keep their non-venv coverage and are
  // deliberately left alone.
  { id: 'l1-thread-poisoning', tier: 't3', needs: ['db', 'api', 'agents', 'model', 'venv'],
    what: 'a write proposal does not kill the thread that made it' },
  { id: 'l4-draft-gate',       tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'a VIEWER cannot create contracts by asking' },
  { id: 'l9-new-verbs',        tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'user_search / template_list / approval_decide, and no approval forgery' },
  { id: 'l10-streaming',       tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'tokens arrive as generated, and the proxy does not corrupt them' },
  // Stays t3, and the reasoning is worth keeping because the promotion to t2
  // LOOKED proven and was not.
  //
  // 8 of its 9 assertions really are static analysis of router.py and
  // agent.worker.ts, and it makes no agents-service call. It was promoted on
  // the strength of running 9/9 with the agents service stopped and no valid
  // model key. That evidence was wrong twice:
  //
  //   1. Section 3 (`over-cap resolve is refused with 429`, :116) only reaches
  //      the cap when the API holds a PLATFORM key: aiRouter.ts:191 calls
  //      assertCostCapNotExceeded inside `if (platKey)`, so with no key the
  //      loop falls through to NoProviderAvailable → 503, and the assertion
  //      fails. It passed locally only because aiRouter.ts:85's
  //      PLACEHOLDER_VALUES filters exact sentinels ('', 'REPLACE', 'unset'),
  //      so a junk 10-char key still counted as present. t2 is DEFINED as
  //      keyless (README.md), so this cannot live there.
  //   2. Its cap-cache invalidation (:98-103) shells out to
  //      `docker exec clm_redis` — the compose container_name. A GitHub
  //      Actions services: container is not named that, the DEL silently
  //      no-ops into `catch {}`, and the check races costCap.ts's 30s TTL.
  //      t2 is defined by determinism; that is not deterministic in CI.
  //
  // Splitting the static 8 into their own t1 check is the real win here, and
  // is a task rather than a manifest edit.
  { id: 'l11-cost-cap',        tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'the daily cost cap fails closed and BYOK is not bypassed' },
  { id: 'l12-memory-budget',   tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'session memory is bounded and listings survive into the next turn' },
  { id: 'l6b-ui-verify',       tier: 't3', needs: ['db', 'api', 'web', 'agents', 'model', 'playwright'],
    what: 'the nine UI fixes, driven through a real browser' },
]

/**
 * Suites that live outside scripts/agent-loops and run as a whole rather than
 * as one check. The persona conversations are the existing behavioural corpus
 * -- 66 multi-turn cases against an 800-contract seeded fixture -- and belong
 * to tier 3: they make real model calls and are graded loosely on purpose.
 *
 * They are listed here so `--tier t3` runs them and the baseline can see them.
 * ADR-01 called for absorbing these rather than rewriting them; the runner
 * treats a suite exactly like a check because both report the same summary line.
 */
export const SUITES = [
  { id: 'persona-conversations', tier: 't3', dir: 'scripts/persona-tests', entry: 'run.mjs',
    needs: ['db', 'api', 'agents', 'model', 'personas'],
    what: '66 multi-turn persona conversations against the seeded corpus' },
  { id: 'persona-sanity', tier: 't3', dir: 'scripts/persona-tests', entry: 'sanity.mjs',
    needs: ['db', 'api', 'agents', 'model', 'personas'],
    what: '18 single-turn sanity checks' },
  // Added 2026-08-16. This existed and was listed NOWHERE: 86 asks across the
  // five files in personas/, driven by run-personas.mjs through lib-multi.mjs
  // — the only consumer of the multi-turn grader. docs/37 counted it ("~86
  // more asks across five persona files") and the manifest never picked it up,
  // so the largest multi-turn corpus in the repo was outside the gate
  // entirely. Its summary line did not parse either; both are fixed together,
  // because listing a suite the runner cannot read only converts silence into
  // a permanent ERRO.
  { id: 'persona-journeys', tier: 't3', dir: 'scripts/persona-tests', entry: 'run-personas.mjs',
    needs: ['db', 'api', 'agents', 'model', 'personas'],
    what: '86 multi-turn persona journeys — the only suite exercising lib-multi' },
]

/** Directory each check id lives in, relative to the repo root. */
export const CHECK_DIR = 'scripts/agent-loops'
