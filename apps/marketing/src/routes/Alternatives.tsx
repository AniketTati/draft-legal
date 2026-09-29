import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { compareData } from '@/content/compare'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'
import { SITE_URL } from '@/lib/utils'

const itemListSchema = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'CLM Alternatives — Draft Legal comparisons',
  itemListElement: Object.values(compareData).map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: `Draft Legal vs ${c.competitorName}`,
    url: `${SITE_URL}/compare/${c.slug}`,
  })),
}

export default function Alternatives() {
  return (
    <>
      <SEO
        title="CLM Alternatives — neutral comparisons"
        description="Comparing Ironclad, Harvey, Spellbook, DocuSign CLM, or Icertis against an open-source alternative? draftLegal is AGPL-3.0 licensed CLM you can self-host and audit. Neutral head-to-head pages on each."
        path="/alternatives"
        schema={itemListSchema}
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-3xl text-center">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Alternatives
            </div>
            <h1 className="mt-3 heading-display text-slate-900">
              Looking for a CLM that's open?
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              Neutral head-to-head comparisons against the major contract management vendors. We
              only compare on dimensions that are publicly verifiable — openness, deployment
              posture, AI extensibility — and we call out where each vendor is the better choice
              for your situation.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="container-page">
          <ul className="mx-auto grid max-w-5xl gap-5 md:grid-cols-2">
            {Object.values(compareData).map((c) => (
              <li
                key={c.slug}
                className="group rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md md:p-8"
              >
                <Link to={`/compare/${c.slug}`} className="block">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-xl font-bold tracking-tight text-slate-900 group-hover:text-emerald-700">
                      Draft Legal vs {c.competitorName}
                    </h2>
                    <ArrowRight className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-1 group-hover:text-emerald-700" />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600 line-clamp-3">{c.tldr}</p>
                  <div className="mt-5 inline-flex rounded-md bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                    Read comparison →
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CtaStrip
        eyebrow="The simplest path"
        title="Try Draft Legal yourself."
        subtitle="No demo call required. Self-host it in 3 commands, or try the hosted demo (evaluation only)."
      />
    </>
  )
}
