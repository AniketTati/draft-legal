import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Mail, Calendar, Github, ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SEO } from '@/lib/seo'
import { GITHUB_URL } from '@/lib/utils'

export default function Contact() {
  const [params] = useSearchParams()
  const source = params.get('source') ?? 'contact'
  // 'error' surfaces real failures instead of the previous "swallow and show
  // success anyway" pattern — submissions now go to a real Cloud Run endpoint
  // (POST /api/v1/marketing/contact on the app site) that persists to
  // Postgres. CORS on api-service allows the marketing origin.
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    message: '',
  })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setState('submitting')
    setErrorMsg('')
    try {
      // Cross-origin POST to api-service. The app site (https://app.draft-legal.com
      // and the default https://draftlegal-prod-13353.web.app) proxies /api/**
      // to api-service via Firebase Hosting rewrites, so this URL hits Cloud Run
      // directly with no extra DNS or proxy hop. CORS allowlist in api-service
      // accepts requests from this origin.
      const res = await fetch('https://draftlegal-prod-13353.web.app/api/v1/marketing/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, source }),
      })
      if (!res.ok) {
        // Pull a useful message off the response if there is one (zod
        // validation errors, rate-limit, etc.) so the user understands the
        // failure rather than seeing a generic "something went wrong".
        let detail = ''
        try {
          const j = await res.json()
          detail = j?.error ?? ''
        } catch { /* ignore parse errors */ }
        if (res.status === 429) {
          setErrorMsg('Too many submissions from this network. Try again in an hour, or email aniket.tatipamula@gmail.com directly.')
        } else if (res.status === 400) {
          setErrorMsg(detail || 'Please check the fields above and try again.')
        } else {
          setErrorMsg('Something went wrong on our side. Please try again, or email aniket.tatipamula@gmail.com directly.')
        }
        setState('error')
        return
      }
      setState('done')
    } catch {
      // Network failure (offline, DNS, CORS). Tell the user the truth.
      setErrorMsg('Could not reach our server. Check your connection or email aniket.tatipamula@gmail.com directly.')
      setState('error')
    }
  }

  return (
    <>
      <SEO
        title="Contact"
        description="Talk to the Draft Legal team about your CLM workflows, security review, migration from another vendor, or open-source contributions."
        path="/contact"
      />

      <section className="bg-white py-20 md:py-28">
        <div className="container-page">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                Contact
              </div>
              <h1 className="mt-3 heading-display text-slate-900">
                Tell us about your contracts.
              </h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                The fastest way to get answers depends on what you need. Most teams just{' '}
                <a
                  href="https://app.draft-legal.com/register"
                  className="font-semibold text-emerald-700 underline underline-offset-4"
                >
                  start free
                </a>{' '}
                — but if you'd rather talk first, we read every form.
              </p>

              <ul className="mt-10 space-y-5">
                <li className="flex gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                    <Mail className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Email</div>
                    <a
                      href="mailto:aniket.tatipamula@gmail.com"
                      className="text-sm text-slate-600 hover:text-emerald-700"
                    >
                      aniket.tatipamula@gmail.com
                    </a>
                  </div>
                </li>
                <li className="flex gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                    <Calendar className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Book a 30-min demo</div>
                    <a
                      href="https://cal.com/draft-legal/demo"
                      className="text-sm text-slate-600 hover:text-emerald-700"
                    >
                      Pick a time on the founder's calendar
                    </a>
                  </div>
                </li>
                <li className="flex gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                    <Github className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-slate-900">Open source questions</div>
                    <a
                      href={`${GITHUB_URL}/discussions`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-slate-600 hover:text-emerald-700"
                    >
                      GitHub Discussions
                    </a>
                  </div>
                </li>
              </ul>
            </div>

            <div className="lg:col-span-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                {state === 'done' ? (
                  <div className="grid place-items-center py-16 text-center">
                    <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-50 text-emerald-700">
                      <Check className="h-6 w-6" />
                    </span>
                    <h2 className="mt-5 text-xl font-bold text-slate-900">
                      Thanks — we've got your message.
                    </h2>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">
                      We'll reply by email. In the meantime, the full product is on GitHub if you
                      want to look around.
                    </p>
                  </div>
                ) : (
                  <form onSubmit={submit} className="space-y-5">
                    {source !== 'contact' && (
                      <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
                        Source: {source.replace(/_/g, ' ')}
                      </div>
                    )}

                    <Field label="Your name">
                      <input
                        required
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        className="input-field"
                        placeholder="Maya Chen"
                      />
                    </Field>
                    <Field label="Work email">
                      <input
                        required
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        className="input-field"
                        placeholder="maya@vertex.cloud"
                      />
                    </Field>
                    <Field label="Company">
                      <input
                        value={form.company}
                        onChange={(e) => setForm({ ...form, company: e.target.value })}
                        className="input-field"
                        placeholder="Vertex Cloud"
                      />
                    </Field>
                    <Field label="What brings you here?">
                      <textarea
                        rows={4}
                        value={form.message}
                        onChange={(e) => setForm({ ...form, message: e.target.value })}
                        className="input-field"
                        placeholder="We process ~150 NDAs and MSAs/quarter and we are looking at draftLegal to consolidate the workflow."
                      />
                    </Field>

                    {state === 'error' && errorMsg && (
                      <div
                        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                        role="alert"
                        data-testid="contact-form-error"
                      >
                        {errorMsg}
                      </div>
                    )}

                    <Button type="submit" size="lg" disabled={state === 'submitting'} className="w-full">
                      {state === 'submitting' ? 'Sending…' : 'Send message'}
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                    <p className="text-xs text-slate-500">
                      We use this only to respond to you. No marketing emails without consent.
                    </p>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <style>{`
        .input-field {
          display: block; width: 100%;
          border: 1px solid rgb(203 213 225); border-radius: 0.5rem;
          background: white; padding: 0.625rem 0.875rem;
          font-size: 0.875rem; color: rgb(15 23 42);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input-field::placeholder { color: rgb(148 163 184); }
        .input-field:focus {
          outline: none; border-color: rgb(4 120 87);
          box-shadow: 0 0 0 3px rgba(4,120,87,0.12);
        }
      `}</style>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-800">{label}</span>
      {children}
    </label>
  )
}
