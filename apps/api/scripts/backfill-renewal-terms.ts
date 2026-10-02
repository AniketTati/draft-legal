/**
 * backfill-renewal-terms.ts — docs/41 Part 14: work out the renewal columns
 * (renewalType, renewalTermMonths, noticeDays, noticeDeadline,
 * optOutWindowStart, priceUpliftCap, renewalConfirmed) for contracts whose
 * values were set before the columns existed. New writes keep them in step
 * (lib/renewal-terms.ts); this catches up the rest.
 *
 * Idempotent: a contract whose columns already match is not written, and
 * updatedAt is left as it was. A parent's deadline reads its signed
 * amendments' and renewals' values, not their columns, so order doesn't matter.
 *
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-renewal-terms.ts           # every org
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-renewal-terms.ts <orgId>   # one org
 */
import { prisma } from '../src/lib/prisma.js'
import { syncRenewalTerms } from '../src/lib/renewal-terms.js'

const orgId = process.argv.slice(2).find(a => !a.startsWith('-')) || undefined

async function main() {
  const contracts = await prisma.contract.findMany({
    where: { deletedAt: null, ...(orgId ? { orgId } : {}) },
    select: { id: true, orgId: true },
    orderBy: { id: 'asc' },
  })
  console.log(`Working out renewal terms for ${contracts.length} contracts (org=${orgId ?? 'ALL'})…`)
  let done = 0, withDeadline = 0, failed = 0
  for (const c of contracts) {
    try {
      const r = await syncRenewalTerms(c.orgId, c.id)
      if (r?.noticeDeadline) withDeadline++
    } catch (err) {
      failed++
      console.warn(`  ${c.id}: ${(err as Error).message}`)
    }
    done++
    if (done % 200 === 0) console.log(`  ${done}/${contracts.length}`)
  }
  console.log(`Done: ${done} contracts, ${withDeadline} with a notice deadline, ${failed} failed.`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) })
