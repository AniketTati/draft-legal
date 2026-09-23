import { prisma } from './prisma.js'
import { getPermissionsForRoles, evaluatePermission } from './permissions.js'

/**
 * X46 — the user behind an API key, while they could still make it.
 *
 * That is the user who made the key or, for a key made through other keys
 * (possible before key management was closed to keys), the user at the root,
 * through keys that are all unrevoked and unexpired — and only while that
 * user is an active member of the key's org who can manage its API keys
 * (`configure:organization`). A key's access ends with that: whoever leaves,
 * is deleted or loses the right to make keys takes their keys with them.
 *
 * `madeBy` is a key's `createdById` (a user id, or `apikey:<id>`), or a user
 * id to ask whether that user may make a key now. Returns the user's id.
 */
export async function keyMaker(orgId: string, madeBy: string): Promise<string | null> {
  let id = madeBy
  for (let hops = 0; id.startsWith('apikey:'); hops++) {
    if (hops === 5) return null
    const key = await prisma.apiKey.findFirst({
      where: {
        id: id.slice('apikey:'.length), orgId, revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { createdById: true },
    })
    if (!key) return null
    id = key.createdById
  }
  const user = await prisma.user.findFirst({
    where: { id, orgId, deletedAt: null, status: { not: 'DEACTIVATED' } },
    select: { userRoles: { select: { role: { select: { name: true } } } } },
  })
  if (!user) return null
  const permissions = await getPermissionsForRoles(orgId, user.userRoles.map(ur => ur.role.name))
  return evaluatePermission(permissions, 'configure', 'organization').granted ? id : null
}

/**
 * X45 — the user a caller acts as, where a column must name a user (a
 * contract's or matter's owner, an org AI key's creator, a skill invocation).
 *
 * A signed-in user acts as themselves. A public-API key authenticates as
 * `apikey:<id>`, which is no user, and those columns are foreign keys to one:
 * a `contracts:write` key's contract or matter failed with a 500 (and a draft
 * saved through the agent was silently dropped). A key acts as the user
 * behind it, which requireAuth resolved (keyMaker) — someone who can make a
 * key that reads and edits every contract, so owning what the key creates
 * gives them nothing they don't have. null when there is no such user, and
 * the caller answers NO_ACTING_USER rather than pick someone.
 *
 * Attribution that is a plain string (`createdBy`, a version's `createdById`)
 * and audit events keep naming the key.
 */
export function actingUserId(caller: { sub: string; keyMakerId?: string }): string | null {
  if (!caller.sub.startsWith('apikey:')) return caller.sub
  return caller.keyMakerId ?? null
}

export const NO_ACTING_USER = {
  error: 'NO_ACTING_USER',
  detail: 'This API key has no user to act as: the user who made it can no longer make API keys. Create a new key.',
}
