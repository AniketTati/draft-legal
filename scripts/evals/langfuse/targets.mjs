/**
 * Targets — how a dataset case is actually executed against the product.
 *
 * One target per LLM surface, so a single corpus can span the whole span the
 * product uses a model for: document extraction at one end, conversational
 * chat at the other. Adding a surface means adding a function here and a case
 * file; the runner and the scorers do not change.
 *
 * Every target returns the same shape:
 *   { output, sessionId, meta }
 *     output    — what gets scored, and what lands in the trace's output
 *     sessionId — the correlation key used to find the trace the PRODUCT made.
 *                 null when the surface has no session concept, in which case
 *                 the runner falls back to a harness trace (see lf.createTrace).
 *     meta      — anything worth keeping on the run item (latency, tools, model)
 *
 * ADR-01 (docs/37) says test at the seam the user experiences. `chat` honours
 * that literally — it goes through the Node API with a real login, so RBAC,
 * the cost cap and the proxy are all in the path. The extraction targets call
 * the agents service directly because that IS their seam: Node forwards to
 * them, and nothing about the forwarding is what an extraction eval is asking
 * about.
 */
// MUST be first: reconciles API_BASE / PERSONA_API before the two libraries
// below capture them. See env-bridge.mjs — an inline assignment here does not
// work, because ES imports are hoisted above it.
import './env-bridge.mjs'

import { AGENTS, INTERNAL_SECRET, ADMIN } from '../../week-zero/lib/harness.mjs'
import { askAgent, login } from '../../persona-tests/lib.mjs'

/** POST to the agents service with the internal-service headers it requires. */
async function agentsPost(path, body, { timeoutMs = 120_000 } = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${AGENTS}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Both are required: main.py gates on the secret, and some routes read
        // the service name. A missing secret is a 401 that reads like the
        // endpoint is broken.
        'x-internal-secret': INTERNAL_SECRET,
        'x-internal-service': 'evals',
        // Correlates the trace the agents service produces with this case —
        // see apps/agents/app/tracing.py. Harmless when unset/unsupported.
        ...(body.__sessionId ? { 'x-eval-session-id': body.__sessionId } : {}),
      },
      body: JSON.stringify({ ...body, __sessionId: undefined }),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    if (!res.ok) throw new Error(`agents ${path} → ${res.status}: ${String(text).slice(0, 300)}`)
    return parsed
  } finally {
    clearTimeout(t)
  }
}

/**
 * A cached login. Every chat case would otherwise re-authenticate, which is
 * both slow and a good way to trip a rate limit halfway through a corpus and
 * misreport the rest as model failures.
 */
let _token = null
async function token() {
  if (_token) return _token
  // login() returns the whole body — { accessToken, user } — not a string.
  // Passing the object through produced `Bearer [object Object]` and a 401 on
  // every chat case, which read as an auth/seed problem rather than a caller
  // bug. Every other consumer in scripts/persona-tests destructures it; this
  // one did not.
  const res = await login(ADMIN.email, ADMIN.password)
  _token = typeof res === 'string' ? res : res?.accessToken
  if (!_token) {
    throw new Error(`login for ${ADMIN.email} returned no accessToken — is the API up and seeded? (pnpm db:seed)`)
  }
  return _token
}

export const TARGETS = {
  /**
   * No services, no model, no keys. Echoes a deterministic answer derived from
   * the input so the harness itself can be verified — dataset push, run
   * linking, scoring and the aggregate all exercised end to end without
   * spending a cent or booting the stack. A green stub run proves the plumbing
   * and nothing about the product; that distinction is the whole point of
   * keeping it a separate target rather than a flag.
   */
  async stub(item) {
    const expected = item.expectedOutput ?? {}
    const forced = item.metadata?.stubOutput
    return {
      output: forced ?? expected,
      sessionId: null,
      meta: { target: 'stub', deterministic: true },
    }
  },

  /** Document type detection — POST /classify on the agents service. */
  async classify(item, ctx) {
    const started = Date.now()
    const body = await agentsPost('/classify', {
      plainText: item.input.plainText,
      orgId: ctx.orgId ?? null,
      __sessionId: ctx.sessionId,
    })
    return {
      output: body,
      sessionId: ctx.sessionId,
      meta: { target: 'classify', latencyMs: Date.now() - started },
    }
  },

  /** Obligation extraction — POST /extract_obligations on the agents service. */
  async obligations(item, ctx) {
    const started = Date.now()
    const body = await agentsPost('/extract_obligations', {
      plainText: item.input.plainText,
      contractType: item.input.contractType ?? 'general commercial',
      effectiveDate: item.input.effectiveDate ?? null,
      orgId: ctx.orgId ?? null,
      __sessionId: ctx.sessionId,
    })
    return {
      output: body,
      sessionId: ctx.sessionId,
      meta: { target: 'obligations', latencyMs: Date.now() - started },
    }
  },

  /**
   * Conversational chat, through the public API exactly as the web app calls
   * it. sessionId is the thread id, which apps/agents passes to Langfuse as
   * session_id — so this target correlates to the product's own trace with no
   * extra plumbing.
   */
  async chat(item, ctx) {
    const t = await token()
    const res = await askAgent({
      token: t,
      sessionId: ctx.sessionId,
      message: item.input.message,
      agentMode: item.input.agentMode ?? true,
      contractId: item.input.contractId ?? null,
      provider: item.input.provider ?? null,
      modelId: item.input.modelId ?? null,
    })
    if (res.error) throw new Error(`chat turn failed: ${res.error}`)
    return {
      output: { answer: res.assistantText, tools: res.tools },
      sessionId: ctx.sessionId,
      meta: { target: 'chat', latencyMs: res.latencyMs, tools: res.tools },
    }
  },
}

export function getTarget(name) {
  const fn = TARGETS[name]
  if (!fn) throw new Error(`unknown target "${name}" — known: ${Object.keys(TARGETS).join(', ')}`)
  return fn
}
