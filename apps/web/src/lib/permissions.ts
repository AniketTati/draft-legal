import { useAuthStore } from '@/store/auth'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { canRequest, heldPermissions, rememberRoles } from '@/lib/can-request'

interface Permission {
  action: string
  resource: string
  scope: string
}

interface Role {
  id: string
  orgId?: string
  name: string
  description?: string
  permissions: Permission[]
  isSystem: boolean
}

// Fetch roles+permissions from API, cached
export function useRoles() {
  return useQuery<Role[]>({
    queryKey: ['roles'],
    // Y3 — also kept for the API client, which refuses a write the user
    // can't make (lib/api.ts).
    queryFn: () => api.get('/admin/users/roles').then(r => { rememberRoles(r.data); return r.data }),
    staleTime: 5 * 60 * 1000,
  })
}

// Check if current user has a specific permission
export function usePermission(action: string, resource: string): boolean {
  const userRoleNames = useAuthStore(s => s.user?.roles ?? []) as string[]
  const { data: roleData } = useRoles()

  // ADMIN always has full access — check role name directly (no API dependency)
  if (userRoleNames.includes('ADMIN')) return true

  if (!roleData) return false

  const userRoles = roleData.filter(r => userRoleNames.includes(r.name))
  return userRoles.some(r =>
    r.permissions.some(p =>
      (p.action === '*' || p.action === action) &&
      (p.resource === '*' || p.resource === resource)
    )
  )
}

/**
 * Y3 — whether the user may make an API call, by the permission the server's
 * route for it needs (lib/can-request.ts). `request` is "METHOD /path", the
 * path as the client calls it or as the route's pattern:
 * "POST /contracts/:id/share". False until the user's roles are known.
 */
export function useCanRequest(request: string): boolean {
  const userRoleNames = useAuthStore(s => s.user?.roles ?? []) as string[]
  const { data: roleData } = useRoles()
  const held = heldPermissions(userRoleNames, roleData)
  if (held === null) return false
  const [method, path] = request.split(' ')
  return canRequest(held, method, path)
}
