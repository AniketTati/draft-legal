/**
 * docs/39 D6 — the agents service's /extract-fields, as lib/diligence-columns.ts
 * asks it: through the org's AI budget and PII policy (callAgents, which puts
 * the personal data back in what it returns), its token use recorded, and a
 * failure said so a person can act on it.
 */
import { callAgents } from './agents-call.js'
import { recordRunUsage, type RunUsage } from './extraction-job.js'
import { CostCapExceededError } from './costCap.js'
import type { AskFields, ExtractedAnswer } from './diligence-columns.js'

export function agentsAskFields(toolName = 'diligence_column'): AskFields {
  return async ({ orgId, contractId, body }) => {
    const res = await callAgents('/extract-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body: JSON.stringify(body),
    }, { orgId, toolName, scope: contractId, contractId, context: body.plainText, estimate: false }).catch((err: Error) => {
      // A run pauses on a spent budget; anything else is said so a person can act on it.
      if (err instanceof CostCapExceededError) throw err
      throw new Error(err.message === 'fetch failed' ? 'the AI service didn’t answer' : err.message)
    })
    if (!res.ok) throw new Error(`the AI service answered ${res.status}`)
    const out = await res.json() as { customFields?: Record<string, ExtractedAnswer>; usage?: RunUsage }
    await recordRunUsage(orgId, out.usage, { inputChars: JSON.stringify(body).length, outputChars: JSON.stringify(out).length }, toolName)
    return out.customFields ?? null
  }
}
