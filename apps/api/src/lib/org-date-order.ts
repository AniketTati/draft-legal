/**
 * docs/39 A11 — how an org writes dates with numbers: month first (US,
 * "03/04/2025" is 4 March) or day first (UK, EU, India: 3 April). Set in the
 * organization's settings (`dateOrder`); read wherever a date is typed or
 * extracted. Cached a minute per org, and dropped when the setting changes.
 */
import type { DateOrder } from '@clm/types'
import { prisma } from './prisma.js'

export const DATE_ORDERS: readonly DateOrder[] = ['MDY', 'DMY']

const TTL_MS = 60_000
const cache = new Map<string, { order: DateOrder; at: number }>()

export async function orgDateOrder(orgId: string): Promise<DateOrder> {
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.order
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } })
  const raw = (org?.settings as Record<string, unknown> | null)?.dateOrder
  const order: DateOrder = raw === 'DMY' ? 'DMY' : 'MDY'
  cache.set(orgId, { order, at: Date.now() })
  return order
}

export function clearOrgDateOrderCache(orgId: string): void {
  cache.delete(orgId)
}
