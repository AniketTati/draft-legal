import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { learnArticles, stubLearnEntry } from '@/content/learn'
import { learnSlugs } from '@/lib/routes'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'

const titleCase = (s: string) =>
  s
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Nda|Msa|Dpa|Baa|Sow|Mta|Clm/g, (m) => m.toUpperCase())

export default function LearnHub() {
  const articles = learnSlugs.map((slug) => learnArticles[slug] ?? stubLearnEntry(slug))

  const grouped: Record<string, typeof articles> = {
    Concept: [],
    'Contract type': [],
    Process: [],
  }
  articles.forEach((a) => {
    grouped[a.category]?.push(a)
  })

  return (
    <>
      <SEO
        title="Learn — CLM glossary and explainers"
        description="Plain-English guides to contract lifecycle management, AI contract review, redlining, clause libraries, and the contract types every legal team handles."
        path="/learn"
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-3xl text-center">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Learn
            </div>
            <h1 className="mt-3 heading-display text-slate-900">
              CLM glossary, in plain English.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              Concepts, processes, and contract types every legal, sales-ops, and procurement
              team should know. Written for people who don't need yet another generic primer.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 py-16">
        <div className="container-page">
          <div className="mx-auto max-w-5xl space-y-14">
            {Object.entries(grouped).map(([category, items]) =>
              items.length === 0 ? null : (
                <div key={category}>
                  <h2 className="text-xl font-bold tracking-tight text-slate-900">
                    {category === 'Concept' ? 'Concepts' : category === 'Process' ? 'Processes' : 'Contract types'}
                  </h2>
                  <ul className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((a) => (
                      <li
                        key={a.slug}
                        className="group rounded-xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md"
                      >
                        <Link to={`/learn/${a.slug}`} className="block">
                          <div className="flex items-start justify-between gap-3">
                            <h3 className="text-base font-semibold tracking-tight text-slate-900 group-hover:text-emerald-700">
                              {titleCase(a.slug)}
                            </h3>
                            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 group-hover:text-emerald-700" />
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600 line-clamp-2">
                            {a.tldr}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </div>
        </div>
      </section>

      <CtaStrip
        eyebrow="Stop reading. Start drafting."
        title="Try the agents yourself."
        subtitle="Self-host it, or try the hosted demo (evaluation only)."
      />
    </>
  )
}
