/**
 * backfill-unanalysed.ts — docs/41 P0.1: contracts marked analysed that never were.
 *
 * Before the single analysis trigger (src/lib/analysis-trigger.ts), a draft
 * made from a request, a draft added as a version and a blank contract were
 * written with `analysisStatus: 'DONE'` and nothing read. This finds the ones
 * with a version but no clauses on it, still DONE, and queues their analysis
 * through the same trigger every new version now goes through.
 *
 * Rate-limited: at most --per-org contracts per org per run, one every
 * --every-ms, and an org whose AI budget for the day is used up is skipped
 * (its contracts are found again on the next run). Dry run unless --apply.
 * Not to be run against production without the owner's go-ahead: each
 * contract queued is a paid model run.
 *
 * Usage (from apps/api):
 *   npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts               # list what would be queued
 *   npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts --apply       # queue them
 *   npx tsx --env-file=../../.env scripts/backfill-unanalysed.ts --apply --org=<id> --per-org=10 --every-ms=5000
 */
import { prisma } from '../src/lib/prisma.js'
import { onVersionCreated } from '../src/lib/analysis-trigger.js'
import { assertCostCapNotExceeded, CostCapExceededError } from '../src/lib/costCap.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const apply = args.includes('--apply')
const orgId = flag('org')
const perOrg = Number(flag('per-org') ?? 20)
const everyMs = Number(flag('every-ms') ?? 3000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const candidates = await prisma.contract.findMany({
    where: {
      deletedAt: null,
      analysisStatus: 'DONE',
      ...(orgId ? { orgId } : {}),
      versions: { some: {} },
    },
    select: { id: true, orgId: true, title: true, currentVersionId: true },
    orderBy: { updatedAt: 'desc' },
  })

  // The version each stands on (the current one, else the newest), and
  // whether it has any clauses.
  const todo: Array<{ id: string; orgId: string; title: string; versionId: string }> = []
  for (const c of candidates) {
    const version = c.currentVersionId
      ? await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { id: true } })
      : await prisma.contractVersion.findFirst({ where: { contractId: c.id }, orderBy: { versionNumber: 'desc' }, select: { id: true } })
    if (!version) continue
    const clauses = await prisma.contractClause.count({ where: { versionId: version.id, isSubChunk: false } })
    if (clauses === 0) todo.push({ id: c.id, orgId: c.orgId, title: c.title, versionId: version.id })
  }

  const byOrg = new Map<string, typeof todo>()
  for (const t of todo) byOrg.set(t.orgId, [...(byOrg.get(t.orgId) ?? []), t])
  console.log(`${todo.length} contracts marked analysed with no clauses, in ${byOrg.size} orgs${apply ? '' : ' (dry run — pass --apply to queue)'}`)

  let queued = 0
  for (const [org, list] of byOrg) {
    const batch = list.slice(0, perOrg)
    console.log(`org ${org}: ${list.length} found, ${batch.length} this run`)
    for (const t of batch) {
      if (!apply) { console.log(`  would queue ${t.id} — ${t.title}`); continue }
      try {
        await assertCostCapNotExceeded(org)
      } catch (err) {
        if (err instanceof CostCapExceededError) { console.log(`  org ${org}: today's AI budget is used up — the rest wait for the next run`); break }
        throw err
      }
      const outcome = await onVersionCreated(t.id, t.versionId, 'backfill')
      console.log(`  ${t.id} — ${t.title}: ${outcome}`)
      queued++
      await sleep(everyMs)
    }
  }
  console.log(apply ? `Queued ${queued}.` : 'Nothing queued (dry run).')
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => {
    await prisma.$disconnect()
    // The queue module holds a Redis connection open.
    const { redis } = await import('../src/lib/redis.js')
    redis.disconnect()
  })
