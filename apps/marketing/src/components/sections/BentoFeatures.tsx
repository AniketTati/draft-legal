import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

type Card = {
  title: string
  body: string
  image: string
  alt: string
  href?: string
}

// 4 cards, 2-column grid on md+. Every card is the same width so each
// 1680×900 screenshot renders at ~700px and the UI text inside is readable.
// No tall card, no asymmetric "feature" span — uneven row heights were
// creating dead whitespace below the smaller images.
const cards: Card[] = [
  {
    title: 'Ask anything across your portfolio',
    body: 'The Assistant answers in plain English with citations back to specific contracts and clauses. It states the true total ("showing 20 of 40") and says when an answer rests on a sample.',
    image: '/product/assistant.png',
    alt: 'Assistant answering "What is in my approval queue?" with structured response',
    href: '/product#track',
  },
  {
    title: 'Contract review with AI extraction',
    body: 'Universal + type-specific fields, each cited to the contract with a confidence score; low-confidence values are flagged for review. Liability caps are read from the wording ("two times (2x) the fees paid in the twelve months" = 24 months of fees) and checked against your playbook limits.',
    image: '/product/contract-review.png',
    alt: 'Salesforce MSA detail with extracted clauses and AI risk panel',
    href: '/product#negotiate',
  },
  {
    title: 'Counterparty intelligence',
    body: 'Every contract with every party, rolled up. See your full exposure with Salesforce, Snowflake, or any vendor at a glance.',
    image: '/product/counterparties.png',
    alt: 'Salesforce counterparty rollup — 9 contracts, $2.2M total',
    href: '/product#track',
  },
  {
    title: 'Approvals that route themselves',
    body: 'Sequential or parallel, routed by contract type and value, with auto-approval under a limit you set. Approvers see the AI summary, the risk flags and a recommendation before they click.',
    image: '/product/approvals.png',
    alt: 'Approval queue with AI summaries and recommendations',
    href: '/product#approve',
  },
]

export function BentoFeatures() {
  return (
    <section className="bg-white py-20 md:py-28">
      <div className="container-page">
        <div className="mx-auto max-w-3xl text-center">
          <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            What you actually use
          </div>
          <h2 className="mt-3 heading-section text-slate-900">
            Built for the work — not for the demo.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-600">
            These are the screens your legal, ops, and procurement teams will live in. Every one
            of them is on GitHub if you want to read the code.
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-6xl gap-6 md:grid-cols-2">
          {cards.map((c, i) => (
            <Card key={c.title} card={c} index={i} />
          ))}
        </div>
      </div>
    </section>
  )
}

function Card({ card, index }: { card: Card; index: number }) {
  return (
    <article
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 transition-all hover:border-emerald-200 hover:shadow-lg',
        index === 0 && 'bg-gradient-to-br from-emerald-50 via-white to-white',
      )}
    >
      <div className="relative px-6 pt-6">
        <h3 className="text-lg font-semibold tracking-tight text-slate-900">{card.title}</h3>
        <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">{card.body}</p>
        {card.href && (
          <Link
            to={card.href}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800"
          >
            See it <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="relative mx-6 mb-0 mt-5 overflow-hidden rounded-t-xl border border-b-0 border-slate-200 bg-white">
        <img
          src={card.image}
          alt={card.alt}
          loading="lazy"
          className="block h-auto w-full"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-50 to-transparent"
        />
      </div>
    </article>
  )
}
