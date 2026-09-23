import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import axios from 'axios'
import { singleFlight } from '@/lib/single-flight'
import { tokenClaims } from '@/lib/token-claims'
import type { User } from '@clm/types'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean

  login: (email: string, password: string) => Promise<void>
  register: (data: { email: string; password: string; name: string; orgName: string }) => Promise<void>
  refresh: () => Promise<void>
  /**
   * Signs out. `{ local: true }` (a refresh that failed) clears only this
   * tab's copy: the server no longer knows its token, and the session it
   * does know may be another tab's.
   */
  logout: (opts?: { local?: boolean }) => void
  setUser: (user: User) => void
}

/**
 * X50 — whether an access token has time left: a minute of it, so a client
 * clock somewhat behind the server's doesn't take an expired token for valid.
 */
function stillValid(accessToken: string | null | undefined): boolean {
  return (tokenClaims(accessToken).exp ?? 0) * 1000 > Date.now() + 60_000
}

/**
 * X50 — tokens another tab stored after this tab's: the same user's, the
 * access token included, and issued later. Never another user's, and never
 * an older pair that a tab with a stale copy wrote back. localStorage may be
 * unavailable.
 */
function newerStoredTokens(held: string): { accessToken: string; refreshToken: string } | null {
  try {
    const state = JSON.parse(localStorage.getItem('clm-auth') ?? 'null')?.state
    const { accessToken, refreshToken } = state ?? {}
    if (typeof refreshToken !== 'string' || typeof accessToken !== 'string') return null
    const mine = tokenClaims(held)
    const stored = tokenClaims(refreshToken)
    const sameUser = !!mine.sub && stored.sub === mine.sub && tokenClaims(accessToken).sub === mine.sub
    // `iat` is whole seconds: a pair from the same second as ours is ours, or can't be ordered.
    return sameUser && (stored.iat ?? 0) > (mine.iat ?? Infinity) ? { accessToken, refreshToken } : null
  } catch {
    return null
  }
}

/**
 * X50 — the state to store: `next`, but with the tokens storage already holds
 * when they are the same user's and newer than the ones `next` carries.
 */
function keepNewerStoredTokens(storedRaw: string | null, next: string): string {
  try {
    const stored = JSON.parse(storedRaw ?? 'null')?.state
    const parsed = JSON.parse(next)
    const mine = parsed?.state
    if (typeof mine?.refreshToken !== 'string' || typeof stored?.refreshToken !== 'string' || typeof stored?.accessToken !== 'string') return next
    const was = tokenClaims(stored.refreshToken)
    const now = tokenClaims(mine.refreshToken)
    const sameUser = !!now.sub && was.sub === now.sub && tokenClaims(stored.accessToken).sub === now.sub
    if (!sameUser || !((was.iat ?? 0) > (now.iat ?? Infinity))) return next
    return JSON.stringify({ ...parsed, state: { ...mine, accessToken: stored.accessToken, refreshToken: stored.refreshToken } })
  } catch {
    return next
  }
}

/** X50 — what storage holds now, as written, and its refresh token; null if unreadable. */
function storedSession(): { raw: string; refreshToken: unknown } | null {
  try {
    const raw = localStorage.getItem('clm-auth')
    return raw ? { raw, refreshToken: JSON.parse(raw)?.state?.refreshToken } : null
  } catch {
    return null
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const { data } = await axios.post('/api/v1/auth/login', { email, password })
        set({
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          isAuthenticated: true,
        })
      },

      register: async (body) => {
        const { data } = await axios.post('/api/v1/auth/register', {
          ...body,
          orgName: body.orgName,
        })
        set({
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          isAuthenticated: true,
        })
      },

      // X48 — one refresh at a time. Every request that met an expired access
      // token refreshed with the same refresh token, and the server rotates it
      // on use: each refresh after the first was refused, and the app logged
      // the user out.
      // The shared refresh has a time limit, so a hung one can't hold every
      // later request, and it doesn't write one session's tokens over another's
      // if the user signed out (or someone else signed in) while it ran.
      // X50 — tabs share the tokens in localStorage, and the server keeps only
      // the newest refresh token: a tab that refreshed with a copy another tab
      // had already rotated was refused and signed out. A tab first takes the
      // newer tokens another tab stored — only ever the same user's — and when
      // a refresh is refused because another tab won a simultaneous one, it
      // looks briefly for the winner's tokens before giving up.
      refresh: singleFlight(async () => {
        const adopt = (t: { accessToken: string; refreshToken: string }) =>
          set({ accessToken: t.accessToken, refreshToken: t.refreshToken })
        const held = get().refreshToken
        if (!held) throw new Error('No refresh token')
        const newer = newerStoredTokens(held)
        if (newer) {
          adopt(newer)
          if (stillValid(newer.accessToken)) return
        }
        const refreshToken = get().refreshToken as string
        try {
          const { data } = await axios.post('/api/v1/auth/refresh', { refreshToken }, { timeout: 15_000 })
          if (get().refreshToken !== refreshToken) return
          set({ accessToken: data.accessToken, refreshToken: data.refreshToken })
        } catch (err) {
          if ((err as { response?: { status?: number } }).response?.status !== 401) throw err
          // About 2 s, looking once more after the last wait.
          for (let i = 0; ; i++) {
            // As above: a session that changed while this waited is left as it is.
            if (get().refreshToken !== refreshToken) return
            // The winner of a simultaneous refresh stored fresh tokens; an older
            // pair a stale tab wrote back is not it.
            const winner = newerStoredTokens(refreshToken)
            if (winner && stillValid(winner.accessToken)) { adopt(winner); return }
            if (i === 10) break
            await new Promise(r => setTimeout(r, 200))
          }
          throw err
        }
      }),

      logout: (opts) => {
        const { accessToken, refreshToken: held } = get()
        if ((accessToken || held) && !opts?.local) {
          // X50 — the refresh token too: after 15 idle minutes the access
          // token has expired, and the server couldn't tell whose session to end.
          axios.post('/api/v1/auth/logout', { refreshToken: held }, {
            headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          }).catch(() => {})
        }
        // X50 — a local sign-out clears this tab's session. If another tab has
        // stored a different one meanwhile, storage keeps it, or every reload
        // and new tab would be signed out too.
        const stored = opts?.local ? storedSession() : null
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
        if (stored && stored.refreshToken && stored.refreshToken !== held) {
          try { localStorage.setItem('clm-auth', stored.raw) } catch { /* storage unavailable */ }
        }
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'clm-auth',
      // X50 — a tab never writes its older tokens over the same user's newer
      // ones: any state change (a profile save) wrote a stale tab's whole pair
      // back, and the tabs that read storage next found only dead tokens.
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => localStorage.setItem(name, keepNewerStoredTokens(localStorage.getItem(name), value)),
        removeItem: (name) => localStorage.removeItem(name),
      })),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
