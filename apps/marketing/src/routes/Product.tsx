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
                  Powered by {stage.agent}
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
                      'Reads the inbound request, extracts counterparty and value, classifies type with confidence, and either auto-routes to the right queue or auto-approves low-risk items. You see the plan before it acts.'}
                    {idx === 1 &&
                      'Pulls your template + clause library, applies playbook positions, fills CRM data, and produces a first draft with every deviation flagged. You edit; the agent doesn\'t invent legal language.'}
                    {idx === 2 &&
                      'When the redline returns, detects every change against your fallback positions, ranks by deal-breaker risk, and proposes counter-language with rationale. The negotiator stays in control.'}
                    {idx === 3 &&
                      'Routes by your rules — by value, type, or counterparty. Each approver sees an AI summary, the diff, and the risk flags. Approvers can decide from Slack; Teams receives notification cards.'}
                    {idx === 4 &&
                      'Generates the signing packet, sends tokenized links to external signers, applies cryptographic signatures with embedded certificates, and produces a tamper-evident final PDF.'}
                    {idx === 5 &&
                      'Extracts every renewal date, payment milestone, audit right, and compliance deadline. Routes alerts to the right owner — not just to a generic legal inbox.'}
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
        subtitle="Self-host in three commands, or sign up for cloud and import your portfolio."
      />
    </>
  )
}
