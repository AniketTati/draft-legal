import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, AlertCircle, Mail, Building2 } from 'lucide-react'

interface InvitePreview {
  email: string
  orgName: string
}

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // P7.4.8 / F-09 — pre-validate the token on mount. Same UX pattern
  // as /portal/:token + /sign/:token (audit's gold standard). On
  // invalid/expired we render the error state instead of pretending
  // everything's fine until submit.
  const preview = useQuery<InvitePreview>({
    queryKey: ['invite-preview', token],
    queryFn: async () => {
      const { data } = await axios.get(`/api/v1/auth/invites/${token}`)
      return data
    },
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  })

  const acceptInvite = useMutation({
    mutationFn: async (body: { token: string; password: string; name?: string }) => {
      const { data } = await axios.post('/api/v1/auth/accept-invite', body)
      return data
    },
    onSuccess: () => {
      setSuccess(true)
      setTimeout(() => navigate('/login'), 2000)
    },
    onError: (err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.data?.message) {
        setError(err.response.data.message)
      } else {
        setError('Failed to accept invite. The link may be expired or invalid.')
      }
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (!token) {
      setError('Invalid invite link.')
      return
    }

    acceptInvite.mutate({
      token,
      password,
      name: name.trim() || undefined,
    })
  }

  // ── Loading: show a spinner while we validate the token, NOT the
  // form. Otherwise the user could fill in a password before we tell
  // them the link is bad.
  if (preview.isLoading) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-8 gap-3" data-testid="invite-loading">
          <Loader2 className="size-5 text-ink-400 animate-spin" />
          <p className="text-body text-ink-500">Validating invite…</p>
        </div>
      </Shell>
    )
  }

  // ── Invalid / expired / already-used — single bucket per security
  // practice: don't leak which one it is.
  if (preview.isError) {
    return (
      <Shell>
        <div className="flex flex-col items-center text-center gap-3 py-4" data-testid="invite-invalid">
          {/* Expiry is one of the meanings risk is actually for. */}
          <div className="size-12 rounded-full bg-risk-50 flex items-center justify-center">
            <AlertCircle className="size-6 text-risk-600" />
          </div>
          <h1 className="text-title text-ink-950">Invalid or expired invite</h1>
          <p className="text-body text-ink-500 max-w-xs">
            This invite link is no longer valid. It may have been used already,
            expired, or the URL is incorrect. Ask your admin to send a new one.
          </p>
          <Link to="/login" className="text-body text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700 mt-2">
            Go to sign in
          </Link>
        </div>
      </Shell>
    )
  }

  // ── Valid token — show inviter context above the form.
  const data = preview.data!

  return (
    <Shell>
      <div data-testid="invite-valid">
        <h1 className="text-title text-ink-950">Accept Invite</h1>
        <p className="text-body text-ink-500 mt-1">Set up your account to join draftLegal</p>

        {/* Inviter context — F-09 explicit ask: tell the user what
            they're accepting into BEFORE they fill the form. Both icons are
            quiet ink: they label facts, they don't carry a state. */}
        <div className="mt-4 rounded-md border border-paper-200 bg-paper-50 px-3.5 py-3 space-y-1.5">
          <div className="flex items-center gap-2 text-dense text-ink-700">
            <Building2 className="size-3.5 text-ink-400" />
            <span>You're joining</span>
            <span className="font-semibold text-ink-950" data-testid="invite-org">{data.orgName}</span>
          </div>
          <div className="flex items-center gap-2 text-dense text-ink-700">
            <Mail className="size-3.5 text-ink-400" />
            <span>as</span>
            <span className="font-mono text-ink-950" data-testid="invite-email">{data.email}</span>
          </div>
        </div>

        {success ? (
          // Accepted — the invite is now binding, which is what brand means.
          <div className="mt-5 text-body px-3 py-2 rounded-md bg-brand-50 text-brand-700 border border-brand-200">
            Invite accepted! Redirecting to login…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-name">Your name <span className="text-ink-500 font-normal">(optional)</span></Label>
              <Input
                id="invite-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-password">Password</Label>
              <Input
                id="invite-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-confirm">Confirm Password</Label>
              <Input
                id="invite-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
              />
            </div>

            {error && (
              <p className="text-body text-risk-700" data-testid="invite-error">{error}</p>
            )}

            <Button type="submit" size="md" className="w-full" disabled={acceptInvite.isPending}>
              {acceptInvite.isPending ? 'Accepting…' : 'Accept invite'}
            </Button>
          </form>
        )}

        <p className="text-body text-center text-ink-500 mt-5">
          Already have an account?{' '}
          <Link to="/login" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </Shell>
  )
}

// Shared chrome — keeps the loading / error / form states visually
// consistent with the same card framing.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-50">
      <div className="w-full max-w-sm space-y-6 p-8 border border-paper-200 rounded-card bg-card shadow-e1">
        {children}
      </div>
    </div>
  )
}
