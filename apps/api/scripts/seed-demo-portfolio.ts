/**
 * seed-demo-portfolio.ts — a REALISTICALLY SHAPED contract portfolio for
 * design, density and QA work. Dev only; never point this at production.
 *
 * prisma/seed.ts gives you a dozen contracts, which is enough to prove the
 * app renders and useless for judging how it reads. Design decisions about
 * colour, density and scanning only fail at realistic volume and — more
 * importantly — at a realistic DISTRIBUTION.
 *
 * A real in-house repository is not evenly spread across the lifecycle. It is
 * mostly executed archive with a small live pipeline hanging off the front:
 *
 *     EXECUTED            ~55%   the archive — the reason the repo exists
 *     EXPIRED             ~10%   aged out, still discoverable
 *     DRAFT                ~8%
 *     UNDER_NEGOTIATION    ~7%   the live pipeline …
 *     PENDING_REVIEW       ~5%
 *     PENDING_APPROVAL     ~4%
 *     PENDING_SIGNATURE    ~3%
 *     APPROVED             ~3%
 *     TERMINATED           ~3%
 *     ARCHIVED             ~2%
 *
 * That shape is the point. An evenly-distributed fixture makes a status
 * palette look balanced; the real one tells you whether the colour you spent
 * on "executed" swamps the screen, and whether the handful of contracts that
 * actually need a human still stand out.
 *
 * Expiry dates are deliberately clustered into the next 30/60/90 days so the
 * renewal cliff — the thing legal ops actually gets fired over — is visible.
 *
 * Additive and re-runnable: everything is prefixed so `--clean` can remove
 * exactly what this created and nothing else.
 *
 *   pnpm --filter api exec tsx --env-file=../../.env scripts/seed-demo-portfolio.ts
 *   … --clean     remove only the rows this script created
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['warn', 'error'] })

/** Every row this script writes carries this tag, so cleanup is exact. */
const TAG = 'demo-portfolio'

// Deterministic PRNG — a fixture that reshuffles every run is not a fixture.
let _s = 20260809
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))

const STATUS_MIX: ReadonlyArray<[string, number]> = [
  ['EXECUTED', 55], ['EXPIRED', 10], ['DRAFT', 8], ['UNDER_NEGOTIATION', 7],
  ['PENDING_REVIEW', 5], ['PENDING_APPROVAL', 4], ['PENDING_SIGNATURE', 3],
  ['APPROVED', 3], ['TERMINATED', 3], ['ARCHIVED', 2],
]

const TYPES = ['MSA', 'NDA', 'SOW', 'SLA', 'VENDOR_AGREEMENT', 'EMPLOYMENT',
  'PARTNERSHIP', 'LICENSE', 'DATA_PROCESSING', 'ORDER_FORM'] as const

const COUNTERPARTIES = [
  'Zynga Inc.', 'Iora Health', 'Snowflake Computing', 'Ramp Business', 'Deel Inc.',
  'Cloudflare', 'Notion Labs', 'Figma Inc.', 'Datadog', 'Stripe Payments',
  'Twilio', 'Segment.io', 'Okta Security', 'Atlassian', 'HashiCorp',
  'MongoDB Atlas', 'Confluent', 'Databricks', 'Vercel', 'Linear Software',
  'Anthropic PBC', 'Plaid Technologies', 'Brex Treasury', 'Gusto Payroll',
  'Rippling HR', 'Carta Equity', 'Airtable', 'Miro Collaboration',
  'Zoom Video', 'DocuSign', 'Workday', 'ServiceNow', 'Cushman & Wakefield',
  'Baker McKenzie LLP', 'PwC Advisory', 'Iron Mountain', 'Salesforce',
] as const

const JURISDICTIONS = ['Delaware', 'New York', 'California', 'England & Wales',
  'Singapore', 'Ireland', 'Texas', 'Washington'] as const

// Risk factors phrased the way a reviewer would flag them.
const RISK_FACTORS = [
  'Uncapped consequential damages', 'No audit rights', 'MFN clause conflicts with playbook',
  'Auto-renewal with 90-day notice', 'Unilateral price escalation', 'Broad indemnity',
  'No termination for convenience', 'Assignment permitted without consent',
  'Governing law outside preferred set', 'Liability cap below 12 months fees',
  'Data residency unspecified', 'No SLA credits',
] as const

const day = 86_400_000

function weightedStatus(): string {
  const total = STATUS_MIX.reduce((n, [, w]) => n + w, 0)
  let r = rnd() * total
  for (const [s, w] of STATUS_MIX) { if ((r -= w) <= 0) return s }
  return 'EXECUTED'
}

/**
 * Expiry is where legal ops lives or dies, so it is not uniform noise:
 * a deliberate cluster lands inside the next 90 days.
 */
function expiryFor(status: string, now: number): Date | null {
  if (status === 'DRAFT') return null
  if (status === 'EXPIRED') return new Date(now - int(5, 400) * day)
  const roll = rnd()
  if (roll < 0.10) return new Date(now + int(1, 30) * day)    // the cliff
  if (roll < 0.20) return new Date(now + int(31, 60) * day)
  if (roll < 0.30) return new Date(now + int(61, 90) * day)
  return new Date(now + int(91, 1100) * day)
}

/** Contract value spans orders of magnitude — that is what tabular figures are for. */
function valueFor(type: string): number | null {
  if (type === 'NDA') return null
  const band = rnd()
  if (band < 0.45) return int(5_000, 90_000)
  if (band < 0.80) return int(90_000, 600_000)
  if (band < 0.95) return int(600_000, 3_000_000)
  return int(3_000_000, 14_000_000)
}

async function main() {
  const clean = process.argv.includes('--clean')

  const org = await prisma.organization.findFirst({ where: { name: 'Demo Org, Inc.' } })
  if (!org) throw new Error('Demo org not found — run `pnpm db:seed` first.')

  if (clean) {
    const doomed = await prisma.contract.findMany({
      where: { orgId: org.id, tags: { has: TAG } }, select: { id: true },
    })
    const ids = doomed.map((c) => c.id)
    if (ids.length) {
      await prisma.contractVersion.deleteMany({ where: { contractId: { in: ids } } })
      await prisma.contract.deleteMany({ where: { id: { in: ids } } })
    }
    console.log(`✓ removed ${ids.length} ${TAG} contracts`)
    return
  }

  const already = await prisma.contract.count({ where: { orgId: org.id, tags: { has: TAG } } })
  if (already > 0) {
    console.log(`${already} ${TAG} contracts already present — run with --clean first to reshape.`)
    return
  }

  const owner = await prisma.user.findFirst({ where: { orgId: org.id, email: 'admin@demo.com' } })
  if (!owner) throw new Error('admin@demo.com not found — run `pnpm db:seed` first.')

  // Reuse existing counterparty rows so the portfolio joins correctly.
  const cpMap: Record<string, string> = {}
  for (const name of COUNTERPARTIES) {
    const cp = await prisma.counterparty.upsert({
      where: { orgId_name: { orgId: org.id, name } },
      update: {},
      create: { orgId: org.id, name },
    })
    cpMap[name] = cp.id
  }

  const now = Date.now()
  const COUNT = 240
  const rows: any[] = []

  for (let i = 0; i < COUNT; i++) {
    const status = weightedStatus()
    const type = pick(TYPES)
    const cp = pick(COUNTERPARTIES)
    const expiry = expiryFor(status, now)
    const effective = new Date(now - int(30, 1400) * day)

    // Risk skews low — most contracts are fine. If everything is high risk,
    // nothing is, and the reviewer stops believing the column.
    const roll = rnd()
    const risk = roll < 0.6 ? int(3, 33) : roll < 0.88 ? int(34, 66) : int(67, 96)
    const factors = risk >= 34
      ? Array.from({ length: risk >= 67 ? int(2, 4) : int(1, 2) }, () => pick(RISK_FACTORS))
      : []

    rows.push({
      orgId: org.id,
      ownerId: owner.id,
      title: `${cp.replace(/[.,]/g, '')} — ${type.replace(/_/g, ' ')}`,
      type,
      status,
      counterpartyId: cpMap[cp],
      counterpartyName: cp,
      value: valueFor(type),
      currency: 'USD',
      effectiveDate: effective,
      expiryDate: expiry,
      jurisdiction: pick(JURISDICTIONS),
      riskScore: risk,
      riskFactors: [...new Set(factors)],
      overallConfidence: Math.round((0.55 + rnd() * 0.44) * 100) / 100,
      analysisStatus: 'DONE',
      summary: `${type.replace(/_/g, ' ')} with ${cp}. Governed by ${pick(JURISDICTIONS)} law.`,
      keyTerms: {
        term: `${pick([12, 24, 36, 48])} months`,
        autoRenew: rnd() < 0.55,
        noticeDays: pick([30, 60, 90]),
        liabilityCap: pick(['12× fees', '1× fees', 'Uncapped', '2× fees']),
      },
      tags: [TAG],
      createdAt: new Date(now - int(1, 900) * day),
    })
  }

  await prisma.contract.createMany({ data: rows })

  const mix = rows.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
  console.log(`✓ ${rows.length} contracts written to "${org.name}"`)
  console.log(Object.entries(mix).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `   ${s.padEnd(20)} ${String(n).padStart(3)}  ${(n / rows.length * 100).toFixed(0)}%`).join('\n'))
  const cliff = rows.filter((r) => r.expiryDate && +r.expiryDate - now < 90 * day && +r.expiryDate > now).length
  console.log(`   expiring within 90 days: ${cliff}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
