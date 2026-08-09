import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/common/Toaster'
import { Card, Chip } from '@/components/ui/primitives'
import type { User } from '@clm/types'

export function ProfilePage() {
  const setUser = useAuthStore((s) => s.setUser)

  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { data: profile, isLoading } = useQuery<User>({
    queryKey: ['profile'],
    queryFn: async () => {
      const { data } = await api.get('/users/me')
      return data
    },
  })

  useEffect(() => {
    if (profile) {
      setName(profile.name ?? '')
      setAvatarUrl(profile.avatarUrl ?? '')
    }
  }, [profile])

  const updateProfile = useMutation({
    mutationFn: async (body: { name: string; avatarUrl?: string }) => {
      const { data } = await api.patch('/users/me', body)
      return data
    },
    onSuccess: (data) => {
      setProfileMsg({ type: 'success', text: 'Profile updated successfully.' })
      setUser(data)
      toast.success('Profile saved')
    },
    onError: () => {
      setProfileMsg({ type: 'error', text: 'Failed to update profile.' })
      toast.error('Failed to save profile', { description: 'Check your connection and try again.' })
    },
  })

  const changePassword = useMutation({
    mutationFn: async (body: { oldPassword: string; newPassword: string }) => {
      await api.post('/users/me/password', body)
    },
    onSuccess: () => {
      setPasswordMsg({ type: 'success', text: 'Password changed successfully.' })
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success('Password changed')
    },
    onError: () => {
      setPasswordMsg({ type: 'error', text: 'Failed to change password. Check your current password.' })
      toast.error('Password change failed', { description: 'Current password may be incorrect.' })
    },
  })

  function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault()
    setProfileMsg(null)
    updateProfile.mutate({ name, avatarUrl: avatarUrl || undefined })
  }

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPasswordMsg(null)
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'New passwords do not match.' })
      return
    }
    changePassword.mutate({ oldPassword, newPassword })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-muted-foreground">Loading profile...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
      <h1 className="text-title text-ink-950">Profile</h1>

      {/* Profile Info */}
      <Card className="p-5 space-y-4">
        <h2 className="text-section text-ink-950">Profile Info</h2>

        <form onSubmit={handleProfileSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name" className="text-[11.5px] font-semibold text-ink-950">Name</Label>
            <Input
              id="profile-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              data-testid="profile-name"
            />
          </div>

          {/* P7.4.7 / F-12 — explicit "read-only" badge + actual value
              (no placeholder), so the field is unambiguously not blank.
              Changing email requires re-verification → that's an admin
              flow we'll wire later; for now the path is "ask admin". */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="profile-email" className="text-[11.5px] font-semibold text-ink-950">Email</Label>
              <span className="text-[10px] uppercase tracking-wider text-ink-500">read-only</span>
            </div>
            <Input
              id="profile-email"
              type="email"
              value={profile?.email ?? ''}
              readOnly
              data-testid="profile-email"
              className="bg-paper-50 text-ink-700 cursor-not-allowed select-all"
            />
            <p className="text-[11px] text-muted-foreground">
              Email is your login identifier. Contact an admin to change it.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-avatar" className="text-[11.5px] font-semibold text-ink-950">Avatar</Label>
            <div className="flex items-start gap-3">
              {/* Live preview — initials fallback, or image if URL is valid */}
              <div className="shrink-0">
                <AvatarPreview name={name} url={avatarUrl} email={profile?.email ?? ''} />
              </div>
              <div className="flex-1 space-y-1.5">
                <Input
                  id="profile-avatar"
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://example.com/avatar.png (optional)"
                  data-testid="avatar-url"
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Leave blank to show your initials. Direct image hosting +
                  upload land in v1.1 — for now paste a URL to an image you
                  already host (company intranet, Gravatar, etc.).
                  {avatarUrl && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => setAvatarUrl('')}
                        data-testid="use-initials"
                        className="text-primary hover:underline"
                      >
                        Use initials instead.
                      </button>
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>

          {profileMsg && (
            // Success is neutral here: saving a profile is an acknowledgement, not a
            // binding event. Only failure earns a meaning color.
            <div
              className={`text-dense px-3 py-2 rounded-md border ${
                profileMsg.type === 'success'
                  ? 'bg-paper-100 text-ink-700 border-paper-200'
                  : 'bg-risk-50 text-risk-700 border-risk-200'
              }`}
            >
              {profileMsg.text}
            </div>
          )}

          <Button type="submit" disabled={updateProfile.isPending} data-testid="save-profile-btn">
            {updateProfile.isPending ? 'Saving...' : 'Save Profile'}
          </Button>
        </form>
      </Card>

      {/* My Roles */}
      <Card className="p-5 space-y-3">
        <h2 className="text-section text-ink-950">My Roles</h2>

        <div className="flex flex-wrap gap-2">
          {profile?.roles && profile.roles.length > 0 ? (
            profile.roles.map((role) => <Chip key={role}>{role}</Chip>)
          ) : (
            <p className="text-dense text-muted-foreground">No roles assigned.</p>
          )}
        </div>
      </Card>

      {/* Change Password */}{/*
         AvatarPreview is defined below the component to keep the form
         layout tidy above.
      */}
      <Card className="p-5 space-y-4">
        <h2 className="text-section text-ink-950">Change Password</h2>

        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="old-password" className="text-[11.5px] font-semibold text-ink-950">Current Password</Label>
            <Input
              id="old-password"
              type="password"
              autoComplete="current-password"
              required
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-password" className="text-[11.5px] font-semibold text-ink-950">New Password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password" className="text-[11.5px] font-semibold text-ink-950">Confirm New Password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {passwordMsg && (
            <div
              className={`text-dense px-3 py-2 rounded-md border ${
                passwordMsg.type === 'success'
                  ? 'bg-paper-100 text-ink-700 border-paper-200'
                  : 'bg-risk-50 text-risk-700 border-risk-200'
              }`}
            >
              {passwordMsg.text}
            </div>
          )}

          {/* One primary per view — "Save Profile" above is this page's
              primary. Changing a password is a separate, occasional
              operation in its own card, so it takes the secondary weight
              rather than competing with the page's main action. */}
          <Button type="submit" variant="outline" disabled={changePassword.isPending}>
            {changePassword.isPending ? 'Changing...' : 'Change Password'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

// ─── AvatarPreview (B.6.23) ────────────────────────────────────────────────────

// P7.4.7 / F-16 — Single-name users got "AN" for "Ani" because we
// took the first 2 chars. Now we take ONE letter for single-word
// names (matches Apple, Google, GitHub avatar conventions). Two-word
// names stay first-of-each.
function initialsFrom(name: string, fallback: string): string {
  const pieces = name.trim().split(/\s+/).filter(Boolean)
  if (pieces.length >= 2) return (pieces[0][0] + pieces[pieces.length - 1][0]).toUpperCase()
  if (pieces.length === 1 && pieces[0]) return pieces[0][0].toUpperCase()
  return (fallback[0] ?? 'U').toUpperCase()
}

/*
 * Identity, not meaning. The old hue palette (blue/emerald/amber/violet/rose)
 * spent five of the system's meaning colors on a hash of an email address — an
 * emerald avatar would have read as "binding". The hash still varies the chip so
 * two people don't look identical, but only along the ink/paper ramp.
 */
function colorFromString(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const palette = [
    'bg-paper-100 text-ink-700',
    'bg-paper-200 text-ink-950',
    'bg-ink-950 text-white',
    'bg-paper-100 text-ink-950',
    'bg-paper-300 text-ink-950',
    'bg-ink-700 text-white',
  ]
  return palette[h % palette.length]
}

/**
 * Live avatar preview: image when URL is provided + valid, otherwise
 * a coloured initials circle. Matches the avatar pattern used in the
 * dashboard Recent Activity feed and the delegate picker.
 */
function AvatarPreview({ name, url, email }: { name: string; url: string; email: string }) {
  const [imageOk, setImageOk] = useState(Boolean(url))
  // Reset imageOk when the URL changes so a corrected URL gets a fresh try
  useEffect(() => { setImageOk(Boolean(url)) }, [url])

  const initials = initialsFrom(name, email || 'User')
  const cls = colorFromString(email || name || 'U')

  if (url && imageOk) {
    return (
      <img
        src={url}
        alt={`${name || email}'s avatar`}
        data-testid="avatar-img"
        className="size-16 rounded-full object-cover border border-border"
        onError={() => setImageOk(false)}
      />
    )
  }
  return (
    <div
      data-testid="avatar-initials"
      className={`size-16 rounded-full flex items-center justify-center text-section ${cls}`}
      aria-label={`${name || email}'s avatar — ${initials}`}
    >
      {initials}
    </div>
  )
}
