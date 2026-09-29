import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { lifecycle } from '@/content/lifecycle'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { AgentGrid } from '@/components/sections/AgentGrid'
import { TrustStrip } from '@/components/sections/TrustStrip'
import { BrowserFrame } from '@/components/sections/BrowserFrame'
import { SEO } from '@/lib/seo'
import { Check } from 'lucide-react'
import { SITE_URL } from '@/lib/utils'

const stageScreenshot: Record<string, { src: string; alt: string; url: string }> = {
  intake: { src: '/product/assistant-empty.png', alt: 'Assistant ready to triage incoming contract requests', url: 'app.draft-legal.com/assistant' },
  draft: { src: '/product/contract-review.png', alt: 'Contract draft with extracted clauses and AI guidance', url: 'app.draft-legal.com/contracts' },
  negotiate: { src: '/product/contract-review.png', alt: 'Contract negotiation view with redline analysis', url: 'app.draft-legal.com/contracts' },
  approve: { src: '/product/approvals.png', alt: 'Send for review modal with sequential approval routing', url: 'app.draft-legal.com/approvals' },
  sign: { src: '/product/contract-list.png', alt: 'Contract repository with execution status', url: 'app.draft-legal.com/contracts' },
  track: { src: '/product/dashboard.png', alt: 'Dashboard tracking obligations, renewals, and pending items', url: 'app.draft-legal.com/dashboard' },
}

const productSchema = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Draft Legal',
  description:
    'Open-source, agent-first contract lifecycle management. Full coverage from intake through post-signature obligations.',
  url: `${SITE_URL}/product`,
  brand: { '@type': 'Brand', name: 'Draft Legal' },
}

export default function Product() {
  // Links such as /product#negotiate land here. App scrolls to the top on
  // every route change, so jump to the stage once it has rendered.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])

  return (
    <>
      <SEO
        title="Product"
        description="Tour the full contract lifecycle in Draft Legal — intake, drafting, negotiation, approval, signature, and post-signature obligations."
        path="/product"
        schema={productSchema}
      />

      <section className="bg-white py-20 md:py-28">
        <div className="container-page">
          <div className="mx-auto max-w-3xl text-center">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              The product
            </div>
            <h1 className="mt-3 heading-display text-slate-900">
              12 agents. 6 stages. 1 platform.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              Most CLM tools cover one part of the lifecycle and bolt on AI later. Draft Legal was
              designed agent-first, end-to-end. Here's what each stage looks like.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-slate-50">
        <div className="container-page">
          {lifecycle.map((stage, idx) => (
            <div
              key={stage.slug}
              id={stage.slug}
              className="grid items-start gap-10 border-t border-slate-200 py-16 lg:grid-cols-12"
            >
              <div className="lg:col-span-5 lg:sticky lg:top-24">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-md bg-emerald-700 font-mono text-sm font-bold text-white">
                    {String(stage.step).padStart(2, '0')}
                  </span>
                  <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Stage {stage.step}
                  </div>
                </div>
                <h2 className="mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
                  {stage.name}
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-600">{stage.blurb}</p>
                <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
                  {stage.agent}
                </div>
              </div>

              <div className="lg:col-span-7">
                <BrowserFrame
                  src={stageScreenshot[stage.slug]?.src ?? '/product/dashboard.png'}
                  alt={stageScreenshot[stage.slug]?.alt ?? stage.name}
                  url={stageScreenshot[stage.slug]?.url ?? 'app.draft-legal.com'}
                  shadow="soft"
                />
                <ul className="mt-6 space-y-3">
                  {stage.details.map((d) => (
                    <li
                      key={d}
                      className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700"
                    >
                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 rounded-xl border border-slate-200 bg-gradient-to-br from-emerald-50 to-white p-6">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    What the agent actually does
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    {idx === 0 &&
                      'Reads the inbound request, pulls out counterparty, value and governing law, and classifies type and priority with a confidence score. A person assigns it — with the facts already filled in.'}
                    {idx === 1 &&
                      'Picks your template, fills it from the request, the counterparty record and template defaults, and flags the terms it couldn\'t fill. You edit; the agent doesn\'t invent legal language.'}
                    {idx === 2 &&
                      'When their redline returns, scores each change for risk — before, as proposed and with your counter — against your playbook, and proposes counter-language with the reasons. It goes back in their Word file as tracked changes. The negotiator stays in control.'}
                    {idx === 3 &&
                      'Routes by your rules — by contract type and value, in sequence or in parallel. Each approver sees an AI summary, the risk flags and a recommendation. Approvers can decide from Slack; Teams receives notification cards.'}
                    {idx === 4 &&
                      'No AI here — e-signature is built in. Each signer gets a personal link; name, time, IP and browser go on a certificate page, and the executed PDF gets a PAdES/X.509 seal, so any later change shows. Word or PDF in, sealed PDF out.'}
                    {idx === 5 &&
                      'Extracts payment, renewal, audit and reporting obligations (from the first 16,000 characters, up to 25 per contract) and reminds the contract owner a week before each is due — not a generic legal inbox. Invoices are matched to their contract, with the amount checked against the contract total; you confirm the match or file a dispute.'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <AgentGrid />
      <TrustStrip />
      <CtaStrip
        title="See it run on your own contracts."
        subtitle="Self-host it in three commands, or try the hosted demo (evaluation only)."
      />
    </>
  )
}
