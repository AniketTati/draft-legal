/**
 * Print the 10 most-recent AuditEvent rows for a given action (arg[0]) as
 * JSON on stdout. Used by scripts/archive/d36-verify.mjs to assert AGENT_TOOL_*
 * events were written.
 */
import { PrismaClient } from '@prisma/client'

const action = process.argv[2]
if (!action) { console.error('usage: _recent-audit.ts <AuditAction>'); process.exit(1) }

const p = new PrismaClient()
const rows = await p.auditEvent.findMany({
  where: { action },
  orderBy: { createdAt: 'desc' },
  take: 10,
  select: {
    id: true, action: true, resourceType: true, resourceId: true,
    metadata: true, createdAt: true, ipAddress: true,
  },
})
console.log(JSON.stringify(rows))
await p.$disconnect()
