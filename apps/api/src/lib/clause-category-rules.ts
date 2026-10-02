/**
 * docs/41 fix-up 9 — a clause category's rules: whether contracts must have
 * it (presence, for which contract types) and who decides exceptions to its
 * positions (a person or a role). Set from the Clauses page (edit:clause) and
 * from the Playbook page (edit:playbook); both write through here.
 *
 * Changing the presence rule stamps `presenceChangedAt`. Findings are not
 * recomputed then: a contract's current, unsigned version reviewed before that
 * moment is reviewed again the next time its review is read
 * (review-findings.ts `findingsFor`). Decisions people made on findings are
 * kept; signed versions keep the findings they were signed with.
 */
import { z } from 'zod'
import { prisma } from './prisma.js'

export const PRESENCE = ['required', 'not_allowed', 'optional'] as const

export const CategoryRulesSchema = z.object({
  presence: z.enum(PRESENCE).optional(),
  presenceContractTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
  approverUserId: z.string().min(1).nullable().optional(),
  approverRoleId: z.string().min(1).nullable().optional(),
})
export type CategoryRules = z.infer<typeof CategoryRulesSchema>

/** A clause approver must be a member, or a role, of the org (never another org's). */
export async function approverError(orgId: string, body: { approverUserId?: string | null; approverRoleId?: string | null }): Promise<string | null> {
  if (body.approverUserId && body.approverRoleId) return 'Name a person or a role to decide exceptions, not both.'
  if (body.approverUserId && !await prisma.user.count({ where: { id: body.approverUserId, orgId, deletedAt: null } })) return 'That person is not a member of this organization.'
  if (body.approverRoleId && !await prisma.role.count({ where: { id: body.approverRoleId, OR: [{ orgId }, { orgId: null }] } })) return 'That role is not one of this organization’s.'
  return null
}

const sameTypes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

/**
 * The update for a category's rules: naming one kind of approver clears the
 * other, and a presence rule that changed is stamped.
 */
export function rulesUpdate(
  existing: { presence: string; presenceContractTypes: string[] },
  body: CategoryRules,
  now = new Date(),
) {
  const presenceChanged = (body.presence !== undefined && body.presence !== existing.presence)
    || (body.presenceContractTypes !== undefined && !sameTypes(body.presenceContractTypes, existing.presenceContractTypes))
  return {
    ...(body.approverUserId && { approverRoleId: null }),
    ...(body.approverRoleId && { approverUserId: null }),
    ...(presenceChanged && { presenceChangedAt: now }),
  }
}
