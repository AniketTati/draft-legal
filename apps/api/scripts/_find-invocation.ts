/**
 * Dump the most-recent SkillInvocation row for a given threadId. Used by
 * scripts/archive/d41-verify.mjs (top-level await isn't available via `tsx -e`).
 */
import { PrismaClient } from '@prisma/client'

const threadId = process.argv[2]
if (!threadId) { console.error('usage: _find-invocation.ts <threadId>'); process.exit(1) }

const p = new PrismaClient()
const row = await p.skillInvocation.findFirst({
  where: { threadId },
  orderBy: { createdAt: 'desc' },
  include: { skill: { select: { slug: true, version: true } } },
})
console.log(JSON.stringify(row))
await p.$disconnect()
