import { Link } from 'react-router-dom'
import { ArrowRight, FileText } from 'lucide-react'
import { templates } from '@/content/templates'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'

export default function TemplatesHub() {
  return (
    <>
      <SEO
        title="Contract Template Guides"
        description="Plain-English guides to the key clauses in NDAs, MSAs and DPAs, with more contract types on the way. Or draft one from your own template in Draft Legal."
        path="/templates"
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-3xl text-center">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Template guides
            </div>
            <h1 className="mt-3 heading-display text-slate-900">
              Contract templates, explained.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              Plain-English clause guides, with downloadable templates to follow. Or draft one from
              your own template in Draft Legal.
            </p>
            <p className="mx-auto mt-3 max-w-xl text-xs leading-6 text-slate-500">
              These templates are general-purpose starting points, not legal advice. Always have a
              real lawyer review a contract before you sign it.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="container-page">
          <ul className="mx-auto grid max-w-5xl gap-5 md:grid-cols-2 lg:grid-cols-3">
            {Object.values(templates).map((t) => (
              <li
                key={t.slug}
                className="group rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <Link to={`/templates/${t.slug}`} className="block">
                  <span className="grid h-10 w-10 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                    <FileText className="h-5 w-5" />
                  </span>
                  <h2 className="mt-5 text-lg font-bold tracking-tight text-slate-900 group-hover:text-emerald-700">
                    {t.title}
                  </h2>
                  <p className="mt-2 text-xs uppercase tracking-wide text-slate-500">
                    For {t.audience}
                  </p>
                  <p className="mt-3 text-sm leading-6 text-slate-600 line-clamp-3">{t.tldr}</p>
                  <div className="mt-5 inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    Read the guide <ArrowRight className="h-3 w-3" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CtaStrip
        eyebrow="Skip the template"
        title="Draft from your own templates."
        subtitle="Draft Legal's Draft Agent fills your template from the request and your counterparty records, and flags the terms it couldn't fill."
      />
    </>
  )
}
