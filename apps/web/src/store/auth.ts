import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'
import { singleFlight } from '@/lib/single-flight'
import type { User } from '@clm/types'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean

  login: (email: string, password: string) => Promise<void>
  register: (data: { email: string; password: string; name: string; orgName: string }) => Promise<void>
  refresh: () => Promise<void>
  logout: () => void
  setUser: (user: User) => void
}

/** X50 — a JWT's claims, read without verifying it: only to compare sessions. */
function tokenClaims(token: string | null | undefined): { sub?: string; exp?: number } {
  try {
    const part = token?.split('.')[1]
    return part ? JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) : {}
  } catch {
    return {}
  }
}

/** X50 — whether an access token has at least a few seconds left. */
function stillValid(accessToken: string | null | undefined): boolean {
  return (tokenClaims(accessToken).exp ?? 0) * 1000 > Date.now() + 5_000
}

/**
 * X50 — tokens another tab stored for the same user, when they aren't the
 * ones this tab holds. Never another user's; localStorage may be unavailable.
 */
function newerStoredTokens(held: string): { accessToken: string; refreshToken: string } | null {
  try {
    const state = JSON.parse(localStorage.getItem('clm-auth') ?? 'null')?.state
    const refreshToken = state?.refreshToken
    if (typeof refreshToken !== 'string' || typeof state?.accessToken !== 'string' || refreshToken === held) return null
    const sub = tokenClaims(refreshToken).sub
    return sub && sub === tokenClaims(held).sub ? { accessToken: state.accessToken, refreshToken } : null
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
          for (let i = 0; i < 10; i++) {
            const winner = newerStoredTokens(refreshToken)
            if (winner) { adopt(winner); return }
            await new Promise(r => setTimeout(r, 200))
          }
          throw err
        }
      }),

      logout: () => {
        const { accessToken } = get()
        if (accessToken) {
          axios.post('/api/v1/auth/logout', {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).catch(() => {})
        }
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'clm-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
