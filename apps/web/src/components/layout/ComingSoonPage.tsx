/**
 * ComingSoonPage — shared layout for stubbed features that are routable
 * but not yet built out.
 *
 * JTBD: "I followed a link to /analytics or /signatures — help me
 * understand what this feature does, when it's coming, and how to get
 * back to the app. Don't strand me."
 *
 * Used by AnalyticsPage + SignaturesPage. B.6.2.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, BellPlus, CheckCircle2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ComingSoonPageProps {
  icon: LucideIcon
  title: string
  /** One-sentence description of what this feature does. */
  description: string
  /** Bullet list of concrete capabilities. Shown under the description. */
  capabilities?: string[]
  /** Short label like "Launching in v1.1" or "Q2 2026". */
  eta?: string
  /** localStorage key used to remember that the user signed up for notify. */
  notifyKey: string
}

export function ComingSoonPage({
  icon: Icon,
  title,
  description,
  capabilities,
  eta,
  notifyKey,
}: ComingSoonPageProps) {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(notifyKey) !== null
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    // For now, localStorage only. Wire to API in v1.1.
    localStorage.setItem(notifyKey, trimmed)
    setSubmitted(true)
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-card border border-paper-200 bg-card p-8 shadow-e1">
        <div className="mb-4 inline-flex size-12 items-center justify-center rounded-md bg-paper-100 text-ink-700">
          <Icon className="size-6" />
        </div>

        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-title text-ink-950">{title}</h1>
          {eta && (
            // A ship date blocks nobody — it is a neutral fact, not "your turn".
            <span className="rounded-full border border-paper-200 bg-paper-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-700">
              {eta}
            </span>
          )}
        </div>

        <p className="text-body text-ink-500">{description}</p>

        {capabilities && capabilities.length > 0 && (
          <ul className="mt-4 space-y-2 text-body text-ink-950">
            {capabilities.map((c) => (
              <li key={c} className="flex items-start gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-400" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 rounded-md border border-dashed border-paper-300 bg-paper-50 p-4">
          {submitted ? (
            // A promise to email later is a neutral fact, not a binding event —
            // the checkmark carries it without spending the brand color.
            <div className="flex items-center gap-2 text-body text-ink-700">
              <CheckCircle2 className="size-4 text-ink-400" />
              We&rsquo;ll email you as soon as {title.toLowerCase()} ships.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-2">
              <label htmlFor="notify-email" className="flex items-center gap-2 text-body font-medium text-ink-950">
                <BellPlus className="size-4" />
                Notify me when this launches
              </label>
              <div className="flex gap-2">
                <Input
                  id="notify-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="flex-1"
                />
                <Button type="submit" size="sm">
                  Notify me
                </Button>
              </div>
            </form>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-paper-200 pt-4 text-body">
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-ink-500 hover:text-ink-950 transition-colors"
          >
            <ArrowLeft className="size-4" />
            Back to dashboard
          </Link>
          <span className="text-dense text-ink-500">
            Questions?{' '}
            <a
              href="mailto:support@clmplatform.test"
              className="text-ink-950 underline underline-offset-2 decoration-paper-300 hover:text-brand-700 hover:decoration-brand-700"
            >
              Contact us
            </a>
          </span>
        </div>
      </div>
    </div>
  )
}
