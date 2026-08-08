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
  { id: 'l5-redline-reach',   tier: 't1', needs: [],
    what: 'the redline tools the agent is told about are the ones it can reach' },
  { id: 'l6-dead-controls',   tier: 't1', needs: [],
    what: 'the five dead controls fixed in wave C stay wired' },
  { id: 'l8-chip-truth',      tier: 't1', needs: [],
    what: 'every action chip the prompt suggests maps to a real tool' },
  { id: 'l13-dead-names',     tier: 't1', needs: [],
    what: 'no layer references a tool that does not exist' },

  // ── t2 — needs the stack, but no model call ─────────────────────────────
  { id: 'l2-redline-propose', tier: 't2', needs: ['db', 'api'],
    what: 'redline_propose returns three usable variants' },
  { id: 'l4-draft-tenancy',   tier: 't2', needs: ['db', 'api'],
    what: 'drafting cannot write into another org — the cross-tenant write' },
  { id: 'l6b-dead-controls',  tier: 't2', needs: ['db', 'api'],
    what: 'the nine remaining dead controls do what their labels say' },
  { id: 'l7-prompt-truth',    tier: 't2', needs: ['db', 'api'],
    what: 'the system prompt describes the product that exists' },
  { id: 'l3-error-surface',   tier: 't2', needs: ['db', 'api', 'web'],
    what: 'a failed turn reaches the user instead of a blank bubble (SSE stubbed)' },

  // ── t3 — real model calls, nightly only ─────────────────────────────────
  { id: 'e2-model-observability', tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'the done frame reports what actually answered, and a pin is forwarded' },
  { id: 'l1-thread-poisoning', tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'a write proposal does not kill the thread that made it' },
  { id: 'l4-draft-gate',       tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'a VIEWER cannot create contracts by asking' },
  { id: 'l9-new-verbs',        tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'user_search / template_list / approval_decide, and no approval forgery' },
  { id: 'l10-streaming',       tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'tokens arrive as generated, and the proxy does not corrupt them' },
  { id: 'l11-cost-cap',        tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'the daily cost cap fails closed and BYOK is not bypassed' },
  { id: 'l12-memory-budget',   tier: 't3', needs: ['db', 'api', 'agents', 'model'],
    what: 'session memory is bounded and listings survive into the next turn' },
  { id: 'l6b-ui-verify',       tier: 't3', needs: ['db', 'api', 'web', 'agents', 'model', 'playwright'],
    what: 'the nine UI fixes, driven through a real browser' },
]

/** Directory each check id lives in, relative to the repo root. */
export const CHECK_DIR = 'scripts/agent-loops'
