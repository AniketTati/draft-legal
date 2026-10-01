/**
 * docs/41 Part 20 — integration health for the admin page: per connection,
 * its state, the last 24 hours of syncs, the last failure (with what the
 * retry button needs) and the conflicts waiting for someone.
 */
import { prisma } from '../prisma.js'

export async function integrationHealth(orgId: string) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const connections = await prisma.integrationConnection.findMany({
    where: { orgId, status: { not: 'disconnected' } },
    select: { provider: true, status: true, externalOrgId: true, lastSyncAt: true, lastError: true, connectedAt: true },
  })
  return Promise.all(connections.map(async c => {
    const [counts, lastFailure, openConflicts] = await Promise.all([
      prisma.integrationSyncLog.groupBy({
        by: ['status'], where: { orgId, provider: c.provider, at: { gte: since24h } }, _count: { _all: true },
      }),
      prisma.integrationSyncLog.findFirst({
        where: { orgId, provider: c.provider, status: 'failed' },
        orderBy: { at: 'desc' },
        select: { id: true, object: true, contractId: true, requestId: true, error: true, attempt: true, at: true },
      }),
      prisma.integrationConflict.count({ where: { orgId, provider: c.provider, status: 'open' } }),
    ])
    const n = (s: string) => counts.find(r => r.status === s)?._count._all ?? 0
    const failed24h = n('failed')
    // Failing: the connection itself is broken, or every sync of the last day
    // failed. Degraded: some failed, or there are changes waiting on someone.
    const health =
      c.status === 'error' || (failed24h > 0 && n('success') === 0) ? 'failing'
      : failed24h > 0 || openConflicts > 0 ? 'degraded'
      : c.status === 'pending' ? 'disabled'
      : 'healthy'
    return {
      provider: c.provider,
      status: c.status,
      health,
      externalOrgId: c.externalOrgId,
      connectedAt: c.connectedAt,
      lastSyncAt: c.lastSyncAt,
      lastError: c.lastError,
      syncs24h: { ok: n('success'), failed: failed24h, skipped: n('skipped'), conflicts: n('conflict') },
      openConflicts,
      lastFailure,
    }
  }))
}
