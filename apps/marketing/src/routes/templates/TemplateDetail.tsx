import { useParams, Navigate, Link } from 'react-router-dom'
import { ChevronRight, Download, Sparkles } from 'lucide-react'
import { templates } from '@/content/templates'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'
import { SITE_URL } from '@/lib/utils'

export default function TemplateDetail() {
  const { slug } = useParams<{ slug: string }>()
  if (!slug || !templates[slug]) return <Navigate to="/templates" replace />
  const t = templates[slug]

  const howToSchema = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: `How to use the ${t.shortLabel} template`,
    description: t.tldr,
    url: `${SITE_URL}/templates/${t.slug}`,
    step: t.keyClauses.map((c, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: c.name,
      text: c.body,
    })),
  }

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: t.title,
    description: t.tldr,
    url: `${SITE_URL}/templates/${t.slug}`,
    author: { '@type': 'Organization', name: 'Draft Legal' },
  }

  return (
    <>
      <SEO
        title={t.title}
        description={t.tldr}
        path={`/templates/${t.slug}`}
        schema={[articleSchema, ...(t.keyClauses.length ? [howToSchema] : [])]}
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <Link to="/templates" className="text-sm font-medium text-slate-500 hover:text-emerald-700">
                ← All templates
              </Link>
              <div className="mt-4 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                Free template
              </div>
              <h1 className="mt-4 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
                {t.title}
              </h1>
              <p className="mt-3 text-sm uppercase tracking-wide text-slate-500">
                For {t.audience}
              </p>

              <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/50 p-6">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  TL;DR
                </div>
                <p className="mt-2 text-base leading-7 text-slate-800">{t.tldr}</p>
              </div>

              <div className="prose-marketing mt-12">
                <h2>What is a {t.shortLabel}?</h2>
                <p>{t.whatItIs}</p>
              </div>

              {t.keyClauses.length > 0 && (
                <div className="prose-marketing mt-10">
                  <h2>Key clauses to include</h2>
                  <ul className="!list-none !pl-0">
                    {t.keyClauses.map((c) => (
                      <li
                        key={c.name}
                        className="!mb-4 rounded-lg border border-slate-200 bg-white p-4"
                      >
                        <div className="font-semibold text-slate-900">{c.name}</div>
                        <p className="!mb-0 mt-1 text-sm leading-6 text-slate-600">{c.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {t.pitfalls.length > 0 && (
                <div className="prose-marketing mt-10">
                  <h2>Common pitfalls</h2>
                  <ul>
                    {t.pitfalls.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}

              {t.publishedComingSoon && (
                <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                  Full clause-by-clause guide is being written. The template download is live —
                  the explainer will follow shortly.
                </div>
              )}
            </div>

            <aside className="lg:col-span-2">
              <div className="sticky top-24 space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-md bg-emerald-700 text-white">
                      <Download className="h-4 w-4" />
                    </span>
                    <h3 className="text-base font-semibold text-slate-900">
                      Download the template
                    </h3>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-600">
                    Free to use. No email required.
                  </p>
                  <a
                    href={t.downloadFile}
                    download
                    className="mt-4 block rounded-md bg-emerald-700 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-emerald-800"
                  >
                    Download the .docx →
                  </a>
                </div>

                <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-700 to-emerald-600 p-6 text-white">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    <h3 className="text-sm font-semibold uppercase tracking-wide">
                      Or skip the template
                    </h3>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-emerald-50">
                    Tell Draft Legal who you're contracting with and what terms you need — get a
                    polished draft in 30 seconds, ready to send.
                  </p>
                  <a
                    href="https://app.draft-legal.com/register"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-white px-3.5 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                  >
                    Try the Draft Agent <ChevronRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <CtaStrip />
    </>
  )
}
