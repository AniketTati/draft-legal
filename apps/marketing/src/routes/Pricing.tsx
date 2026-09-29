import { Check, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { tiers, pricingFaqs } from '@/content/pricing'
import { Faq } from '@/components/sections/Faq'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'
import { cn, SITE_URL } from '@/lib/utils'

const offerSchema = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Draft Legal',
  url: `${SITE_URL}/pricing`,
  offers: tiers.map((t) => ({
    '@type': 'Offer',
    name: t.name,
    description: t.tagline,
    price: t.price === '$0' ? '0' : undefined,
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
  })),
}

export default function Pricing() {
  return (
    <>
      <SEO
        title="Pricing"
        description="Free, AGPL-3.0 licensed, self-hosted. Managed cloud and enterprise tiers will arrive once we have real traction and SLAs to stand behind."
        path="/pricing"
        schema={offerSchema}
      />

      <section className="bg-white py-20 md:py-24">
        <div className="container-page">
          <div className="mx-auto max-w-3xl text-center">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Pricing
            </div>
            <h1 className="mt-3 heading-display text-slate-900">
              Same product, your choice.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-slate-600">
              Self-host the full platform for free, forever — or try our hosted free demo without
              installing anything. Same code, same agents, your call.
            </p>
          </div>

          <div className="mt-14 mx-auto grid max-w-3xl gap-5 md:grid-cols-2">
            {tiers.map((t) => (
              <div
                key={t.name}
                className={cn(
                  'flex flex-col rounded-2xl border bg-white p-6 transition-shadow',
                  t.highlight
                    ? 'border-emerald-700 shadow-lg ring-1 ring-emerald-700/20'
                    : 'border-slate-200 hover:shadow-md'
                )}
              >
                {t.highlight && (
                  <div className="-mt-3 mb-3 inline-flex w-fit rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Most popular
                  </div>
                )}
                <div className="text-base font-semibold text-slate-900">{t.name}</div>
                <div className="mt-1 text-sm text-slate-600">{t.tagline}</div>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-3xl font-bold tracking-tight text-slate-900">
                    {t.price}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{t.priceNote}</div>

                <Button
                  asChild
                  className="mt-6"
                  variant={t.highlight ? 'default' : 'outline'}
                >
                  <a href={t.cta.href}>
                    {t.cta.label} <ArrowRight className="ml-1.5 h-4 w-4" />
                  </a>
                </Button>

                <ul className="mt-6 space-y-2.5 border-t border-slate-100 pt-6 text-sm">
                  {t.features.map((f) => (
                    <li key={f} className="flex gap-2 text-slate-700">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-amber-200 bg-amber-50/60 p-6 md:p-8">
            <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <div className="text-sm font-semibold uppercase tracking-wide text-amber-800">
                  Managed cloud &amp; enterprise
                </div>
                <h2 className="mt-2 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                  Coming once we have traction.
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-700">
                  We will publish managed-cloud and enterprise tiers once we have real customers
                  and real SLAs to stand behind — not before. In the meantime, self-host the same
                  code we run. If you need a managed deployment now, talk to us directly.
                </p>
              </div>
              <div className="md:text-right">
                <a
                  href="/contact"
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:bg-slate-50"
                >
                  Contact us <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>

          <div className="mt-10 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-700">
            <p>
              <span className="font-semibold text-slate-900">Heads up about our public demo</span>{' '}
              at <a href="https://app.draft-legal.com" className="font-medium text-emerald-700 underline underline-offset-2">app.draft-legal.com</a>:
              it runs on free-tier infrastructure (scale-to-zero compute, sandbox search, free
              Postgres). It is intended for product evaluation only — first request after idle is
              slow, and large jobs may queue. Do not put production data in it.
              {' '}For production workloads, <a href="https://github.com/AniketTati/draft-legal" className="font-medium text-emerald-700 underline underline-offset-2">self-host on GitHub</a>.
            </p>
          </div>
        </div>
      </section>

      <Faq items={pricingFaqs} title="Pricing questions" eyebrow="Pricing FAQ" />
      <CtaStrip
        title="Try it for free."
        subtitle="No credit card. Self-host it in 3 commands, or try the hosted demo (evaluation only)."
      />
    </>
  )
}
