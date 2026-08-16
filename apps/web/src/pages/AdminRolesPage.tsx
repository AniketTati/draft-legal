import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ShieldCheck, ChevronRight, Lock, EyeOff, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, EmptyState } from '@/components/ui/primitives'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Permission {
  action: string
  resource: string
  scope: string
}

interface Role {
  id: string
  name: string
  description?: string
  permissions: Permission[]
  isSystem: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AdminRolesPage() {
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null)
  // B.6.22 — show not-yet-configured roles by default but let admins
  // hide them so the list is tidy for operating use.
  const [showUnconfigured, setShowUnconfigured] = useState(true)

  const { data: roles, isLoading } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get('/admin/users/roles').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const { visibleRoles, unconfiguredCount } = useMemo(() => {
    const all = roles ?? []
    const unconfigured = all.filter((r) => r.permissions.length === 0).length
    const filtered = showUnconfigured ? all : all.filter((r) => r.permissions.length > 0)
    return { visibleRoles: filtered, unconfiguredCount: unconfigured }
  }, [roles, showUnconfigured])

  const toggleRole = (roleId: string) => {
    setExpandedRoleId(prev => (prev === roleId ? null : roleId))
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <ShieldCheck className="size-5" />
            Roles &amp; Permissions
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            View system roles and their associated permissions. Custom role editing is coming soon.
          </p>
        </div>
        {unconfiguredCount > 0 && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => setShowUnconfigured((v) => !v)}
            data-testid="toggle-unconfigured"
            className="shrink-0"
            title={showUnconfigured
              ? 'Hide roles with no permissions yet'
              : 'Show roles with no permissions yet'}
          >
            {showUnconfigured
              ? <><EyeOff className="size-3.5" /> Hide {unconfiguredCount} unconfigured</>
              : <><Eye className="size-3.5" /> Show {unconfiguredCount} unconfigured</>}
          </Button>
        )}
      </div>

      {/* Roles list */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="size-5 border-2 border-paper-300 border-t-ink-950 rounded-full animate-spin" />
        </div>
      ) : !roles || roles.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="No roles configured" />
      ) : (
        <Card className="divide-y divide-paper-200">
          {visibleRoles.map(role => {
            const isExpanded = expandedRoleId === role.id
            const unconfigured = role.permissions.length === 0
            return (
              <div key={role.id} className={unconfigured ? 'bg-muted/20' : undefined}>
                <button
                  onClick={() => toggleRole(role.id)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-paper-50 transition-colors text-left"
                >
                  <ChevronRight
                    className={`size-4 text-ink-400 transition-transform ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-body font-medium ${unconfigured ? 'text-ink-500' : 'text-ink-950'}`}>{role.name}</p>
                      {role.isSystem && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-chip text-[10px] font-medium bg-paper-100 text-ink-500 border border-paper-200">
                          <Lock className="size-2.5" />
                          System
                        </span>
                      )}
                      {unconfigured && (
                        // "Your turn": the seat exists but an admin still has to grant it
                        // permissions, so this is attention, not decoration.
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-chip text-[10px] font-semibold uppercase tracking-wide bg-attention-50 text-attention-700 border border-attention-200">
                          Not yet configured
                        </span>
                      )}
                    </div>
                    {role.description && (
                      <p className="text-dense text-ink-500 mt-0.5">{role.description}</p>
                    )}
                  </div>
                  <span className="text-dense tabular-nums text-ink-400 flex-shrink-0">
                    {role.permissions.length} permission{role.permissions.length !== 1 ? 's' : ''}
                  </span>
                </button>

                {/* Expanded permissions */}
                {isExpanded && (
                  <div className="px-5 pb-4 pl-14">
                    {role.permissions.length === 0 ? (
                      <div className="rounded-md border border-dashed border-attention-200 bg-attention-50/50 px-3 py-2.5 text-dense text-attention-700 leading-relaxed">
                        <strong className="font-semibold">No permissions yet.</strong>{' '}
                        This role exists so you can plan for the seat, but it
                        hasn't been granted any permissions. Assigning it
                        today gives the user the same access as no role at
                        all. Custom role editing (to add permissions here)
                        lands with v1.1.
                      </div>
                    ) : (
                      <div className="bg-paper-50 rounded-card border border-paper-200 p-3">
                        <table className="w-full">
                          <thead>
                            <tr className="text-[11px] font-semibold text-ink-400 uppercase tracking-[0.08em]">
                              <th className="text-left pb-2 pr-4">Action</th>
                              <th className="text-left pb-2 pr-4">Resource</th>
                              <th className="text-left pb-2">Scope</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-paper-200">
                            {role.permissions.map((perm, i) => (
                              <tr key={i}>
                                {/* action/resource were blue and purple, but neither carries a
                                    meaning — they are machine-readable identifiers, so they read
                                    as mono neutrals: filled for the verb, outlined for the noun. */}
                                <td className="py-1.5 pr-4">
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-chip font-mono text-[11px] bg-paper-100 text-ink-950 border border-paper-200">
                                    {perm.action}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-4">
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-chip font-mono text-[11px] bg-card text-ink-700 border border-paper-200">
                                    {perm.resource}
                                  </span>
                                </td>
                                <td className="py-1.5">
                                  <span className="text-dense text-ink-500">{perm.scope}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
