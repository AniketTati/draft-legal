import { prisma } from './prisma.js'
import { getPermissionsForRoles, evaluatePermission } from './permissions.js'

/**
 * X45 — the user a caller acts as, where a column must name a user (a
 * contract's or matter's owner, an org AI key's creator, a skill invocation).
 *
 * A signed-in user acts as themselves. A public-API key authenticates as
 * `apikey:<id>`, which is no user, and those columns are foreign keys to one:
 * a `contracts:write` key's contract or matter failed with a 500 (and a draft
 * saved through the agent was silently dropped).
 *
 * A key acts as the user who made it — for a key made by another key, the
 * user at the root, through keys that are all unrevoked — while that user is
 * an active member of the key's org who can still manage its API keys
 * (`configure:organization`). Anyone who can do that can make a key that reads
 * and edits every contract, so owning what the key creates gives them nothing
 * they don't have; a maker since moved to a narrower role would be handed
 * contracts they otherwise couldn't open. null when there is no such user,
 * and the caller answers NO_ACTING_USER rather than pick someone.
 *
 * Attribution that is a plain string (`createdBy`, a version's `createdById`)
 * and audit events keep naming the key.
 */
export async function actingUserId(caller: { sub: string; orgId: string }): Promise<string | null> {
  if (!caller.sub.startsWith('apikey:')) return caller.sub
  let id = caller.sub
  for (let hops = 0; id.startsWith('apikey:'); hops++) {
    if (hops === 5) return null
    const key = await prisma.apiKey.findFirst({
      where: { id: id.slice('apikey:'.length), orgId: caller.orgId, revokedAt: null },
      select: { createdById: true },
    })
    if (!key) return null
    id = key.createdById
  }
  const maker = await prisma.user.findFirst({
    where: { id, orgId: caller.orgId, deletedAt: null, status: { not: 'DEACTIVATED' } },
    select: { userRoles: { select: { role: { select: { name: true } } } } },
  })
  if (!maker) return null
  const permissions = await getPermissionsForRoles(caller.orgId, maker.userRoles.map(ur => ur.role.name))
  return evaluatePermission(permissions, 'configure', 'organization').granted ? id : null
}

export const NO_ACTING_USER = {
  error: 'NO_ACTING_USER',
  detail: 'This API key has no user to act as: the user who made it is no longer an active member of the organization, or can no longer manage its API keys. Create a new key.',
}
