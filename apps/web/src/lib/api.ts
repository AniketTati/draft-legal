import axios, { AxiosError } from 'axios'
import { useAuthStore } from '@/store/auth'
import { tokenClaims } from '@/lib/token-claims'
import { heldPermissions, knownRoles, missingPermission, refusalMessage } from '@/lib/can-request'

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

/** Whether an access token hasn't expired yet (by this clock). */
const live = (token: string) => (tokenClaims(token).exp ?? 0) * 1000 > Date.now()

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Y3 — a write the user has no permission for is refused here, with one
// message, rather than sent for a 403 that each screen showed its own way.
// Judged by the permission the server's route needs (lib/can-request.ts),
// once the user's roles are known; the server decides the rest, including
// which records an own-scope user may change.
api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toUpperCase()
  if (!WRITES.has(method)) return config
  const held = heldPermissions((useAuthStore.getState().user?.roles ?? []) as string[], knownRoles())
  const missing = held === null ? null : missingPermission(held, method, config.url ?? '')
  if (!missing) return config
  const detail = refusalMessage(missing)
  const response = { data: { detail, status: 403 }, status: 403, statusText: 'Forbidden', headers: {}, config }
  return Promise.reject(new AxiosError(detail, 'ERR_PERMISSION', config, null, response as never))
})

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-refresh on 401.
//
// B.5.15 carve-out: the public portal / signer pages live at /portal/:t
// and /sign/:t — their data endpoints under /api/v1/portal/:t return 401
// for bad or expired tokens and we must NOT redirect the user to /login
// in that case (they don't have an account, and the portal page itself
// wants the error so it can render its "Link unavailable" state).
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    const url = (original?.url ?? '').toString()
    const isPortalRequest = url.startsWith('/portal') || url.includes('/api/v1/portal')
    if (error.response?.status === 401 && !original._retry && !isPortalRequest) {
      original._retry = true
      // X50 — a request is sent again only as the user who made it: the
      // session can change while it is in flight (a sign-out, someone else
      // signing in). And it needs a refresh only if nothing has replaced its
      // token with a live one meanwhile, as another request's refresh does:
      // every refresh rotates the session other tabs hold.
      const sentWith = String(original.headers.Authorization ?? '').replace(/^Bearer /, '')
      const sentAs = tokenClaims(sentWith).sub
      const current = useAuthStore.getState().accessToken
      if (sentAs && current && tokenClaims(current).sub !== sentAs) return Promise.reject(error)
      try {
        if (!current || current === sentWith || !live(current)) await useAuthStore.getState().refresh()
        const token = useAuthStore.getState().accessToken
        if (!token || (sentAs && tokenClaims(token).sub !== sentAs)) return Promise.reject(error)
        original.headers.Authorization = `Bearer ${token}`
        return api(original)
      } catch (refreshError) {
        // X50 — only a refresh the server refused (or no session to refresh)
        // signs this tab out; after a network error or a timeout the session
        // may be fine, and only this request fails.
        const refused = (refreshError as { response?: { status?: number } })?.response?.status === 401
          || !(refreshError as { isAxiosError?: boolean })?.isAxiosError
        if (!refused) return Promise.reject(error)
        // X50 — this tab's copy only: a refresh that failed can't end the
        // session other tabs hold.
        useAuthStore.getState().logout({ local: true })
        // B.6.20 — preserve the page the user was on so we can restore
        // it after a successful re-login. Skip on /login itself
        // (avoids ?next=/login weirdness) and on the portal routes we
        // already excluded above.
        const pathname = window.location.pathname + window.location.search
        const isAuthPage =
          window.location.pathname === '/login' ||
          window.location.pathname === '/register'
        const next = !isAuthPage && pathname.length > 1
          ? `?next=${encodeURIComponent(pathname)}`
          : ''
        window.location.href = `/login${next}`
      }
    }
    return Promise.reject(error)
  }
)

/**
 * docs/41 P0.7 — the message a failed request should show: the server's own
 * words (`detail`, else `error`, else `message`), else a plain sentence.
 */
export function apiErrorMessage(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown; error?: unknown; message?: unknown } } })?.response
  const said = [res?.data?.detail, res?.data?.error, res?.data?.message].find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (said) return said
  if (!res) return 'The server could not be reached. Check your connection and try again.'
  if ((res.status ?? 0) >= 500) return 'Something went wrong on our side. Try again in a moment.'
  return 'That didn’t work. Try again.'
}

/**
 * docs/41 P0.7 — whether a failed mutation is left for the global error toast:
 * one whose screen shows nothing of it. A mutation that handles its own
 * failure (an onError, or meta.errorHandled when it renders the error where
 * it happened) is left alone, and so is a refusal the client made itself for
 * a missing permission (already said where the action was offered).
 */
export function shouldToastMutationError(err: unknown, mutation: { options: { onError?: unknown; meta?: Record<string, unknown> } }): boolean {
  if (mutation.options.onError) return false
  if (mutation.options.meta?.errorHandled) return false
  if ((err as { code?: string })?.code === 'ERR_CANCELED') return false
  return true
}
