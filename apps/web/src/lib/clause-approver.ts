/**
 * docs/41 Part 7 — who decides exceptions to a clause category's positions:
 * a person, everyone with a role, or no one yet. Pure helpers, shared by the
 * Clauses page (where it is set) and the Review panel (which says who an
 * exception is waiting for). Tested in clause-approver.test.ts.
 */

/** The part of a category (from GET /clauses/categories) these helpers read. */
export interface ApproverCategory {
  id: string
  name: string
  parentCategoryId?: string | null
  approverUserId?: string | null
  approverRoleId?: string | null
  children?: ApproverCategory[]
}

export interface NamedUser { id: string; name?: string | null; email?: string | null }
export interface NamedRole { id: string; name: string }

/** The category tree as one list, at any depth (the API nests children). */
export function flattenCategories<T extends ApproverCategory>(tree: T[]): T[] {
  const out: T[] = []
  const walk = (cs: T[]) => { for (const c of cs) { out.push(c); if (c.children?.length) walk(c.children as T[]) } }
  walk(tree)
  return out
}

/**
 * The approver that applies to a category: its own, else its parent's, as
 * the API resolves it when an exception is asked for (lib/approval-flow.ts).
 */
export function approverFor(categoryId: string | null | undefined, all: ApproverCategory[]): { userId: string | null; roleId: string | null } | null {
  let id = categoryId ?? null
  for (let depth = 0; id && depth < 5; depth++) {
    const c = all.find(x => x.id === id)
    if (!c) return null
    if (c.approverUserId || c.approverRoleId) return { userId: c.approverUserId ?? null, roleId: c.approverRoleId ?? null }
    id = c.parentCategoryId ?? null
  }
  return null
}

/** "Priya Shah", "Anyone with the Legal role", or null when no one is named (or the name isn't known). */
export function approverName(a: { userId: string | null; roleId: string | null } | null, users: NamedUser[], roles: NamedRole[]): string | null {
  if (!a) return null
  if (a.userId) {
    const u = users.find(x => x.id === a.userId)
    return u ? (u.name || u.email || null) : null
  }
  if (a.roleId) {
    const r = roles.find(x => x.id === a.roleId)
    return r ? `Anyone with the ${r.name} role` : null
  }
  return null
}

/** How the Clauses page states a category's own setting. */
export function decidesExceptionsWords(c: Pick<ApproverCategory, 'approverUserId' | 'approverRoleId'>, users: NamedUser[], roles: NamedRole[]): string {
  if (!c.approverUserId && !c.approverRoleId) return 'No one yet'
  return approverName({ userId: c.approverUserId ?? null, roleId: c.approverRoleId ?? null }, users, roles)
    ?? (c.approverUserId ? 'A person who is no longer listed' : 'A role that is no longer listed')
}

/**
 * The select's value for a category's setting, and the PATCH body for a
 * chosen value. Naming a person clears the role and the other way round
 * (the API does the same); "none" clears both.
 */
export function approverChoice(c: Pick<ApproverCategory, 'approverUserId' | 'approverRoleId'>): string {
  return c.approverUserId ? `user:${c.approverUserId}` : c.approverRoleId ? `role:${c.approverRoleId}` : ''
}
export function approverPatch(choice: string): { approverUserId: string | null } | { approverRoleId: string | null } | { approverUserId: null; approverRoleId: null } {
  if (choice.startsWith('user:')) return { approverUserId: choice.slice(5) }
  if (choice.startsWith('role:')) return { approverRoleId: choice.slice(5) }
  return { approverUserId: null, approverRoleId: null }
}
