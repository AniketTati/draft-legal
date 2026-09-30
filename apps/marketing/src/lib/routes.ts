export type RouteDef = {
  path: string
  title: string
  description: string
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
}

export const learnSlugs = [
  'contract-lifecycle-management',
  'ai-contract-review',
  'ai-contract-drafting',
  'contract-redlining',
  'clause-library',
  'contract-repository',
  'contract-approval-workflow',
  'contract-renewal-tracking',
  'obligation-management',
  'electronic-signature',
  'nda',
  'msa',
  'dpa',
  'baa',
  'sow',
] as const

export const templateSlugs = [
  'nda',
  'msa',
  'dpa',
  'baa',
  'sow',
  'employment-agreement',
  'mta',
] as const

export const industrySlugs = [
  'saas',
  'healthcare',
  'manufacturing',
  'biotech',
  'logistics',
] as const

export const compareSlugs = [
  'ironclad',
  'harvey',
  'spellbook',
  'docusign-clm',
  'icertis',
] as const

export const allRoutes: RouteDef[] = [
  { path: '/', title: 'Open-source, agent-first CLM', description: 'AGPL-3.0 licensed contract lifecycle management with 12 AI agents. Read the code, self-host the same platform we run.', priority: 1.0 },
  { path: '/product', title: 'Product', description: 'Tour the full lifecycle: intake, drafting, negotiation, approval, signature, obligations.', priority: 0.9 },
  { path: '/security', title: 'Security', description: 'Self-host story, RBAC, audit log, encryption, AI safety, compliance roadmap.', priority: 0.9 },
  { path: '/pricing', title: 'Pricing', description: 'Free, AGPL-3.0 licensed, self-hosted. Free hosted demo for evaluation only.', priority: 0.9 },
  { path: '/open-source', title: 'Open Source', description: 'AGPL-3.0 licensed CLM you can read, audit, and run anywhere. Three-step self-host quickstart.', priority: 0.9 },
  { path: '/contact', title: 'Contact', description: 'Talk to the draftLegal team about your contract operations.', priority: 0.5 },
  { path: '/alternatives', title: 'CLM Alternatives', description: 'Neutral comparisons against Ironclad, Harvey, Spellbook, DocuSign CLM, and Icertis — only publicly verifiable claims.', priority: 0.8 },
  ...compareSlugs.map((slug) => ({
    path: `/compare/${slug}`,
    title: `draftLegal vs ${slug}`,
    description: `Neutral comparison: draftLegal vs ${slug}. Openness, deployment posture, AI extensibility — only publicly verifiable rows.`,
    priority: 0.8,
  })),
  { path: '/industries', title: 'Industries', description: 'CLM by vertical: SaaS, healthcare, manufacturing, biotech, and logistics.', priority: 0.7 },
  ...industrySlugs.map((slug) => ({
    path: `/industries/${slug}`,
    title: `CLM for ${slug}`,
    description: `Contract lifecycle management built for ${slug} legal, ops, and procurement teams.`,
    priority: 0.7,
  })),
  { path: '/learn', title: 'Learn', description: 'CLM glossary and explainers — agent-first contract lifecycle management concepts.', priority: 0.7 },
  ...learnSlugs.map((slug) => ({
    path: `/learn/${slug}`,
    title: slug,
    description: `Plain-English guide to ${slug.replace(/-/g, ' ')} for legal, ops, and procurement teams.`,
    priority: 0.6,
  })),
  { path: '/templates', title: 'Contract Template Guides', description: 'Plain-English guides to NDA, MSA, and DPA contracts — or draft one with Draft Legal.', priority: 0.7 },
  ...templateSlugs.map((slug) => ({
    path: `/templates/${slug}`,
    title: `${slug.toUpperCase()} Template Guide`,
    description: `The ${slug.toUpperCase()}'s key clauses explained in plain English — or generate one with Draft Legal.`,
    priority: 0.6,
  })),
]

export const includedRoutes = () => allRoutes.map((r) => r.path)
