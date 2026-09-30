export type FAQ = { q: string; a: string }

export const homeFaqs: FAQ[] = [
  {
    q: 'Is draftLegal really free?',
    a: 'Yes. The full product is AGPL-3.0 licensed and free to self-host forever — no feature gating, no seat caps. Managed cloud and enterprise tiers will arrive once we have real traction and SLAs to stand behind.',
  },
  {
    q: 'Can I self-host on my own servers or VPC?',
    a: 'Yes. Clone the repo and run pnpm dev:setup, then pnpm dev, to try it locally; for production, docker-compose.selfhost.yml runs the full stack on your own servers. Your database and files stay on your infrastructure — with AI features on, contract text goes to the model provider you configure. The repo is the same code we run on our public evaluation demo.',
  },
  {
    q: 'What about the public demo at app.draft-legal.com?',
    a: 'It is a free evaluation environment so you can try the product without installing anything. It runs on free-tier infrastructure (scale-to-zero compute, sandbox search, free Postgres) with deliberate scale and speed limits, so do not put production data in it. Self-host for production.',
  },
  {
    q: 'Where does my data go?',
    a: 'Self-host: your database and files stay in your VPC. With AI features on, contract text goes to the model provider you configure (Anthropic, OpenAI, Google or OpenRouter) under your own keys, after personal data is masked (redact by default): ID, card and bank numbers, emails, phone numbers, dates of birth, IP addresses and API keys. Names, addresses and health details are not masked, and there is no on-prem model option; without an AI key the app still runs. Public demo: stored in our project on Google Cloud / Neon for evaluation only, encrypted in transit and at rest.',
  },
  {
    q: 'Which AI models does draftLegal use?',
    a: 'Anthropic Claude, OpenAI GPT and Google Gemini are supported, and OpenRouter too. An admin picks the provider and model per tier (reasoning, default, fast and so on) in Admin → AI Config. Bring your own API keys to control spend and data routing.',
  },
  {
    q: 'What contract types are supported?',
    a: 'Ten types out of the box: NDA, MSA, SOW, SLA, DPA, order form, license, vendor, employment and partnership agreements. Anything else — a BAA, an MTA, an IP assignment — is filed as Other. You can add custom fields to each type, and set your own clause positions in the playbook.',
  },
]
