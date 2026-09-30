import { useParams, Navigate, Link } from 'react-router-dom'
import { Check, ArrowRight, MessageCircle } from 'lucide-react'
import { industries } from '@/content/industries'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { Button } from '@/components/ui/button'
import { SEO } from '@/lib/seo'
import { APP_URL, SITE_URL } from '@/lib/utils'

export default function IndustryDetail() {
  const { slug } = useParams<{ slug: string }>()
  if (!slug || !industries[slug]) return <Navigate to="/industries" replace />
  const i = industries[slug]

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `Draft Legal for ${i.label}`,
    description: i.intro,
    url: `${SITE_URL}/industries/${i.slug}`,
    provider: { '@type': 'Organization', name: 'Draft Legal' },
    areaServed: i.label,
  }

  return (
    <>
      <SEO
        title={`CLM for ${i.label}`}
        description={i.intro}
        path={`/industries/${i.slug}`}
        schema={schema}
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-3xl">
            <Link to="/industries" className="text-sm font-medium text-slate-500 hover:text-emerald-700">
              ← All industries
            </Link>
            <div className="mt-4 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
              {i.label}
            </div>
            <h1 className="mt-4 heading-display text-slate-900">{i.hero}</h1>
            <p className="mt-6 text-lg leading-8 text-slate-600">{i.intro}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href={`${APP_URL}/register`}>
                  Start free <ArrowRight className="ml-1.5 h-4 w-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to={`/contact?source=industry_${i.slug}`}>Contact us</Link>
              </Button>
            </div>
            <p className="mt-6 text-xs text-slate-500">
              Tested on a synthetic example workspace: {i.persona.org}, {i.persona.size}.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-20">
        <div className="container-page">
          <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-2">
            <div>
              <h2 className="heading-section text-slate-900">
                The contracts {i.label} runs on
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                An illustrative {i.label} contract mix. Draft Legal extracts its own fields for 10
                contract types (NDA, MSA, SOW, DPA and more); anything else, like a BAA or an MTA,
                is filed as Other with the core fields plus any custom fields you add.
              </p>
              <ul className="mt-8 space-y-3">
                {i.contracts.map((c) => (
                  <li
                    key={c.type}
                    className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4"
                  >
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{c.type}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{c.note}</div>
                    </div>
                    <div className="rounded-md bg-emerald-50 px-2.5 py-0.5 text-xs font-mono font-semibold text-emerald-800">
                      {c.share}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="heading-section text-slate-900">
                What you might ask the agent
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Example questions a {i.label} team might ask. The Ask Agent answers from your
                contracts, citing the contracts and clauses it used, and says when an answer rests
                on a sample.
              </p>
              <ul className="mt-8 space-y-3">
                {i.jtbds.map((j) => (
                  <li
                    key={j}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4"
                  >
                    <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span className="text-sm leading-6 text-slate-700">"{j}"</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white py-20">
        <div className="container-page">
          <div className="mx-auto max-w-5xl">
            <h2 className="heading-section text-slate-900">
              Why Draft Legal works for {i.label}
            </h2>
            <ul className="mt-10 grid gap-6 md:grid-cols-2">
              {i.features.map((f) => (
                <li
                  key={f.title}
                  className="rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
                >
                  <h3 className="text-lg font-semibold tracking-tight text-slate-900">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{f.body}</p>
                </li>
              ))}
            </ul>

            <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-8">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {i.label} compliance
              </div>
              <ul className="mt-4 grid gap-3 md:grid-cols-2">
                {i.compliance.map((c) => (
                  <li key={c} className="flex gap-2 text-sm text-slate-700">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CtaStrip
        eyebrow={`Built for ${i.label}`}
        title="See it run on your contracts."
        subtitle="Self-host it, or try the hosted demo (evaluation only)."
      />
    </>
  )
}
