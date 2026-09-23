import axios from 'axios'
import { useAuthStore } from '@/store/auth'
import { tokenClaims } from '@/lib/token-claims'

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

/** Whether an access token hasn't expired yet (by this clock). */
const live = (token: string) => (tokenClaims(token).exp ?? 0) * 1000 > Date.now()

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
