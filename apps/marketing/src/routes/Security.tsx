import { CtaStrip } from '@/components/sections/CtaStrip'
import { SEO } from '@/lib/seo'
import { Lock, ShieldCheck, FileSearch, KeyRound, Database, ScrollText, AlertTriangle, Server } from 'lucide-react'

const sections = [
  {
    icon: Database,
    title: 'Architecture & data isolation',
    body: 'Each organization\'s data is kept apart twice. In the database, Postgres row-level security (RLS) policies on every table that holds tenant data confine an organization\'s queries to its own rows, raw SQL included. In the API, a data-layer guard limits every query to the caller\'s organization before it runs. On every build, an automated test calls each signed-in API endpoint with another organization\'s records and fails if anything is read, changed or linked across. On Cloud Enterprise, single-tenant infrastructure is available. On self-host, the policies ship with the schema migrations.',
  },
  {
    icon: KeyRound,
    title: 'Authentication & authorization',
    body: 'JWT (HS256) with 15-minute access tokens and 7-day refresh. SAML / OIDC SSO is on the roadmap — not available yet. Authorization is enforced server-side as {action × resource × scope} triples — there are no client-only checks.',
  },
  {
    icon: ShieldCheck,
    title: 'Role-based access control',
    body: 'Granular RBAC with the Permission Engine: every API call passes through requirePermission(). Each user holds one or more of the built-in roles and gets the combined permissions; a permission applies org-wide or only to the user\'s own records. Role changes are recorded in the audit log. Custom roles and matter-level scopes are planned.',
  },
  {
    icon: FileSearch,
    title: 'Tamper-evident audit log',
    body: 'State-changing actions — by humans or agents — are recorded with actor, IP, timestamp, payload, and a chained hash, so altering a past entry is detectable. Agent actions are recorded with the arguments that were applied. Admins can search the log and re-check its hash chain in the app (Admin → Organization → Audit Log); audit export and database-level append-only enforcement are planned.',
  },
  {
    icon: Lock,
    title: 'Encryption',
    body: 'TLS in transit and encryption at rest on the hosted deployment; on self-hosted installs, transport and at-rest encryption follow your own infrastructure configuration. Bring-your-own-key (BYOK) for AI provider credentials, encrypted with an org-specific master key. Document storage on S3 / MinIO / GCS — versioning and immutability supported by the underlying backend.',
  },
  {
    icon: AlertTriangle,
    title: 'AI safety',
    body: 'Agents propose structured plans before executing state changes. Read-only tools (search, ask) auto-execute; destructive ones (sign, send, delete) require human approval. Every extraction returns a confidence score and a citation back to the source quote — no hallucinated facts.',
  },
  {
    icon: Server,
    title: 'Self-host & data residency',
    body: 'Run Draft Legal in your VPC, your region, your network. Air-gapped deployments are supported (BYO LLM or on-prem inference). Cloud lets you choose region (US, EU, APAC) and we never replicate data outside the region you choose.',
  },
  {
    icon: ScrollText,
    title: 'Compliance roadmap',
    body: 'SOC 2 Type II is on our roadmap — not yet audited; in the meantime, self-hosting keeps your contracts on your own infrastructure. GDPR: dedicated data-export and deletion endpoints are planned; today, self-hosting keeps data residency and deletion in your hands. HIPAA-aligned controls are planned for Enterprise.',
  },
]

const securitySchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: sections.map((s) => ({
    '@type': 'Question',
    name: `How does Draft Legal handle ${s.title.toLowerCase()}?`,
    acceptedAnswer: { '@type': 'Answer', text: s.body },
  })),
}

export default function Security() {
  return (
    <>
      <SEO
        title="Security"
        description="How Draft Legal handles tenant isolation, RBAC, audit logging, encryption, AI safety, and self-host data residency."
        path="/security"
        schema={securitySchema}
      />

      <section className="bg-slate-950 py-20 text-white md:py-28">
        <div className="container-page">
          <div className="mx-auto max-w-3xl">
            <div className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
              Security
            </div>
            <h1 className="mt-3 heading-display text-white">
              Built for the trust legal teams demand.
            </h1>
            <p className="mt-6 text-lg leading-8 text-slate-300">
              The most transparent CLM you can buy: every line of security-relevant code is on
              GitHub. Here's how the platform protects your contracts and your customers' data.
            </p>
            <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-emerald-700/30 bg-emerald-700/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              SOC 2 Type II on the roadmap · self-host today for full data control
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white py-20">
        <div className="container-page">
          <div className="grid gap-6 md:grid-cols-2">
            {sections.map((s) => (
              <div
                key={s.title}
                className="rounded-xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <span className="grid h-10 w-10 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                  <s.icon className="h-5 w-5" />
                </span>
                <h2 className="mt-5 text-xl font-bold tracking-tight text-slate-900">
                  {s.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-slate-200 bg-slate-50 p-8 md:p-10">
            <h3 className="text-2xl font-bold tracking-tight text-slate-900">
              Need our security pack?
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
              We can share our SIG-Lite, latest pen-test summary, sub-processor list, and
              architecture diagram with prospects under NDA.
            </p>
            <div className="mt-5">
              <a
                href="/contact?source=security_pack"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
              >
                Request security pack →
              </a>
            </div>
          </div>
        </div>
      </section>

      <CtaStrip
        eyebrow="Try it"
        title="Audit before you adopt."
        subtitle="The full source — including every security boundary — is on GitHub. Run it yourself."
      />
    </>
  )
}
