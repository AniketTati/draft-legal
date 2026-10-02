/**
 * After applying migrations: prove row-level security still hides every
 * tenant's rows from a session with no matching tenant. Reads only, inside a
 * transaction it rolls back. Prints each table's count; all must be 0.
 *
 *   DATABASE_URL=… pnpm exec tsx scripts/verify-tenant-isolation.ts
 */
import { PrismaClient } from '@prisma/client'

// The tenant tables added by docs/39 and docs/41, plus contracts as the control.
const TABLES = [
  'contracts', 'review_findings', 'analysis_runs', 'playbooks', 'clause_families',
  'contract_working_copies', 'ai_suggestion_events', 'integration_connections',
  'contract_facts', 'renewal_decisions',
]

const prisma = new PrismaClient()

async function main() {
  const counts = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`select set_config('role', 'clm_tenant_access', true)`)
    await tx.$executeRawUnsafe(`select set_config('app.tenant_id', 'org-that-does-not-exist', true)`)
    const out: Array<[string, number | string]> = []
    for (const t of TABLES) {
      const exists = await tx.$queryRawUnsafe<Array<{ r: string | null }>>(`select to_regclass('public.${t}')::text as r`)
      if (!exists[0]?.r) { out.push([t, 'no such table']); continue }
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`select count(*) as n from "${t}"`)
      out.push([t, Number(rows[0].n)])
    }
    // Read-only, but never leave anything behind.
    throw Object.assign(new Error('rollback'), { counts: out })
    // Twenty round trips to a remote database outlast Prisma's 5 s default.
  }, { timeout: 60_000, maxWait: 15_000 }).catch(err => {
    if (err?.message === 'rollback') return err.counts as Array<[string, number | string]>
    throw err
  })

  let leaked = false
  for (const [t, n] of counts) {
    console.log(`${t.padEnd(26)} ${n}`)
    if (typeof n === 'number' && n > 0) leaked = true
  }
  console.log(leaked ? 'FAIL: rows visible to a tenant that does not exist' : 'OK: no rows visible without a matching tenant')
  if (leaked) process.exitCode = 1
}

main()
  .catch(err => { console.error(err.message ?? err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
