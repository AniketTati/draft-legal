/**
 * docs/41 Part 20 — where single sign-on lands. The API sends the browser
 * here after the identity provider, with a one-time `code` (or an `error`);
 * this page trades the code for the session, as the password form does, and
 * goes on to where the user was headed.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { Wordmark } from '@/components/brand/Wordmark'

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard'
}

export function SsoCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(params.get('error'))
  const started = useRef(false)

  useEffect(() => {
    const code = params.get('code')
    if (!code || started.current) return
    // React's development double-run would spend the one-time code twice.
    started.current = true
    axios.post('/api/v1/auth/sso/exchange', { code })
      .then(({ data }) => {
        useAuthStore.setState({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken, isAuthenticated: true })
        navigate(safeNext(params.get('next')), { replace: true })
      })
      .catch(err => setError((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Single sign-on failed. Try again.'))
  }, [params, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-50">
      <div className="w-full max-w-sm space-y-5 p-8 border border-paper-200 rounded-card bg-card shadow-e1 text-center" data-testid="sso-callback">
        <Wordmark size="xl" className="text-[28px]" />
        {error ? (
          <>
            <h1 className="text-title text-ink-950">Couldn&apos;t sign you in</h1>
            <p className="text-body text-risk-700" data-testid="sso-error">{error}</p>
            <Link to="/login" className="inline-block text-body text-ink-950 underline underline-offset-2 decoration-paper-300 hover:decoration-brand-700 hover:text-brand-700">
              Back to sign in
            </Link>
          </>
        ) : (
          <p className="text-body text-ink-500 inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Signing you in…
          </p>
        )}
      </div>
    </div>
  )
}
