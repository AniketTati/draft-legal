export type PricingTier = {
  name: string
  tagline: string
  price: string
  priceNote: string
  cta: { label: string; href: string }
  highlight?: boolean
  features: string[]
}

// Open Source is the only published tier today. Cloud and Enterprise will
// surface here once we have traction and real SLAs to stand behind — not a
// "coming soon" placeholder.
export const tiers: PricingTier[] = [
  {
    name: 'Open Source',
    tagline: 'Self-hosted. Free forever.',
    price: '$0',
    priceNote: 'AGPL-3.0 licensed, full feature set',
    cta: { label: 'Self-host on GitHub', href: 'https://github.com/AniketTati/draft-legal' },
    highlight: true,
    features: [
      'All 12 agents — same code as our hosted demo',
      'Unlimited users, unlimited contracts',
      'Run on your infra, in your VPC',
      'Bring your own AI keys (Anthropic, OpenAI, Google or OpenRouter)',
      'Postgres + pgvector, Redis, S3-compat storage, ES/OpenSearch — all standard',
      'AGPL-3.0 license — fork it, modify it, ship it',
    ],
  },
  {
    name: 'Hosted (Free Demo)',
    tagline: 'Try it without installing anything.',
    price: '$0',
    priceNote: 'Free-tier infrastructure, evaluation only',
    cta: { label: 'Try the demo', href: 'https://app.draft-legal.com/register' },
    features: [
      'Same code as Open Source — same agents, same UI',
      'No install — sign up, log in, try every flow',
      'Anthropic / OpenAI / Google models supported',
      'Scale-to-zero compute — first request after idle is slow (5–10 s)',
      'Free-tier search + 0.5 GB Postgres — storage and request volume are limited',
      'Not for production data — for product evaluation only',
    ],
  },
]

export const pricingFaqs = [
  {
    q: 'Is there a managed cloud option?',
    a: 'Not yet — we publicly run draftLegal at app.draft-legal.com so you can evaluate the product without installing anything, but that demo runs on free-tier infrastructure with deliberate scale and speed limits. It is not intended for production data. Once we have traction we will publish managed-cloud and enterprise tiers with real SLAs. In the meantime, reach out via the Contact page if you need a managed deployment.',
  },
  {
    q: 'Is anything held back from the open-source version?',
    a: 'No. Every agent, every screen, every API endpoint is in the public repo under AGPL-3.0. Self-host the same code we run.',
  },
  {
    q: 'Can I bring my own AI provider keys?',
    a: 'Yes. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY (or add your organisation\'s own keys in Admin → AI Config) and draftLegal routes through your account. The provider and model are chosen per tier — reasoning, default, fast and so on.',
  },
  {
    q: 'What does the public demo at app.draft-legal.com cost?',
    a: 'Nothing — try it free. It runs on free-tier infrastructure (scale-to-zero compute, sandbox search, free Postgres) so the first request after idle is slow and large jobs may queue. Production teams should self-host until our managed cloud ships.',
  },
  {
    q: 'How do I deploy it myself?',
    a: 'pnpm dev:setup and pnpm dev for a local install; docker-compose.selfhost.yml for a production install on your own servers (see docs/operations/SELF-HOSTING.md); a deploy script for Cloud Run. The same Dockerfiles run on any container host. See README.md and docs/operations in the repo.',
  },
]
