/**
 * backfill-risk-score-scale.ts — one-shot: convert stored riskScore values
 * that are still 0-1 fractions to the declared 0-100 scale.
 *
 * riskScore is 0-100 (RiskScoreSchema in @clm/types). The column carried both
 * scales for a long time: seeds and imports wrote 0-100 integers while the
 * agents-service review callback wrote LLM fractions, and packages/types
 * declared 0-1, so every reader multiplied by 100 and a 0-100 row rendered as
 * "Risk 7000%". The API now normalises on read and on write, which makes the
 * app correct immediately — but Postgres filters (risk band, riskScoreMin/Max)
 * compare raw stored values, so a fraction row still under-matches until it is
 * rewritten. That is what this script is for.
 *
 * Idempotent: it only touches rows in (0, 1], and nothing it writes lands back
 * in that range. A fraction below ~0.015 would round to 1 and be picked up
 * again on a second run, so those collapse to 0 instead — a difference of one
 * point on a 100-point scale, and the only alternative is a script that keeps
 * multiplying the same rows by 100 every time someone runs it.
 *
 * Rows at exactly 0 are identical on both scales and are left alone. Rows at
 * exactly 1 are ambiguous (max risk as a fraction, 1% as a score) and are
 * treated as fractions — the same call the frontend guard and the read-path
 * normaliser make, so this script does not disagree with what users see.
 *
 * Soft-deleted contracts are included: restoring one should not resurrect a
 * mis-scaled score.
 *
 * Elasticsearch holds its own copy of riskScore, so after applying this run
 * `npx tsx --env-file=../../.env scripts/backfill-es-index.ts` to resync.
 *
 * Usage:
 *   # report only, changes nothing (default)
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-risk-score-scale.ts
 *   # apply
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-risk-score-scale.ts --fix
 *   # scope to one org (positional or --org=<id>)
 *   cd apps/api && npx tsx --env-file=../../.env scripts/backfill-risk-score-scale.ts <orgId>
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const fix = args.includes('--fix')
const orgId =
  args.find(a => !a.startsWith('-')) ??
  args.find(a => a.startsWith('--org='))?.slice('--org='.length)

/** Sample size for the per-row listing; the totals below always cover everything. */
const SAMPLE = 25

function toPercentScale(fraction: number): number {
  const scaled = Math.round(fraction * 100)
  // See the header: anything that would round back into (0, 1] has to leave
  // that range, or the next run would multiply it by 100 all over again.
  return scaled <= 1 ? 0 : scaled
}

async function main() {
  const scope = orgId ? { orgId } : {}

  const [total, nulls, zeros, alreadyScaled, candidates] = await Promise.all([
    prisma.contract.count({ where: scope }),
    prisma.contract.count({ where: { ...scope, riskScore: null } }),
    prisma.contract.count({ where: { ...scope, riskScore: 0 } }),
    prisma.contract.count({ where: { ...scope, riskScore: { gt: 1 } } }),
    prisma.contract.findMany({
      where: { ...scope, riskScore: { gt: 0, lte: 1 } },
      select: { id: true, title: true, orgId: true, riskScore: true, deletedAt: true },
      orderBy: { riskScore: 'desc' },
    }),
  ])

  console.log(`riskScore scale backfill (org=${orgId ?? 'ALL'}, mode=${fix ? 'APPLY' : 'dry-run'})\n`)
  console.log(`  contracts scanned      ${total}`)
  console.log(`  riskScore null         ${nulls}`)
  console.log(`  riskScore 0            ${zeros}  (identical on both scales)`)
  console.log(`  already 0-100          ${alreadyScaled}`)
  console.log(`  0-1 fractions to fix   ${candidates.length}\n`)

  if (candidates.length === 0) {
    console.log('Nothing to do — every stored riskScore is already on the 0-100 scale.')
    await prisma.$disconnect()
    return
  }

  const changes = candidates.map(c => ({
    ...c,
    next: toPercentScale(c.riskScore as number),
  }))
  const collapsed = changes.filter(c => c.next === 0)
  const softDeleted = changes.filter(c => c.deletedAt != null)

  for (const c of changes.slice(0, SAMPLE)) {
    const flag = c.deletedAt ? ' [soft-deleted]' : ''
    console.log(`  ${fix ? '✎' : '·'} ${c.id}  ${c.riskScore} → ${c.next}  ${c.title.slice(0, 48)}${flag}`)
  }
  if (changes.length > SAMPLE) console.log(`  … and ${changes.length - SAMPLE} more`)

  if (collapsed.length > 0) {
    console.log(`\n  ${collapsed.length} row(s) below ~0.015 collapse to 0 rather than rounding to 1 (see header).`)
  }
  if (softDeleted.length > 0) {
    console.log(`  ${softDeleted.length} row(s) are soft-deleted and are converted too.`)
  }

  if (!fix) {
    console.log(`\n(dry-run — pass --fix to apply ${changes.length} update(s))`)
    await prisma.$disconnect()
    return
  }

  let applied = 0
  let failed = 0
  for (const c of changes) {
    try {
      await prisma.contract.update({ where: { id: c.id }, data: { riskScore: c.next } })
      applied++
    } catch (e) {
      failed++
      console.error(`  ✗ ${c.id}: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  const remaining = await prisma.contract.count({
    where: { ...scope, riskScore: { gt: 0, lte: 1 } },
  })

  console.log(`\n✓ Updated ${applied} riskScore value(s)${failed ? `, ${failed} failed` : ''}.`)
  console.log(`  Remaining 0-1 fractions: ${remaining} (a re-run is a no-op).`)
  console.log('  Next: npx tsx --env-file=../../.env scripts/backfill-es-index.ts to resync Elasticsearch.')

  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async err => {
  console.error('backfill-risk-score-scale failed:', err)
  await prisma.$disconnect()
  process.exit(1)
})
