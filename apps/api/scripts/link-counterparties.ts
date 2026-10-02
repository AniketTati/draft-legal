/**
 * link-counterparties.ts — docs/39 A14: link every contract to the directory
 * entry for its counterparty, by any name the company goes by.
 *
 * From this release a contract links itself whenever its counterparty is
 * written, and an entry links the contracts naming it when it is added or
 * given another name. This does the same once for the contracts analysed
 * before: "ACME CORPORATION, INC." on a contract links to the entry "Acme
 * Corp.". Only contracts linked to nothing (or to a deleted entry) are
 * touched; a contract's updatedAt is left as it was. Idempotent.
 *
 * Run after `prisma migrate deploy` has added counterparties.aliases:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/link-counterparties.ts           # every org
 *   cd apps/api && npx tsx --env-file=../../.env scripts/link-counterparties.ts <orgId>   # one org
 */
import { prisma } from '../src/lib/prisma.js'
import { loadDirectory, linkContractsTo } from '../src/lib/counterparty-directory.js'

const orgId = process.argv.slice(2).find(a => !a.startsWith('-')) || undefined

async function main() {
  const orgs = await prisma.organization.findMany({ where: orgId ? { id: orgId } : {}, select: { id: true, name: true } })
  let linked = 0
  for (const org of orgs) {
    const entries = await loadDirectory(prisma, org.id)
    let n = 0
    for (const e of entries) n += await linkContractsTo(prisma, org.id, e)
    if (n) console.log(`  ${org.name}: ${n} contracts linked across ${entries.length} directory entries`)
    linked += n
  }
  console.log(`Done: ${linked} contracts linked (orgs=${orgs.length}).`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  // The imports open Redis and Elasticsearch clients that would keep the process alive.
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) })
