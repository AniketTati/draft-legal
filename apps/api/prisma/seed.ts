import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { seedOrgDefaults } from '../src/lib/org-seed.js'
import { seedPassword } from '../src/lib/seed-password.js'
import { DEMO_CONTRACTS, DEMO_ORG_NAME, DEMO_ORG_SLUG, DEMO_USERS, seedDemoWorkspace } from '../src/lib/demo-workspace.js'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // ── Org ─────────────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: { name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG, subscriptionTier: 'PRO' },
  })

  // ── Roles, users, contracts, workflow, signatures (lib/demo-workspace.ts) ─
  // X41 — password123 only outside production (see lib/seed-password.ts).
  const { password, generated } = seedPassword()
  const hash = await bcrypt.hash(password, 12)
  await seedDemoWorkspace(prisma, org.id, hash)

  console.log(`✓ Org: ${org.name}`)
  console.log(`✓ Users: ${DEMO_USERS.map(u => u.email).join(' / ')}  (password: ${
    generated ? `${password} — generated for this install, shown once; change it after signing in`
      : process.env.SEED_ADMIN_PASSWORD ? 'from SEED_ADMIN_PASSWORD' : password
  })`)
  if (generated) console.log('  (users that already existed keep their password: the seed does not change it)')
  console.log(`✓ Demo contracts: ${DEMO_CONTRACTS.length}`)
  console.log(`✓ Signature requests: ${await prisma.signatureRequest.count({ where: { orgId: org.id } })} (one per status)`)

  // ── Base data (templates, clauses, playbook) for ALL orgs ────────────────
  const allOrgs = await prisma.organization.findMany()
  for (const seedOrg of allOrgs) {
    // Find the first admin-role user or any user in this org
    const seedAdmin = await prisma.user.findFirst({
      where: { orgId: seedOrg.id },
      orderBy: { createdAt: 'asc' },
    })
    if (!seedAdmin) continue
    await seedBaseData(seedOrg.id, seedOrg.slug, seedAdmin.id)
    console.log(`✓ Base data seeded for org: ${seedOrg.name}`)
  }
}

async function seedBaseData(orgId: string, orgSlug: string, adminId: string) {
  return seedOrgDefaults(orgId, orgSlug, adminId)
}


main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
