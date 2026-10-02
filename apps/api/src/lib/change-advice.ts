/**
 * docs/41 Part 15 — the model's view of a counterparty's changes, as part of
 * the review instead of a panel of its own.
 *
 *   counterChange      Counter… on one change in the workspace: counter
 *                      wording with a one-line rationale (agents
 *                      /redline/counter), which the workspace puts into the
 *                      draft changes as the new text.
 *
 * The change scoring that used to fill the Negotiate tab's "Analyse
 * redlines" panel runs here as a findings stage (changeAdviceStep, below).
 */
import { prisma } from './prisma.js'
import { callAgents } from './agents-call.js'
import { contractPlaybook } from './playbooks.js'

/** The playbook positions the model weighs a change against, for a contract. */
export async function positionsFor(orgId: string, contract: { id: string; type: string; playbookId?: string | null }) {
  const playbook = await contractPlaybook(orgId, contract)
  if (!playbook.where) return []
  const rows = await prisma.playbookPosition.findMany({
    where: playbook.where,
    select: { positionType: true, content: true, clauseCategory: { select: { name: true } } },
    take: 200,
  })
  return rows.map(r => ({ clause: r.clauseCategory?.name ?? null, positionType: r.positionType, content: r.content }))
}

export interface CounterDraft { counterText: string; counterNote: string }

/** Counter wording for one change, with why. Throws when the agents service fails. */
export async function counterChange(a: {
  orgId: string
  contract: { id: string; type: string; playbookId?: string | null }
  ourText: string
  theirText: string
  clauseType?: string | null
}): Promise<CounterDraft> {
  const playbookPositions = await positionsFor(a.orgId, a.contract)
  const res = await callAgents('/redline/counter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    body: JSON.stringify({
      ourText: a.ourText, theirText: a.theirText, clauseType: a.clauseType ?? null,
      contractType: a.contract.type, orgId: a.orgId, playbookPositions,
    }),
  }, { orgId: a.orgId, toolName: 'redline_counter', scope: a.contract.id, contractId: a.contract.id, context: `${a.ourText}\n\n${a.theirText}` })
  if (!res.ok) throw new Error(`Agents /redline/counter returned ${res.status}`)
  const body = await res.json() as Partial<CounterDraft>
  return { counterText: String(body.counterText ?? '').trim(), counterNote: String(body.counterNote ?? '').trim() }
}
