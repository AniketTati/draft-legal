/**
 * check-cross-org-links.ts — Y1 preflight, read-only: before the row-level
 * security migration reaches a database with older data, list every required
 * reference from one org's row to another org's.
 *
 * Under row-level security a query that loads such a reference fails (Prisma
 * finds no row for a required relation) instead of showing another org's
 * data. The repair migrations cleared the links earlier bugs stored, except
 * matter owners X25 had no creator to fall back on; the matter routes load
 * owners apart for that reason. Anything else this lists needs repairing
 * first.
 *
 * Usage:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/check-cross-org-links.ts
 * Exits 1 when it finds any that need repairing.
 */
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
/** References the app already loads apart, limited to the org (routes/matters.ts). */
const HANDLED = new Set(['Matter.owner'])
const models = Prisma.dmmf.datamodel.models
const byName = new Map(models.map(m => [m.name, m]))
type Model = (typeof models)[number]
type Field = Model['fields'][number]

const table = (m: Model) => m.dbName ?? m.name
const column = (m: Model, field: string) => m.fields.find(f => f.name === field)?.dbName ?? field
const hasOrg = (m: Model) => m.fields.some(f => f.name === 'orgId')
const requiredRelations = (m: Model) =>
  m.fields.filter((f): f is Field => f.kind === 'object' && !f.isList && f.isRequired && !!f.relationFromFields?.length)

/** SQL for the row's org: its own orgId, or its parent's (child tables). */
function orgOf(m: Model): { join: string; org: string } | null {
  if (hasOrg(m)) return { join: '', org: 'r."orgId"' }
  const via = requiredRelations(m).find(f => hasOrg(byName.get(f.type)!))
  if (!via) return null
  const parent = byName.get(via.type)!
  return {
    join: `JOIN "${table(parent)}" p ON p."${column(parent, via.relationToFields![0])}" = r."${column(m, via.relationFromFields![0])}"`,
    org: 'p."orgId"',
  }
}

async function main() {
  let found = 0
  let checked = 0
  for (const m of models) {
    const own = orgOf(m)
    if (!own) continue
    for (const f of requiredRelations(m)) {
      const target = byName.get(f.type)!
      if (!hasOrg(target)) continue
      checked++
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
        SELECT count(*)::int AS n FROM "${table(m)}" r ${own.join}
        JOIN "${table(target)}" t ON t."${column(target, f.relationToFields![0])}" = r."${column(m, f.relationFromFields![0])}"
        WHERE t."orgId" IS NOT NULL AND t."orgId" IS DISTINCT FROM ${own.org}`)
      if (n === 0) continue
      const name = `${m.name}.${f.name}`
      if (HANDLED.has(name)) {
        console.log(`${name} → ${target.name}: ${n} row(s) name another org's ${target.name}; the app hides them`)
      } else {
        found += n
        console.log(`${name} → ${target.name}: ${n} row(s) point at another org's ${target.name}: repair before migrating`)
      }
    }
  }
  console.log(`${checked} required references checked; ${found} to repair.`)
  if (found > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
