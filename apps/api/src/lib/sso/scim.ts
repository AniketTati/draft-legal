/**
 * docs/41 Part 20 — SCIM 2.0 (RFC 7643/7644) provisioning: an identity
 * provider (Okta, Entra ID, OneLogin, JumpCloud) creates, updates and
 * deactivates users, and puts them in groups that carry a draftLegal role.
 *
 * This module holds the parts with no HTTP in them: the resource shapes, the
 * filter and PATCH grammar the providers actually send, and the user and
 * group changes. routes/scim.ts serves them.
 */
import type { ScimGroup, User } from '@prisma/client'
import { prisma } from '../prisma.js'
import { DEFAULT_ROLE_PERMISSIONS } from '../permissions.js'

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'

export const SCIM_TOKEN_PREFIX = 'scim_'

export function scimError(status: number, detail: string, scimType?: string) {
  return { schemas: [SCHEMA_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }
}

export function listResponse<T>(resources: T[], total: number, startIndex: number) {
  return { schemas: [SCHEMA_LIST], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources }
}

function splitName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/)
  return { givenName: parts[0] ?? '', familyName: parts.slice(1).join(' ') }
}

export function toScimUser(user: Pick<User, 'id' | 'email' | 'name' | 'status' | 'createdAt' | 'updatedAt'>, externalId: string | null, baseUrl: string) {
  return {
    schemas: [SCHEMA_USER],
    id: user.id,
    ...(externalId ? { externalId } : {}),
    userName: user.email,
    name: { formatted: user.name, ...splitName(user.name) },
    displayName: user.name,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    active: user.status !== 'DEACTIVATED',
    meta: { resourceType: 'User', created: user.createdAt.toISOString(), lastModified: user.updatedAt.toISOString(), location: `${baseUrl}/Users/${user.id}` },
  }
}

export function toScimGroup(group: ScimGroup, members: Array<{ id: string; email: string }>, baseUrl: string) {
  return {
    schemas: [SCHEMA_GROUP],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.displayName,
    members: members.map(m => ({ value: m.id, display: m.email, $ref: `${baseUrl}/Users/${m.id}` })),
    meta: { resourceType: 'Group', created: group.createdAt.toISOString(), lastModified: group.updatedAt.toISOString(), location: `${baseUrl}/Groups/${group.id}` },
  }
}

/**
 * The filters providers send: `attr eq "value"` (userName, externalId,
 * emails.value, displayName), case-insensitive on the attribute name. Anything
 * else is answered 400 invalidFilter, as RFC 7644 asks.
 */
export function parseFilter(filter: string | undefined): { attribute: string; value: string } | null | 'invalid' {
  if (!filter) return null
  const m = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter)
  if (!m) return 'invalid'
  return { attribute: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') }
}

/** SCIM booleans arrive as true, "true" or "True" (Entra ID). */
export function scimBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
  return undefined
}

export interface UserChanges { active?: boolean; name?: string; email?: string; externalId?: string }

/** The email in a SCIM user: userName, else the primary (or first) email. */
export function scimEmail(body: Record<string, unknown>): string | null {
  const emails = Array.isArray(body.emails) ? body.emails as Array<{ value?: unknown; primary?: unknown }> : []
  const primary = emails.find(e => scimBool(e.primary)) ?? emails[0]
  const candidate = typeof body.userName === 'string' && body.userName.includes('@') ? body.userName : typeof primary?.value === 'string' ? primary.value : null
  const email = candidate?.trim().toLowerCase() ?? null
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/** The display name in a SCIM user, from what the provider sent. */
export function scimName(body: Record<string, unknown>): string | null {
  const name = body.name as { formatted?: unknown; givenName?: unknown; familyName?: unknown } | undefined
  if (typeof name?.formatted === 'string' && name.formatted.trim()) return name.formatted.trim()
  const parts = [name?.givenName, name?.familyName].filter((p): p is string => typeof p === 'string' && !!p.trim())
  if (parts.length) return parts.join(' ').trim()
  return typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : null
}

/**
 * A PATCH's operations, as changes to a user. Handles both shapes providers
 * send: `{ op: "replace", path: "active", value: false }` and
 * `{ op: "replace", value: { active: false, "name.givenName": … } }`.
 */
export function userPatchChanges(operations: unknown): UserChanges | 'invalid' {
  if (!Array.isArray(operations)) return 'invalid'
  const changes: UserChanges = {}
  const apply = (path: string, value: unknown) => {
    const p = path.toLowerCase()
    if (p === 'active') { const b = scimBool(value); if (b !== undefined) changes.active = b }
    else if (p === 'username' && typeof value === 'string') changes.email = value.trim().toLowerCase()
    else if (p === 'externalid' && typeof value === 'string') changes.externalId = value
    else if ((p === 'displayname' || p === 'name.formatted') && typeof value === 'string') changes.name = value
    else if (p === 'name' && value && typeof value === 'object') changes.name = scimName({ name: value }) ?? changes.name
  }
  for (const op of operations as Array<{ op?: unknown; path?: unknown; value?: unknown }>) {
    const kind = typeof op.op === 'string' ? op.op.toLowerCase() : ''
    if (kind !== 'replace' && kind !== 'add') continue
    if (typeof op.path === 'string') apply(op.path, op.value)
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) apply(k, v)
  }
  return changes
}

/** A group PATCH: members added and removed, and a new display name. */
export function groupPatchChanges(operations: unknown): { add: string[]; remove: string[]; displayName?: string; replaceMembers?: string[] } | 'invalid' {
  if (!Array.isArray(operations)) return 'invalid'
  const out: { add: string[]; remove: string[]; displayName?: string; replaceMembers?: string[] } = { add: [], remove: [] }
  const ids = (v: unknown) => (Array.isArray(v) ? v : [v]).map(m => (m as { value?: unknown })?.value).filter((x): x is string => typeof x === 'string')
  for (const op of operations as Array<{ op?: unknown; path?: unknown; value?: unknown }>) {
    const kind = typeof op.op === 'string' ? op.op.toLowerCase() : ''
    const path = typeof op.path === 'string' ? op.path : ''
    // Entra ID removes one member as path `members[value eq "id"]`.
    const one = /^members\[value eq "([^"]+)"\]$/i.exec(path)
    if (kind === 'remove' && one) out.remove.push(one[1])
    else if (path.toLowerCase() === 'members') {
      if (kind === 'add') out.add.push(...ids(op.value))
      else if (kind === 'remove') out.remove.push(...ids(op.value))
      else if (kind === 'replace') out.replaceMembers = ids(op.value)
    } else if (path.toLowerCase() === 'displayname' && typeof op.value === 'string') out.displayName = op.value
    else if (!path && kind === 'replace' && op.value && typeof op.value === 'object') {
      const v = op.value as { displayName?: unknown; members?: unknown }
      if (typeof v.displayName === 'string') out.displayName = v.displayName
      if (v.members !== undefined) out.replaceMembers = ids(v.members)
    }
  }
  return out
}

/**
 * Deactivate a user as an admin does (routes/admin-users.ts): sign them out
 * and revoke the API keys they made, and keys made through those (X43, X46).
 */
export async function deactivateUser(orgId: string, userId: string): Promise<{ apiKeysRevoked: number }> {
  await prisma.user.updateMany({ where: { id: userId, orgId }, data: { status: 'DEACTIVATED', refreshToken: null } })
  const chain = new Set<string>()
  for (let makers = [userId]; makers.length;) {
    const made = await prisma.apiKey.findMany({ where: { orgId, createdById: { in: makers } }, select: { id: true } })
    const fresh = made.map(k => k.id).filter(k => !chain.has(k))
    fresh.forEach(k => chain.add(k))
    makers = fresh.map(k => `apikey:${k}`)
  }
  const keys = await prisma.apiKey.updateMany({ where: { orgId, id: { in: [...chain] }, revokedAt: null }, data: { revokedAt: new Date() } })
  return { apiKeysRevoked: keys.count }
}

/** A group's role, given to members it gains and taken from members it loses. */
export async function syncGroupRoles(orgId: string, group: Pick<ScimGroup, 'id' | 'roleName'>, before: string[], after: string[]): Promise<void> {
  const grantedBy = `scim:${group.id}`
  const removed = before.filter(id => !after.includes(id))
  if (removed.length) await prisma.userRole.deleteMany({ where: { grantedBy, userId: { in: removed }, user: { orgId } } })
  if (!group.roleName) return
  const roleId = await roleIdFor(orgId, group.roleName)
  if (!roleId) return
  const members = await prisma.user.findMany({ where: { orgId, id: { in: after }, deletedAt: null }, select: { id: true } })
  for (const m of members) {
    const has = await prisma.userRole.findFirst({ where: { userId: m.id, roleId } })
    if (!has) await prisma.userRole.create({ data: { userId: m.id, roleId, grantedBy } })
  }
}

/**
 * The id of the role named `name` for an org: its own role, a built-in one,
 * or (for a system role name with no row yet) an org copy of it, which takes
 * the system role's default permissions. Null when no such role exists.
 */
export async function roleIdFor(orgId: string, name: string): Promise<string | null> {
  const role = await prisma.role.findFirst({
    where: { name, OR: [{ orgId }, { orgId: null, isSystem: true }] },
    orderBy: { orgId: 'asc' },
    select: { id: true },
  })
  if (role) return role.id
  if (!DEFAULT_ROLE_PERMISSIONS[name]) return null
  const copy = await prisma.role.upsert({
    where: { orgId_name: { orgId, name } },
    create: { orgId, name, isSystem: true },
    update: {},
    select: { id: true },
  })
  return copy.id
}
