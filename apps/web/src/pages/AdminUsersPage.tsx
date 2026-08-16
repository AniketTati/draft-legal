import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Users,
  UserPlus,
  X,
  AlertCircle,
  Search,
  MoreVertical,
  Copy,
  Check,
  Link2,
} from 'lucide-react'
import type { User } from '@clm/types'
import { SystemRole } from '@clm/types'
import { StatusPill } from '@/components/ui/status-pill'
import { Card, EmptyState } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

// ─── Constants ────────────────────────────────────────────────────────────────

// A role is metadata, not a state and not an action — so it stays neutral.
const ROLE_STYLES = 'bg-paper-100 text-ink-700 border border-paper-200'

const ALL_ROLES = Object.values(SystemRole)

// ─── Component ────────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ email: string; inviteToken: string } | null>(null)
  const [search, setSearch] = useState('')
  const [actionMenuUserId, setActionMenuUserId] = useState<string | null>(null)
  const [actionMenuAnchor, setActionMenuAnchor] = useState<{ top: number; right: number } | null>(null)
  const [roleDropdownUserId, setRoleDropdownUserId] = useState<string | null>(null)
  const [roleDropdownAnchor, setRoleDropdownAnchor] = useState<{ top: number; right: number } | null>(null)
  // Deactivation cuts off a colleague's access to every contract they own. It
  // used to fire on a single click in a hover menu, with no confirmation and no
  // error path — a mis-click was silent and immediate.
  const [pendingDeactivate, setPendingDeactivate] = useState<User | null>(null)
  // Role changes and reactivation used to fail silently too: the mutation
  // errored, the menu closed, and the table looked unchanged.
  const [actionError, setActionError] = useState<string | null>(null)

  const qc = useQueryClient()

  // Close menus on outside click
  useEffect(() => {
    if (!actionMenuUserId && !roleDropdownUserId) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-action-menu]') || target.closest('[data-role-selector]')) return
      setActionMenuUserId(null)
      setRoleDropdownUserId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [actionMenuUserId, roleDropdownUserId])

  // Close menus on scroll
  useEffect(() => {
    if (!actionMenuUserId && !roleDropdownUserId) return
    const handler = () => {
      setActionMenuUserId(null)
      setRoleDropdownUserId(null)
    }
    window.addEventListener('scroll', handler, true)
    return () => window.removeEventListener('scroll', handler, true)
  }, [actionMenuUserId, roleDropdownUserId])

  // Fetch users
  const { data: usersData, isLoading } = useQuery<User[]>({
    queryKey: ['admin-users'],
    queryFn: () => api.get('/users').then(r => r.data),
  })

  // Mutations
  const inviteUser = useMutation({
    mutationFn: (body: { email: string; name: string; roles: string[] }) =>
      api.post('/admin/users/invite', body).then(r => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setShowInviteModal(false)
      setInviteResult({ email: data.email, inviteToken: data.inviteToken })
    },
  })

  const errorText = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { detail?: string; message?: string } } })?.response?.data?.detail ??
    (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    fallback

  const updateRoles = useMutation({
    mutationFn: ({ userId, roles }: { userId: string; roles: string[] }) =>
      api.patch(`/admin/users/${userId}/roles`, { roles }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setRoleDropdownUserId(null)
      setActionError(null)
    },
    onError: (e) => {
      setRoleDropdownUserId(null)
      setActionError(errorText(e, 'Could not change roles for this user.'))
    },
  })

  const deactivateUser = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/admin/users/${userId}/deactivate`).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setActionMenuUserId(null)
      setPendingDeactivate(null)
      setActionError(null)
    },
    // Left on screen inside the confirm dialog — a failed deactivation is
    // exactly the case where the admin must not walk away believing it worked.
  })

  const reactivateUser = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/admin/users/${userId}/reactivate`).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setActionMenuUserId(null)
      setActionError(null)
    },
    onError: (e) => {
      setActionMenuUserId(null)
      setActionError(errorText(e, 'Could not restore this user.'))
    },
  })

  const handleActionClick = useCallback((userId: string, buttonEl: HTMLButtonElement) => {
    if (actionMenuUserId === userId) {
      setActionMenuUserId(null)
      return
    }
    const rect = buttonEl.getBoundingClientRect()
    setActionMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setActionMenuUserId(userId)
    setRoleDropdownUserId(null)
  }, [actionMenuUserId])

  const handleChangeRoles = useCallback((userId: string) => {
    // Reuse the same anchor position as the action menu
    setRoleDropdownAnchor(actionMenuAnchor)
    setRoleDropdownUserId(userId)
    setActionMenuUserId(null)
  }, [actionMenuAnchor])

  const users = usersData ?? []
  const filteredUsers = search
    ? users.filter(
        u =>
          u.name.toLowerCase().includes(search.toLowerCase()) ||
          u.email.toLowerCase().includes(search.toLowerCase())
      )
    : users

  const deactivatedCount = users.filter(u => (u.status as string) === 'DEACTIVATED').length

  const activeUser = filteredUsers.find(u => u.id === actionMenuUserId)
  const roleUser = filteredUsers.find(u => u.id === roleDropdownUserId)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <Users className="size-5" />
            User Management
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            Manage users, roles, and permissions for your organization.
          </p>
        </div>
        <Button onClick={() => setShowInviteModal(true)} className="gap-2">
          <UserPlus className="size-4" />
          Invite User
        </Button>
      </div>

      {/* Invite Link Banner */}
      {inviteResult && (
        <InviteLinkBanner
          email={inviteResult.email}
          inviteToken={inviteResult.inviteToken}
          onDismiss={() => setInviteResult(null)}
        />
      )}

      {/* A failed role change or restore used to leave no trace at all. */}
      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-risk-200 bg-risk-50 p-3"
          data-testid="admin-users-error"
        >
          <AlertCircle className="mt-px size-4 flex-shrink-0 text-risk-600" />
          <p className="flex-1 text-dense text-risk-700">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            aria-label="Dismiss error"
            className="rounded-chip p-0.5 text-risk-600 hover:text-risk-700"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
          <Input
            id="admin-users-search"
            aria-label="Search users by name or email"
            placeholder="Search users…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {/* Say what the table is showing. With a filter applied, "6 users" and
            "6 of 42 users" are very different facts to act on. */}
        <p className="text-dense tabular-nums text-ink-500" aria-live="polite">
          {search
            ? `${filteredUsers.length} of ${users.length} user${users.length === 1 ? '' : 's'}`
            : `${users.length} user${users.length === 1 ? '' : 's'}`}
          {deactivatedCount > 0 && !search && (
            <span className="text-ink-400"> · {deactivatedCount} deactivated</span>
          )}
        </p>
      </div>

      {/* Users table */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="size-5 border-2 border-paper-300 border-t-ink-950 rounded-full animate-spin" />
        </div>
      ) : filteredUsers.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No users found"
          description={search ? 'Try a different search term.' : 'Invite your first team member to get started.'}
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-paper-200 bg-paper-50">
                <th className="text-left text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2">
                  Name
                </th>
                <th className="text-left text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2">
                  Email
                </th>
                <th className="text-left text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2">
                  Status
                </th>
                <th className="text-left text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2">
                  Roles
                </th>
                <th className="text-left text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2">
                  Last Active
                </th>
                <th className="text-right text-[11px] font-semibold text-ink-500 uppercase tracking-[0.08em] px-5 py-2 w-20">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-200">
              {filteredUsers.map(user => {
                const deactivated = (user.status as string) === 'DEACTIVATED'
                return (
                <tr
                  key={user.id}
                  data-testid={`user-row-${user.id}`}
                  // A revoked seat should read as revoked down the whole row,
                  // not only in the status cell — otherwise a table of forty
                  // looks uniformly live at a glance.
                  className={`transition-colors hover:bg-paper-50 ${deactivated ? 'bg-paper-50' : ''}`}
                >
                  <td className={`px-5 py-2 text-[13px] font-medium ${deactivated ? 'text-ink-500' : 'text-ink-950'}`}>
                    {user.name}
                  </td>
                  <td className={`px-5 py-2 text-[13px] ${deactivated ? 'text-ink-400' : 'text-ink-700'}`}>{user.email}</td>
                  <td className="px-5 py-2">
                    {/*
                      ACTIVE is shared with ObligationStatus, where it means "in
                      flight". A live seat isn't in flight — it's the account
                      equivalent of "connected", so it reads as binding here.
                    */}
                    <StatusPill
                      status={user.status}
                      meaning={(user.status as string) === 'ACTIVE' ? 'binding' : undefined}
                    />
                  </td>
                  <td className="px-5 py-2">
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map(role => (
                        <span
                          key={role}
                          className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-medium ${ROLE_STYLES}`}
                        >
                          {role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-2 text-[13px] tabular-nums text-ink-500">
                    {user.lastActiveAt
                      ? new Date(user.lastActiveAt).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td className="px-5 py-2 text-right">
                    <button
                      onClick={e => handleActionClick(user.id, e.currentTarget)}
                      aria-label={`Actions for ${user.name}`}
                      aria-haspopup="menu"
                      aria-expanded={actionMenuUserId === user.id}
                      data-testid={`user-actions-${user.id}`}
                      className="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-paper-100 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MoreVertical className="size-4" />
                    </button>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </Card>
      )}

      {/* Action menu — rendered as portal so it's not clipped by table overflow */}
      {actionMenuUserId && activeUser && actionMenuAnchor && createPortal(
        <div
          data-action-menu
          role="menu"
          aria-label={`Actions for ${activeUser.name}`}
          className="fixed w-48 bg-popover rounded-md border border-paper-200 shadow-e2 z-50 py-1"
          style={{ top: actionMenuAnchor.top, right: actionMenuAnchor.right }}
        >
          <button
            role="menuitem"
            onClick={() => handleChangeRoles(actionMenuUserId)}
            className="w-full text-left px-4 py-2 text-dense text-ink-700 hover:bg-paper-100"
          >
            Change Roles
          </button>
          {(activeUser.status as string) === 'DEACTIVATED' ? (
            // Restoring a seat is an ordinary admin action, not a binding legal
            // event — ink, not brand.
            <button
              role="menuitem"
              onClick={() => reactivateUser.mutate(actionMenuUserId)}
              className="w-full text-left px-4 py-2 text-dense text-ink-950 font-medium hover:bg-paper-100"
            >
              Reactivate
            </button>
          ) : (
            // Cutting off access is destructive — risk earns its color here,
            // and the act now goes through a confirm rather than firing on the
            // first click of a menu the pointer had to pass over anyway.
            <button
              role="menuitem"
              onClick={() => {
                setPendingDeactivate(activeUser)
                setActionMenuUserId(null)
              }}
              data-testid="deactivate-user"
              className="w-full text-left px-4 py-2 text-dense text-risk-700 hover:bg-risk-50"
            >
              Deactivate…
            </button>
          )}
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={pendingDeactivate != null}
        testId="deactivate-confirm"
        title="Deactivate this user?"
        confirmLabel={deactivateUser.isPending ? 'Deactivating…' : 'Deactivate user'}
        isPending={deactivateUser.isPending}
        error={
          deactivateUser.isError
            ? errorText(deactivateUser.error, 'Could not deactivate this user.')
            : null
        }
        body={
          <>
            <span className="font-medium text-ink-950">{pendingDeactivate?.name}</span>{' '}
            <span className="font-mono text-[11.5px] text-ink-500">{pendingDeactivate?.email}</span>{' '}
            loses access immediately — sessions end, and they drop out of approval
            and signature routing. Contracts they own stay assigned to them, so
            reassign anything live first. You can restore the seat later.
          </>
        }
        onConfirm={() => pendingDeactivate && deactivateUser.mutate(pendingDeactivate.id)}
        onCancel={() => {
          deactivateUser.reset()
          setPendingDeactivate(null)
        }}
      />

      {/* Role selector — rendered as portal */}
      {roleDropdownUserId && roleUser && roleDropdownAnchor && createPortal(
        <div
          data-role-selector
          className="fixed w-56 bg-popover rounded-md border border-paper-200 shadow-e2 z-50 p-3"
          style={{ top: roleDropdownAnchor.top, right: roleDropdownAnchor.right }}
        >
          <RoleSelector
            currentRoles={roleUser.roles as string[]}
            onSave={roles => updateRoles.mutate({ userId: roleDropdownUserId, roles })}
            onCancel={() => setRoleDropdownUserId(null)}
            isPending={updateRoles.isPending}
          />
        </div>,
        document.body
      )}

      {/* Invite User Modal */}
      {showInviteModal && (
        <InviteUserModal
          onClose={() => setShowInviteModal(false)}
          onSubmit={data => inviteUser.mutate(data)}
          isPending={inviteUser.isPending}
          error={
            inviteUser.error
              ? (inviteUser.error as any).response?.data?.detail ?? 'Failed to invite user'
              : undefined
          }
        />
      )}
    </div>
  )
}

// ─── Role Selector ────────────────────────────────────────────────────────────

function RoleSelector({
  currentRoles,
  onSave,
  onCancel,
  isPending,
}: {
  currentRoles: string[]
  onSave: (roles: string[]) => void
  onCancel: () => void
  isPending: boolean
}) {
  const [selected, setSelected] = useState<string[]>([...currentRoles])

  const toggle = (role: string) => {
    setSelected(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    )
  }

  return (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700 mb-2">Select Roles</p>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {ALL_ROLES.map(role => (
          <label
            key={role}
            className="flex items-center gap-2 px-2 py-1.5 rounded-chip hover:bg-paper-50 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.includes(role)}
              onChange={() => toggle(role)}
              className="rounded-chip border-paper-300 accent-ink-950"
            />
            <span className="text-dense text-ink-700">{role}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-3 pt-2 border-t border-paper-200">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSave(selected)}
          disabled={isPending || selected.length === 0}
        >
          {isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </>
  )
}

// ─── Invite Link Banner ──────────────────────────────────────────────────────

function InviteLinkBanner({
  email,
  inviteToken,
  onDismiss,
}: {
  email: string
  inviteToken: string
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)
  const inviteUrl = `${window.location.origin}/accept-invite/${inviteToken}`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    // Info, not attention: the invitation is out and waiting on the invitee —
    // in flight, someone else's turn.
    <div className="bg-info-50 border border-info-200 rounded-card p-4 flex items-start gap-3">
      <Link2 className="size-5 text-info-600 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-body font-semibold text-info-700">
          Invitation sent to {email}
        </p>
        <p className="text-dense text-ink-700 mt-1">
          Share this link with them to accept the invite:
        </p>
        <div className="flex items-center gap-2 mt-2">
          <code className="font-mono text-[11px] bg-card border border-info-200 rounded-chip px-2 py-1.5 text-ink-950 truncate block flex-1">
            {inviteUrl}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopy}
            className="flex-shrink-0 gap-1.5"
          >
            {copied ? (
              <>
                {/* Clipboard confirmation is a neutral fact, not a binding event. */}
                <Check className="size-3.5 text-ink-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="p-1 rounded-chip text-ink-400 hover:text-ink-700 flex-shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

// ─── Invite User Modal ────────────────────────────────────────────────────────

function InviteUserModal({
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  onClose: () => void
  onSubmit: (data: { email: string; name: string; roles: string[] }) => void
  isPending: boolean
  error?: string
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [formError, setFormError] = useState('')

  // Escape closes, like every other overlay in the product. Without it the
  // only exit from this form was the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleRole = (role: string) => {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    )
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    setFormError('')
    const trimmedEmail = email.trim()
    if (!trimmedEmail) return setFormError('Email is required')
    // Caught here rather than at the API: an admin who fat-fingers a domain
    // otherwise gets a live invite token addressed to nobody.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return setFormError('Enter a valid email address, e.g. colleague@company.com')
    }
    if (!name.trim()) return setFormError('Name is required')
    if (selectedRoles.length === 0) return setFormError('Select at least one role')
    onSubmit({ email: trimmedEmail, name: name.trim(), roles: selectedRoles })
  }

  const displayError = error || formError

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} aria-hidden="true" />
      {/* A real <form>, so Enter submits from any field — this is a five-a-day
          task for an admin onboarding a team. */}
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-user-title"
        className="relative w-full max-w-md rounded-card border border-paper-200 bg-card shadow-e3"
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-paper-200">
          <h2 id="invite-user-title" className="text-section text-ink-950">Invite User</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-ink-400 hover:text-ink-700 hover:bg-paper-100"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Modal body */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <Label htmlFor="invite-email" className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Email *</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              autoFocus
              placeholder="colleague@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="invite-name" className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Name *</Label>
            <Input
              id="invite-name"
              placeholder="Full name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <Label className="text-[11.5px] font-semibold text-ink-950">Roles *</Label>
              <span className="text-[11px] tabular-nums text-ink-400">
                {selectedRoles.length} selected
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
              {ALL_ROLES.map(role => (
                <label
                  key={role}
                  className={`flex cursor-pointer items-center gap-2 rounded-chip border px-2 py-1.5 ${
                    selectedRoles.includes(role)
                      ? 'border-ink-950 bg-paper-100'
                      : 'border-paper-200 hover:bg-paper-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role)}
                    onChange={() => toggleRole(role)}
                    className="rounded-chip border-paper-300 accent-ink-950"
                  />
                  <span className="text-dense text-ink-700">{role}</span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
              Roles are additive — a user gets the union of every permission their
              roles grant. Review the grants under Roles &amp; Permissions.
            </p>
          </div>

          {displayError && (
            <div role="alert" className="flex items-start gap-2 p-3 bg-risk-50 border border-risk-200 rounded-md">
              <AlertCircle className="mt-px size-4 text-risk-600 flex-shrink-0" />
              <p className="text-dense text-risk-700">{displayError}</p>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-paper-200">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending} className="gap-2">
            <UserPlus className="size-4" />
            {isPending ? 'Inviting…' : 'Send Invite'}
          </Button>
        </div>
      </form>
    </div>
  )
}
