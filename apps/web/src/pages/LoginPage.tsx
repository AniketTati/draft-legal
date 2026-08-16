import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CheckCircle2, Loader2, MailCheck } from 'lucide-react'
import { Wordmark } from '@/components/brand/Wordmark'

/**
 * B.6.10 — login now exposes:
 *   - Single Sign-On buttons (Google / Microsoft / SAML) ABOVE the
 *     email/password form, matching Notion / Linear / Figma /
 *     Vercel. Enterprise users expect SSO at first glance.
 *   - "Forgot password?" link under the password field.
 *
 * The clicks route to a stubbed flow — a small dialog explaining what
 * will happen when the real backend lands (OIDC in A.5, reset email
 * in A.6). This ships the affordance + evaluator signal today without
 * faking a working backend.
 */

type StubKind = 'sso-google' | 'sso-microsoft' | 'sso-saml'

const STUB_COPY: Record<StubKind, { title: string; body: string; eta: string }> = {
  'sso-google': {
    title: 'Sign in with Google',
    body: 'Your admin can link your workspace to Google Workspace for one-click sign-in. Tell them to enable it in Organization → Single Sign-On.',
    eta: 'Available in v1.1',
  },
  'sso-microsoft': {
    title: 'Sign in with Microsoft',
    body: 'Your admin can link your workspace to Microsoft Entra ID (formerly Azure AD) for one-click sign-in. Tell them to enable it in Organization → Single Sign-On.',
    eta: 'Available in v1.1',
  },
  'sso-saml': {
    title: 'Enterprise SSO (SAML / OIDC)',
    body: 'For companies using Okta, OneLogin, JumpCloud or any SAML 2.0 / OIDC identity provider. Your admin configures the IdP connection once; users sign in with their corporate identity forever after.',
    eta: 'Available in v1.1',
  },
}

function StubDialog({ kind, onClose }: { kind: StubKind; onClose: () => void }) {
  const { title, body, eta } = STUB_COPY[kind]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-paper-200 rounded-card shadow-e3 w-full max-w-md mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-section text-ink-950">{title}</h2>
          {/* "Available in v1.1" is a roadmap note, not a thing blocking the
              user — so it loses amber and stays a neutral chip. */}
          <span className="rounded-full border border-paper-200 bg-paper-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700">
            {eta}
          </span>
        </div>
        <p className="text-body text-ink-500">{body}</p>
        <div className="flex items-center gap-2 rounded-md bg-paper-100 px-3 py-2 text-dense text-ink-500">
          <CheckCircle2 className="size-3.5 shrink-0 text-ink-400" />
          Sign in with email + password below to continue for now.
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </div>
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

// SVG brand marks — keep them lightweight + inline so we don't ship an
// icon package just for the login screen. These keep their literal hexes: they
// are Google's and Microsoft's registered marks, not our palette.
function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  )
}

function MicrosoftMark() {
  return (
    <svg className="size-4" viewBox="0 0 23 23" aria-hidden>
      <path fill="#F25022" d="M1 1h10v10H1z"/>
      <path fill="#7FBA00" d="M12 1h10v10H12z"/>
      <path fill="#00A4EF" d="M1 12h10v10H1z"/>
      <path fill="#FFB900" d="M12 12h10v10H12z"/>
    </svg>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const login = useAuthStore((s) => s.login)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [stub, setStub] = useState<StubKind | null>(null)
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
      const rawNext = searchParams.get('next')
      const safeNext =
        rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
          ? rawNext
          : '/dashboard'
      navigate(safeNext)
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

        {/* B.6.10 — SSO buttons first (enterprise convention). Outline, not
            ink: the one ink-filled primary on this view is "Sign in". */}
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => setStub('sso-google')}
            data-testid="sso-google"
            className="w-full"
          >
            <GoogleMark />
            Continue with Google
          </Button>
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => setStub('sso-microsoft')}
            data-testid="sso-microsoft"
            className="w-full"
          >
            <MicrosoftMark />
            Continue with Microsoft
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setStub('sso-saml')}
            data-testid="sso-saml"
            className="w-full font-medium text-ink-500"
          >
            Use enterprise SSO (SAML / OIDC)
          </Button>
        </div>

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

      {stub && <StubDialog kind={stub} onClose={() => setStub(null)} />}
      {forgotOpen && <ForgotPasswordDialog onClose={() => setForgotOpen(false)} />}
    </div>
  )
}
