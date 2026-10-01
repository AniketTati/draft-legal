/**
 * docs/39 A11 — how the org writes dates with numbers, from its settings:
 * month first (US) unless an admin chose day first. The editors read a typed
 * "03/04/2025" the same way the API will.
 */
import { useQuery } from '@tanstack/react-query'
import type { DateOrder } from '@clm/types'
import { api } from '@/lib/api'

export function useOrgDateOrder(): DateOrder {
  const { data } = useQuery<{ settings?: { dateOrder?: DateOrder } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
    staleTime: 60_000,
  })
  return data?.settings?.dateOrder === 'DMY' ? 'DMY' : 'MDY'
}
