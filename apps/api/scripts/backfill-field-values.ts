/**
 * backfill-field-values.ts — docs/39 B1/A3: fill the field store for every
 * contract at once, and rewrite each contract's keyTerms / fieldConfidence
 * under the canonical field names (older spellings like governing_law,
 * noticePeriod and total_value folded into governingLaw, the unconfirmed
 * notice period and value).
 *
 * The store reads a contract's legacy values on first touch anyway; this is
 * for what reads many contracts at once (the Review Queue, field filters).
 * Idempotent and resumable: a contract that already has its rows only has its
 * read model rewritten. A contract's updatedAt is left as it was.
 *
 * Run after `prisma migrate deploy` has created contract_field_values:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-field-values.ts           # every org
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-field-values.ts <orgId>   # one org
 */
import { prisma } from '../src/lib/prisma.js'
import { materializeContractFields } from '../src/lib/field-store.js'

const orgId = process.argv.slice(2).find(a => !a.startsWith('-')) || undefined

async function main() {
  const contracts = await prisma.contract.findMany({
    where: { deletedAt: null, ...(orgId ? { orgId } : {}) },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  console.log(`Filling field values for ${contracts.length} contracts (org=${orgId ?? 'ALL'})…`)
  let done = 0, rows = 0, failed = 0
  for (const c of contracts) {
    try {
      const r = await materializeContractFields(c.id)
      rows += r?.rows ?? 0
    } catch (err) {
      failed++
      console.warn(`  ${c.id}: ${(err as Error).message}`)
    }
    done++
    if (done % 50 === 0) console.log(`  ${done}/${contracts.length}`)
  }
  console.log(`Done: ${done} contracts, ${rows} field values, ${failed} failed.`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  // The store's imports open Redis and Elasticsearch clients that would keep
  // the process alive after the work is done.
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) })
