/**
 * docs/39 E3 — the agents service's /find-clause, as lib/clause-types.ts calls
 * it: through the org's AI budget and PII policy (callAgents), its token use
 * recorded, and the clauses it returns with their personal data put back.
 */
import { callAgents } from './agents-call.js'
import { recordRunUsage, type RunUsage } from './extraction-job.js'
import { restorePii } from './pii-policy.js'
import { CostCapExceededError } from './costCap.js'
import type { FindClauseCall, FoundClause } from './clause-types.js'

export function agentsFindClause(toolName: 'clause_preview' | 'clause_detect'): FindClauseCall {
  return async ({ orgId, contractId, body }) => {
    const res = await callAgents('/find-clause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body: JSON.stringify(body),
    }, { orgId, toolName, scope: contractId, contractId, context: body.plainText, estimate: false }).catch((err: Error) => {
      // A run pauses on a spent budget; anything else is said so a person can act on it.
      if (err instanceof CostCapExceededError) throw err
      throw new Error(err.message === 'fetch failed' ? 'the AI service didn’t answer' : err.message)
    })
    if (!res.ok) throw new Error(`the AI service answered ${res.status}`)
    const out = await res.json() as { clauses?: FoundClause[]; usage?: RunUsage }
    await recordRunUsage(orgId, out.usage, { inputChars: JSON.stringify(body).length, outputChars: JSON.stringify(out).length }, toolName)
    return out.clauses ? restorePii(out.clauses, body.plainText, contractId) : null
  }
}
