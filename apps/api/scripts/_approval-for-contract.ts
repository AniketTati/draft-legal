/**
 * Dump the most-recent ApprovalInstance for a given contractId. Used by
 * scripts/archive/d56-verify.mjs (top-level await limits in `tsx -e`).
 */
import { PrismaClient } from '@prisma/client'

const contractId = process.argv[2]
if (!contractId) { console.error('usage: _approval-for-contract.ts <contractId>'); process.exit(1) }

const p = new PrismaClient()
const inst = await p.approvalInstance.findFirst({
  where: { contractId },
  orderBy: { createdAt: 'desc' },
  include: { steps: { select: { id: true, status: true, stepName: true } } },
})
console.log(JSON.stringify(inst))
await p.$disconnect()
