/**
 * X34 — an append to an org's audit chain retried a serialization failure
 * five times, on a fixed backoff with no jitter. A burst of writers (parallel
 * chat tool calls each logging a PII redaction) collided again on every
 * retry, and the ones that ran out of attempts lost their event with a
 * console line: the chain still verified, but it was missing events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AuditAction } from '@clm/types'
import { createAuditEvent, verifyAuditChain } from './audit.js'
import { makeOrg, cleanupAll, prisma } from '../test-support/helpers.js'

let org: string

beforeAll(async () => {
  org = await makeOrg('Audit Burst Org')
})

afterAll(async () => {
  await cleanupAll()
})

describe('a burst of audit writes for one org', () => {
  it('lands every event, and the chain still verifies', async () => {
    const N = 16
    const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => createAuditEvent({
      orgId: org, action: AuditAction.PII_REDACTED, resourceType: 'request', resourceId: `burst-${i}`, metadata: { i },
    })))
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(0)
    expect(await prisma.auditEvent.count({ where: { orgId: org, resourceId: { startsWith: 'burst-' } } })).toBe(N)
    expect((await verifyAuditChain(org)).ok).toBe(true)
  }, 30_000)
})
