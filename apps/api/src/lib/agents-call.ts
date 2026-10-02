/**
 * The agents service, called with the org's cost cap, PII policy and usage
 * accounting — moved from workers/agent.worker.ts so a route (the field
 * preview, docs/39 D1) calls it the same way the jobs do.
 */
import { redactJson, restorePii, unresolvedPiiTokens } from './pii-policy.js'
import { assertCostCapNotExceeded, estimateCostUsd, recordUsage } from './costCap.js'
import { modelFetch } from './model-boundary.js'

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8002'

/**
 * Every background call into the agents service (the agents worker's jobs,
 * and the field preview, docs/39 D1).
 *
 * Before this existed, agent.worker.ts had ZERO references to costCap or
 * recordUsage: all nine background job types called the agents service
 * directly with no pre-check and no post-record. So background spend was
 * invisible to the daily cap AND absent from OrgUsageDaily, which means the
 * admin usage panel under-reported by the entire background pipeline -- the
 * one W0-6 fixed to stop reporting $0.00 forever.
 *
 * The cap is checked BEFORE the call, because a cap that only notices after
 * the tokens are spent is a report, not a cap. A breach throws
 * CostCapExceededError, which callers let propagate: BullMQ marks the job
 * failed, which is the honest outcome -- the work did not happen.
 */
export async function callAgents(
  path: string,
  init: RequestInit,
  meta: {
    orgId: string; toolName: string
    /** Round-trip token scope: the contract's id, or the request's. */
    scope: string
    contractId?: string
    /**
     * The text whose personal data is replaced (see redactJson's valuesFrom):
     * the whole document when the body carries parts of it, or the request's
     * own text. The body's other strings (org name, field labels, playbook
     * text) are configuration, which the callbacks couldn't restore.
     */
    context?: string | null
    /**
     * false: the reply reports the run's real token use, which the caller
     * records (docs/39 A15) — no estimate from the request's size.
     */
    estimate?: boolean
  },
): Promise<Response> {
  await assertCostCapNotExceeded(meta.orgId)

  // X23 — contract text leaves our trust zone here, so the org's PII policy
  // applies, as it does on the chat tools (it was skipped for every job).
  // What comes back is stored — a draft, findings, and (through the
  // extraction's callbacks, see contracts.ts) the clause text itself — so the
  // values go out as round-trip tokens and are put back below. Jobs whose body
  // carries only ids (/redline, /approval-summary) are unaffected: the agents
  // service fetches that text itself.
  let sent: unknown
  const source = () => (meta.context != null ? [meta.context] : [sent])
  if (typeof init.body === 'string') {
    sent = JSON.parse(init.body)
    const redacted = await redactJson(meta.orgId, sent, {
      surface: `worker:${meta.toolName}`, contractId: meta.contractId, roundTrip: meta.scope, valuesFrom: source(),
    })
    init = { ...init, body: JSON.stringify(redacted) }
  }

  const res = await modelFetch(`${AGENTS_URL}${path}`, init, { orgId: meta.orgId, surface: `worker:${meta.toolName}`, contractId: meta.contractId })

  // Size-based estimate, the same heuristic the chat path uses. Recorded even
  // on a non-2xx: a failed generation still burned tokens upstream.
  //
  // recordUsage writes OrgUsageDaily AND the cap counter (skipping the counter
  // for BYOK), so it is the single call -- adding recordCost alongside it would
  // double-count.
  if (meta.estimate !== false) {
    const inputChars  = typeof init.body === 'string' ? init.body.length : 0
    const outputChars = (await res.clone().text().catch(() => '')).length
    const usd = estimateCostUsd(inputChars + outputChars)
    recordUsage(meta.orgId, usd, {
      provider: 'agents-service',
      model:    'background-job',
      tier:     'default',
      toolName: meta.toolName,
      inputChars,
      outputChars,
    }).catch(() => { /* accounting must never fail a job */ })
  }

  if (sent === undefined || !res.ok) return res
  const text = await res.text()
  const headers = { 'content-type': res.headers.get('content-type') ?? 'application/json' }
  if (!text) return new Response(null, { status: res.status, headers })
  let reply: unknown
  try { reply = JSON.parse(text) } catch { return new Response(text, { status: res.status, headers }) }
  const restored = restorePii(reply, source(), meta.scope)
  const left = unresolvedPiiTokens(restored, [sent, meta.context ?? '']).length
  if (left) {
    console.warn('[agent-worker] %s scope=%s: %d PII token(s) the model altered or invented stay as tokens', meta.toolName, meta.scope, left)
  }
  return new Response(JSON.stringify(restored), { status: res.status, headers })
}
