import type { ReactNode } from 'react'
import { useCanRequest } from '@/lib/permissions'

/**
 * Y3 — its children, for a user who may make `request`, by the permission the
 * server's route for it needs: `<Can request="POST /contracts/:id/share">`.
 */
export function Can({ request, children, fallback = null }: { request: string; children: ReactNode; fallback?: ReactNode }) {
  return useCanRequest(request) ? <>{children}</> : <>{fallback}</>
}
