import { useParams, Link, Navigate } from 'react-router-dom'
import { Check, X, ArrowRight } from 'lucide-react'
import { compareData } from '@/content/compare'
import { ComparisonTable } from '@/components/compare/ComparisonTable'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { BrowserFrame } from '@/components/sections/BrowserFrame'
import { SEO } from '@/lib/seo'
import { Button } from '@/components/ui/button'
import { APP_URL, SITE_URL } from '@/lib/utils'

// When the competitor details on these pages were last checked against their
// public materials. Used as the article's publish date.
const LAST_CHECKED = { iso: '2026-05-01', label: 'May 2026' }

export default function ComparePage() {
  const { slug } = useParams<{ slug: string }>()
  if (!slug || !compareData[slug]) {
    return <Navigate to="/alternatives" replace />
  }
  const data = compareData[slug]

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `Draft Legal vs ${data.competitorName}`,
    description: data.tldr,
    url: `${SITE_URL}/compare/${data.slug}`,
    author: { '@type': 'Organization', name: 'Draft Legal' },
    datePublished: LAST_CHECKED.iso,
  }

  return (
    <>
      <SEO
        title={`Draft Legal vs ${data.competitorName}`}
        description={`Honest head-to-head: Draft Legal vs ${data.competitorName}. Lifecycle coverage, openness, AI capabilities, pricing.`}
        path={`/compare/${data.slug}`}
        schema={articleSchema}
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-4xl">
            <Link to="/alternatives" className="text-sm font-medium text-slate-500 hover:text-emerald-700">
              ← All comparisons
            </Link>
            <h1 className="mt-4 heading-display text-slate-900">
              Draft Legal vs <span className="text-emerald-700">{data.competitorName}</span>
            </h1>

            <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 md:p-8">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                TL;DR
              </div>
              <p className="mt-2 text-base leading-7 text-slate-800">{data.tldr}</p>
            </div>

            <p className="mt-6 text-base leading-7 text-slate-600">
              <strong className="text-slate-900">{data.competitorName}:</strong>{' '}
              {data.competitorOneLiner}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Last checked: {LAST_CHECKED.label}. Details about {data.competitorName} may have
              changed since.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 pb-12 pt-6">
        <div className="container-page">
          <div className="mx-auto max-w-5xl">
            <div className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
              This is what Draft Legal looks like
            </div>
            <BrowserFrame
              src="/product/dashboard.png"
              alt="Draft Legal dashboard"
              shadow="lifted"
              url="app.draft-legal.com/dashboard"
            />
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="container-page">
          <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-white p-6 md:p-8">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-emerald-700 text-white">
                  <Check className="h-4 w-4" />
                </span>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">
                  Pick Draft Legal if
                </h2>
              </div>
              <ul className="mt-5 space-y-3 text-sm text-slate-700">
                {data.pickDraftLegalIf.map((p) => (
                  <li key={p} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 md:p-8">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-slate-200 text-slate-700">
                  <X className="h-4 w-4" />
                </span>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">
                  Pick {data.competitorName} if
                </h2>
              </div>
              <ul className="mt-5 space-y-3 text-sm text-slate-700">
                {data.pickCompetitorIf.map((p) => (
                  <li key={p} className="flex gap-2">
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                    <span>{p}</span>
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
            <h2 className="heading-section text-slate-900">Feature-by-feature comparison</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Compiled from each vendor's public documentation. Where data isn't public,
              we mark "unknown" rather than guess. Spot something wrong?{' '}
              <a
                href="/contact?source=compare_correction"
                className="font-semibold text-emerald-700 underline underline-offset-4"
              >
                Tell us
              </a>
              .
            </p>
            <div className="mt-8">
              <ComparisonTable groups={data.groups} competitorName={data.competitorName} />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-20">
        <div className="container-page">
          <div className="mx-auto max-w-3xl">
            <h2 className="heading-section text-slate-900">
              Migrating from {data.competitorName}
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-700">{data.migration}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild>
                <a href={`${APP_URL}/register`}>
                  Try Draft Legal free <ArrowRight className="ml-1.5 h-4 w-4" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={`/contact?source=migrate_${data.slug}`}>
                  Talk to us
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <CtaStrip
        eyebrow="Honest comparisons"
        title="See how Draft Legal stacks up."
        subtitle="Five head-to-head comparisons, each saying when the other product is the better choice."
      />
    </>
  )
}
