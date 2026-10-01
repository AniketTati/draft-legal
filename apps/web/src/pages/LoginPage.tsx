import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KeyRound, Loader2, MailCheck } from 'lucide-react'
import { Wordmark } from '@/components/brand/Wordmark'

/**
 * B.6.10 — single sign-on first (the enterprise convention), then email and
 * password, with "Forgot password?" under the password field.
 *
 * docs/41 Part 20 — "Sign in with SSO" is real now: the user gives their work
 * email, and if their company's domain has single sign-on set up (Settings →
 * Integrations → Single sign-on) the browser goes to its identity provider
 * (Okta, Entra ID, Google Workspace…). Password sign-in stays, so a broken
 * provider setup never locks anyone out.
 */

/** Ask the API whether this email's domain signs in with SSO, and go there if so. */
function SsoPanel({ initialEmail, next, onClose }: { initialEmail: string; next: string; onClose: () => void }) {
  const [email, setEmail] = useState(initialEmail)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setMessage('Enter your work email.')
      return
    }
    setPending(true)
    setMessage('')
    try {
      const { data } = await api.post('/auth/sso/discover', { email: email.trim(), next })
      if (data.sso && data.startUrl) {
        window.location.assign(data.startUrl)
        return
      }
      const domain = email.trim().split('@')[1]
      setMessage(`Single sign-on isn't set up for ${domain}. Sign in with your password, or ask your admin.`)
    } catch {
      setMessage('Couldn\'t check single sign-on. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-paper-200 bg-paper-50 p-3" data-testid="sso-panel">
      <Label htmlFor="sso-email">Work email</Label>
      <Input
        id="sso-email"
        type="email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        data-testid="sso-email"
      />
      {message && <p className="text-dense text-ink-700" data-testid="sso-message">{message}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
        <Button type="submit" size="sm" disabled={pending || !email} data-testid="sso-continue">
          {pending ? <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Checking…</span> : 'Continue'}
        </Button>
      </div>
    </form>
  )
}

/**
 * U.6.3 — real "forgot password" round-trip.
 *
 * Until full email-based reset lands (A.6), this dialog notifies every
 * admin in the user's org via the in-app notification system. The user
 * gets one definitive answer ("if an account exists, your admin's been
 * notified") rather than a stub modal that just says "ask your admin".
 */
function ForgotPasswordDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErrorMsg('Please enter a valid email address.')
      return
    }
    setErrorMsg('')
    setPending(true)
    try {
      await api.post('/auth/request-password-reset', { email: email.trim() })
      setDone(true)
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 400) {
        setErrorMsg('Please enter a valid email address.')
      } else {
        setErrorMsg('Couldn\'t send the request. Please try again or contact your admin directly.')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-paper-200 rounded-card shadow-e3 w-full max-w-md mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="forgot-password-dialog"
      >
        {done ? (
          <>
            <div className="flex items-center gap-2">
              {/* A password-reset request isn't binding, so this glyph stays
                  ink — emerald is reserved for approved/executed/signed. */}
              <MailCheck className="size-4 text-ink-700" />
              <h2 className="text-section text-ink-950">Request sent</h2>
            </div>
            <p className="text-body text-ink-500">
              If an account exists for <span className="font-medium text-ink-950">{email}</span>,
              your administrator has been notified. They&apos;ll send you a new temporary password — usually within a few hours.
            </p>
            <div className="rounded-md bg-paper-100 px-3 py-2 text-dense text-ink-500">
              Tip: still no email after a day? Reach out to your admin directly. We don&apos;t reveal whether an email is registered, so this prompt looks the same either way.
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={onClose} data-testid="forgot-password-close">
                Back to sign in
              </Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <h2 className="text-section text-ink-950">Reset your password</h2>
              <p className="text-dense text-ink-500 mt-1">
                Enter your work email and we&apos;ll notify your admin to send a new temporary password.
              </p>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  data-testid="forgot-password-email"
                  autoFocus
                />
              </div>
              {errorMsg && <p className="text-dense text-risk-700" data-testid="forgot-password-error">{errorMsg}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={pending || !email} data-testid="forgot-password-submit">
                  {pending ? (
                    <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Sending…</span>
                  ) : (
                    'Notify my admin'
                  )}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

/** Only an in-app path: an attacker's ?next= can't send a signed-in user elsewhere. */
function safeNext(rawNext: string | null): string {
  return rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard'
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const login = useAuthStore((s) => s.login)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [ssoOpen, setSsoOpen] = useState(false)
  const [forgotOpen, setForgotOpen] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      // B.6.20 — restore intended URL (from ?next=…) when present.
      // Only accept same-origin paths; anything else falls back to
      // /dashboard so an attacker can't craft a redirect-to-external
      // phishing link.
      navigate(safeNext(searchParams.get('next')))
    } catch {
      setError('Invalid email or password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-50">
      <div className="w-full max-w-sm space-y-6 p-8 border border-paper-200 rounded-card bg-card shadow-e1">
        {/* P7.4.9 / F-06 — wordmark above the form. Trust signal +
            consistent brand identity across login / register / portal. */}
        <div className="flex flex-col items-center text-center" data-testid="login-brand">
          <div className="mb-4">
            {/* Wordmark stands alone — single confident statement. The
                color/weight split carries the brand without an icon
                competing for attention. Sized off the scale rather than at
                text-display: the card is 320px of content and the 52px
                display step would fill it edge to edge. */}
            <Wordmark size="xl" className="text-[28px]" />
          </div>
          <h1 className="text-title text-ink-950">Sign in</h1>
          <p className="text-body text-ink-500 mt-0.5">Welcome back — please enter your details.</p>
        </div>

        {/* B.6.10 — SSO first (enterprise convention). Outline, not ink: the
            one ink-filled primary on this view is "Sign in". */}
        {ssoOpen ? (
          <SsoPanel initialEmail={email} next={safeNext(searchParams.get('next'))} onClose={() => setSsoOpen(false)} />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => setSsoOpen(true)}
            data-testid="sso-start"
            className="w-full"
          >
            <KeyRound />
            Sign in with SSO
          </Button>
        )}

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-paper-200" />
          </div>
          <div className="relative flex justify-center text-eyebrow uppercase">
            <span className="bg-card px-2 text-ink-400">or</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              data-testid="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <button
                type="button"
                onClick={() => setForgotOpen(true)}
                data-testid="forgot-password-link"
                className="text-dense text-ink-950 underline-offset-2 hover:underline"
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="password"
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-body text-risk-700">{error}</p>
          )}

          <Button type="submit" size="md" data-testid="login-submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-body text-center text-ink-500">
          No account?{' '}
          <Link to="/register" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
            Create one
          </Link>
        </p>
      </div>

      {forgotOpen && <ForgotPasswordDialog onClose={() => setForgotOpen(false)} />}
    </div>
  )
}
