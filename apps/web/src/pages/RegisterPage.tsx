/**
 * RegisterPage — B.6.14 adds three enterprise-hygiene affordances:
 *  - Password strength indicator (bar + label, updates live)
 *  - Confirm-password field with inline mismatch warning
 *  - Terms + Privacy checkbox, unchecked by default
 *
 * References: 1Password / Bitwarden (strength meter), GitHub / Stripe
 * (confirm field), Notion / Linear / Vercel (terms checkbox).
 *
 * The strength scoring is intentionally simple — length + character-
 * class variety — so the indicator reads deterministically without
 * shipping a password-dict dependency.
 */
import { useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

// ─── Password strength (simple, deterministic) ────────────────────────────────

interface Strength {
  score: 0 | 1 | 2 | 3 | 4     // 0 = empty, 1 = weak, 4 = very strong
  label: string
  reasons: string[]            // what the user is missing — for hints
}

function scorePassword(pw: string): Strength {
  if (!pw) return { score: 0, label: '', reasons: [] }

  let points = 0
  const reasons: string[] = []

  if (pw.length >= 8) points += 1
  else reasons.push('at least 8 characters')

  if (pw.length >= 12) points += 1
  else if (pw.length >= 8) reasons.push('12+ characters for stronger')

  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) points += 1
  else reasons.push('mixed upper + lower case')

  if (/\d/.test(pw)) points += 1
  else reasons.push('a number')

  if (/[^A-Za-z0-9]/.test(pw)) points += 1
  else reasons.push('a symbol')

  // Map 0-5 raw points onto the 4-step bar
  const score = Math.min(4, Math.max(1, Math.floor(points * 0.8))) as 1 | 2 | 3 | 4
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][score]
  return { score, label, reasons }
}

/*
 * The strength bar is the one place on this page that earns color, and it maps
 * onto the meaning scale rather than a traffic light: a weak password is real
 * exposure (risk), a fair one is the user's turn to improve (attention), and a
 * good/strong one is "healthy" — the only sense in which the brand green is
 * allowed outside binding states.
 */
const STRENGTH_COLORS = ['', 'bg-risk-600', 'bg-attention-600', 'bg-brand-500', 'bg-brand-700']
const STRENGTH_TEXT = ['', 'text-risk-700', 'text-attention-700', 'text-brand-700', 'text-brand-700']

// ─── Component ─────────────────────────────────────────────────────────────────

export function RegisterPage() {
  const navigate = useNavigate()
  const register = useAuthStore((s) => s.register)

  const [form, setForm] = useState({
    orgName: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const strength = useMemo(() => scorePassword(form.password), [form.password])
  const passwordsMatch =
    form.password.length > 0 &&
    form.confirmPassword.length > 0 &&
    form.password === form.confirmPassword

  const confirmMismatch =
    form.confirmPassword.length > 0 && form.confirmPassword !== form.password

  const canSubmit =
    !!form.orgName.trim() &&
    !!form.name.trim() &&
    !!form.email.trim() &&
    strength.score >= 2 && // ≥ Fair
    passwordsMatch &&
    termsAccepted &&
    !loading

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setLoading(true)
    try {
      await register({
        orgName: form.orgName,
        name: form.name,
        email: form.email,
        password: form.password,
      })
      navigate('/dashboard')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg ?? 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-50 py-10">
      <div className="w-full max-w-sm space-y-6 p-8 border border-paper-200 rounded-card bg-card shadow-e1">
        <div>
          <h1 className="text-title text-ink-950">Create account</h1>
          <p className="text-body text-ink-500 mt-1">Set up your CLM workspace</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="orgName">Company name</Label>
            <Input
              id="orgName"
              name="orgName"
              type="text"
              required
              autoComplete="organization"
              value={form.orgName}
              onChange={handleChange}
              placeholder="Acme Corp"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              name="name"
              type="text"
              required
              autoComplete="name"
              value={form.name}
              onChange={handleChange}
              placeholder="Jane Smith"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={form.email}
              onChange={handleChange}
              placeholder="jane@acme.com"
            />
          </div>

          {/* Password + live strength indicator */}
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.password}
              onChange={handleChange}
              placeholder="••••••••"
              aria-describedby="password-strength"
            />
            {form.password.length > 0 && (
              <div id="password-strength" className="pt-1 space-y-1" data-testid="password-strength">
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex gap-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i <= strength.score ? STRENGTH_COLORS[strength.score] : 'bg-paper-100'
                        }`}
                      />
                    ))}
                  </div>
                  <span className={`text-dense font-medium tabular-nums ${STRENGTH_TEXT[strength.score]}`}>
                    {strength.label}
                  </span>
                </div>
                {strength.score < 3 && strength.reasons.length > 0 && (
                  <p className="text-[11px] text-ink-500">
                    Add: {strength.reasons.slice(0, 3).join(' · ')}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Confirm password. No invalid-state className here — Input derives
              its risk border and focus halo from aria-[invalid=true]. */}
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={handleChange}
              placeholder="••••••••"
              data-testid="confirm-password"
              aria-invalid={confirmMismatch}
              aria-describedby={confirmMismatch ? 'confirm-mismatch' : undefined}
            />
            {confirmMismatch ? (
              <p id="confirm-mismatch" className="flex items-center gap-1 text-dense text-risk-700">
                <AlertCircle className="size-3" />
                Passwords don&rsquo;t match
              </p>
            ) : passwordsMatch ? (
              // "Verified" is one of the few non-legal senses the brand green
              // keeps — the two fields have actually been checked against
              // each other, so this is a result, not decoration.
              <p className="flex items-center gap-1 text-dense text-brand-700">
                <CheckCircle2 className="size-3" />
                Passwords match
              </p>
            ) : null}
          </div>

          {/* Terms + privacy */}
          <label className="flex items-start gap-2 text-dense text-ink-500 cursor-pointer">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              data-testid="terms-checkbox"
              className="mt-0.5 size-3.5 rounded-chip border-input text-ink-950 focus:ring-ink-950"
              required
            />
            <span className="leading-snug">
              I agree to the{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
                Privacy Policy
              </a>
              .
            </span>
          </label>

          {error && <p className="text-body text-risk-700">{error}</p>}

          <Button type="submit" size="md" className="w-full" disabled={!canSubmit}>
            {loading ? 'Creating…' : 'Create account'}
          </Button>
        </form>

        <p className="text-body text-center text-ink-500">
          Already have an account?{' '}
          <Link to="/login" className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
